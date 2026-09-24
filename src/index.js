/**
 * dsh-hypatia-auto-memory — event-driven Hypatia memory for DSH.
 *
 * One host plugin whose collect fiber owns the durable core (state domain,
 * queue, hypatia client, writer, collector); optional child fibers attach the
 * rest, so a deployment missing `llm` still logs conversations and a
 * deployment missing `skills` still remembers:
 *
 *   collect  (inject sessions, storageDomain, subprocess, settings)
 *     ├─ consolidate (inject llm, sessions)   — span summaries, cascade, work units
 *     ├─ recall      (inject agents)          — rules/taboos preload at session start
 *     ├─ housekeeping (inject sessionPersistence) — prune progress of vanished sessions
 *     ├─ auto-approve (inject approval, tools) — the agent's own bash `hypatia` calls
 *     ├─ skills      (inject skills)          — hypatia-memory, hypatia, hypatia-dream
 *     └─ shelf-inventory (inject settings)    — `hypatia list` for the settings card
 *
 * The last two fibers are here because this plugin REPLACES `dsh-hypatia`:
 * writing memory by asking the model to do it did not happen in practice, and
 * the parts of that plugin still worth having — approving the agent's hypatia
 * calls and shipping the CLI skills — only serve the retrieval half of this
 * one. Installing both is a misconfiguration; see README.
 *
 * @module dsh-hypatia-auto-memory
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { absolutizeDates, blocksToText, eventDate, redactSecrets } from './content-policy.js'
import { INVENTORY_NAMESPACE, InventorySchema, installConfig } from './config.js'
import { openState } from './state.js'
import { EMPTY_PROGRESS, advanceProgress } from './progress.js'
import { createStatus } from './status.js'
import { createHypatiaClient } from './hypatia-client.js'
import { createWriter } from './writer.js'
import { TaskDeferredError, createQueue } from './queue.js'
import { countLoggableMessages, createCollector, formatSpan } from './collector.js'
import { createCascade } from './cascade.js'
import { createConsolidator, PLUGIN_NAME } from './consolidator.js'
import { openModelLog } from './model-log.js'
import { buildStatus } from './memory-status.js'
import { createMemoryApi } from './memory-api.js'
import { createRecall } from './recall.js'
import { createPersistedSessions } from './persisted-session.js'
import { createAutoApprove } from './auto-approve.js'
import { registerSkills } from './skills.js'
import { backfillConsolidation, normalizeTaskProjects, pruneVanishedSessions, reconcileProgress } from './housekeeping.js'
import { publishShelfInventory, shelfTable } from './shelf.js'

export const name = 'dsh-hypatia-auto-memory'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_SKILLS_DIR = join(PACKAGE_ROOT, 'skills')

/* -------------------------------------------------------------------------- */
/* Composition                                                                */
/* -------------------------------------------------------------------------- */

export function apply(ctx, config = {}) {
  ctx.plugin({
    name: `${name}/collect`,
    inject: ['sessions', 'storageDomain', 'subprocess', 'settings'],
    apply: (collectCtx) => applyCollect(collectCtx, config),
  })
}

function applyCollect(ctx, cordisConfig) {
  const status = createStatus(ctx, name)
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
  }, `${name}: dispose flag`)

  void start().catch((error) => {
    status.error('startup failed; plugin will not collect until the profile reloads', error)
  })

  async function start() {
    const configHandle = installConfig(ctx)
    if (configHandle.get().enabled === false) {
      status.info('disabled via hypatia-auto-memory.enabled=false')
      return
    }

    const openedState = await openState(ctx)
    if (disposed) {
      await openedState.domain.close().catch(() => {})
      return
    }

    // Fixed for this run; see shelf.js. Every table read below goes through a
    // view of this shelf's rows, so a switch never carries one shelf's
    // watermarks or queued work into another.
    const shelf = configHandle.get().shelf
    const state = {
      progress: shelfTable(openedState.progress, shelf),
      tasks: shelfTable(openedState.tasks, shelf),
    }
    // Which model a background attempt ran on is otherwise unknowable from
    // outside the process: the cursor that picks it is process-local, the host
    // logger scrolls away, and the usage ledger cannot see plugin calls. Kept in
    // its own domain so a diagnostics row can never reject the open of the
    // watermarks (see model-log.js). Not shelf-scoped: the route list is config,
    // and the question is about this process, not this shelf.
    const openedModelLog = await openModelLog(ctx, { status })
    if (disposed) {
      // Same race as the state domain above: if the fiber went away while this
      // was opening, its disposer may never run, so close the handle here.
      await openedModelLog.domain?.close().catch(() => {})
      return
    }
    const modelLog = openedModelLog.modelLog
    let announcedShelf = shelf
    configHandle.onChange((value) => {
      if (value.shelf === announcedShelf) return
      announcedShelf = value.shelf
      if (value.shelf !== shelf) {
        status.info(`shelf changed to "${value.shelf}"; still writing to "${shelf}" until the profile reloads`)
      }
    })

    const queue = createQueue({
      tasks: state.tasks,
      getConfig: () => configHandle.get().queue,
      status,
    })

    /**
     * Wrap a consolidation-side executor so its settle drops that session's
     * cached content. The memory API serves summaries and work units out of a
     * cache (they cost hypatia round trips), and consolidation and cascade are
     * exactly what change them — invalidating here is what makes the tab show
     * the new summary without waiting for the cache's own expiry. The API is
     * mounted by a child fiber below, so it is reached through `shared`,
     * late-bound; `finally` covers a failed run too, since it may have written
     * part of its output before failing.
     */
    const invalidatingContent = (executor) => async (task) => {
      try {
        return await executor(task)
      } finally {
        shared.memoryApi?.invalidate(task.sessionId)
      }
    }
    const cli = createHypatiaClient(ctx, {
      get binaries() {
        return configHandle.get().binaries
      },
      get transport() {
        return configHandle.get().transport
      },
      shelf,
    }, { status })
    // In-flight tasks drain (up to the queue's deadline) before the process
    // they write through is closed.
    ctx.effect(() => () => {
      void queue.dispose().finally(() => cli.dispose())
    }, `${name}: dispose queue and hypatia connection`)
    // The configured transport; a binary without `mcp` is only found out, and
    // warned about, at the first call.
    status.info(`writing to shelf "${shelf}" (transport: ${configHandle.get().transport})`)

    // Before the collector can queue anything and before any executor can run
    // a task: see housekeeping.js.
    await normalizeTaskProjects({ tasks: state.tasks, status })
    if (disposed) return

    // What the settings card offers as choices. Also the one place a missing
    // shelf is noticed before the first write fails on it.
    const inventory = publishShelfInventory({
      ctx,
      cli,
      status,
      namespace: INVENTORY_NAMESPACE,
      schema: InventorySchema,
      label: name,
    })
    configHandle.onChange(() => { void inventory.refresh() })
    void inventory.refresh().then(({ shelves, error }) => {
      if (error !== '') return
      const found = shelves.find((entry) => entry.name === shelf)
      if (found === undefined) status.warn(`shelf "${shelf}" is not registered with hypatia; every write will fail until it is (hypatia connect <dir> --name ${shelf})`)
      else if (!found.connected) status.warn(`shelf "${shelf}" is registered but not connected; writes will fail until it is`)
    })
    // Late-bound handles to the optional child fibers. Adjudication needs a
    // model route, which only the consolidate fiber has — without it the writer
    // stores a unit with no relationship, which is the correct degradation,
    // never a guessed one. The memory API is late-bound for the same reason: it
    // needs `webServer`, and a headless composition has none.
    const shared = { consolidator: undefined, memoryApi: undefined }

    const writer = createWriter(cli, {
      status,
      adjudicate: (unit, candidates) => shared.consolidator === undefined
        ? Promise.resolve(undefined)
        : shared.consolidator.adjudicate(unit, candidates),
    })

    const collector = createCollector({
      ctx,
      queue,
      progress: state.progress,
      getConfig: configHandle.get,
      status,
      onTurnEnd: (sessionId, turn, triggerState) => shared.consolidator === undefined
        ? Promise.resolve({ resetTokens: false, advanceCheckpoint: false })
        : shared.consolidator.onTurnEnd(sessionId, turn, triggerState),
      onSessionEnd: (sessionId, session) => shared.consolidator === undefined
        ? Promise.resolve(false)
        : shared.consolidator.onSessionEnd(sessionId, session),
    })

    // Live store first, storage second. `session/created` — the signal that
    // wakes a deferred task — fires only where an agent runs, so a finished
    // session (and every subagent session) may never emit it again; storage
    // supplies the same events without publishing anything. Late-bound: a
    // composition without `sessionPersistence` keeps today's behavior, which is
    // to wait. See persisted-session.js.
    let loadPersisted = async () => undefined
    const resolveSession = async (sessionId) => collector.sessionFor(sessionId) ?? await loadPersisted(sessionId)

    ctx.plugin({
      name: `${name}/persisted-sessions`,
      inject: ['sessionPersistence'],
      apply: (c) => {
        const store = createPersistedSessions({ persistence: c.sessionPersistence, status })
        loadPersisted = store.get
        c.effect(() => () => {
          loadPersisted = async () => undefined
          store.clear()
        }, `${name}: release persisted sessions`)
      },
    })

    /** Log executor: re-read the span, format per protocol, write idempotently. */
    queue.registerExecutor('log-message', async (task) => {
      // Resolved through the collector, not `ctx.sessions`: a session closing
      // down has already left the store while its final span is still queued.
      const session = await resolveSession(task.sessionId)
      if (session === undefined) {
        throw new TaskDeferredError(`session ${task.sessionId} is not loaded; deferred until it is`)
      }
      const config = configHandle.get()
      const events = session.snapshotEvents(task.fromSeq, task.toSeq)
      // Entry names use a dense message ordinal, recomputed from the log prefix
      // rather than carried in the watermark: the log is immutable, so counting
      // is replay-stable by construction and cannot drift out of sync.
      const inherited = session.inheritedEventCount ?? 0
      const baseIndex = countLoggableMessages(session.snapshotEvents(inherited, task.fromSeq))
      const formatted = formatSpan(events, {
        now: new Date(),
        maxAssistantChars: config.collector.maxAssistantChars,
        maxUserChars: config.collector.maxUserChars,
        toolLedger: config.collector.toolLedger,
        baseIndex,
        before: task.fromSeq > 0 ? session.snapshotEvents(task.fromSeq - 1, task.fromSeq)[0] : undefined,
      })
      for (const item of formatted) {
        await writer.writeMessage({
          sessionId: task.sessionId,
          index: item.index,
          markdown: item.markdown,
          project: task.project,
        })
      }
      const linkTo = baseIndex + formatted.length
      // `belongTo` edges only exist once the session node does. Most sessions
      // never produce one (it needs a host-supplied summary), so this stays a
      // watermark check rather than a lookup per span.
      const before = state.progress.get(task.sessionId) ?? EMPTY_PROGRESS
      if (before.hasSessionNode === 1 && linkTo > before.lastBelongToIndex) {
        await writer.writeSessionNode({
          sessionId: task.sessionId,
          markdown: '',
          project: task.project,
          linkFrom: before.lastBelongToIndex,
          linkTo,
        })
      }
      // Awaited: the task must not be reported done — and deleted — before the
      // watermark that makes its range unnecessary is durable.
      await advanceProgress(state.progress, task.sessionId, (current) => ({
        lastLoggedSeq: Math.max(current.lastLoggedSeq, task.toSeq),
        lastBelongToIndex: current.hasSessionNode === 1
          ? Math.max(current.lastBelongToIndex, linkTo)
          : current.lastBelongToIndex,
      }))
    })

    /**
     * Session-node executor: build `session-<id>` from the host summary at this
     * seq, then link every message logged so far to it.
     */
    queue.registerExecutor('session-node', async (task) => {
      const session = await resolveSession(task.sessionId)
      if (session === undefined) {
        throw new TaskDeferredError(`session ${task.sessionId} is not loaded; deferred until it is`)
      }
      const [event] = session.snapshotEvents(task.fromSeq, task.toSeq)
      if (event === undefined) return
      const summary = event.type === 'session/title'
        ? String(event.data?.title ?? '')
        : blocksToText(event.data?.summary ?? [])
      const markdown = absolutizeDates(redactSecrets(summary), eventDate(event, new Date())).trim()
      // The protocol forbids inventing a session summary: no text, no node.
      if (markdown === '') return

      const inherited = session.inheritedEventCount ?? 0
      const current = state.progress.get(task.sessionId) ?? EMPTY_PROGRESS
      const linkTo = countLoggableMessages(session.snapshotEvents(inherited, current.lastLoggedSeq))
      await writer.writeSessionNode({
        sessionId: task.sessionId,
        markdown,
        project: task.project,
        linkFrom: current.lastBelongToIndex,
        linkTo,
      })
      await advanceProgress(state.progress, task.sessionId, (progressRow) => ({
        hasSessionNode: 1,
        lastBelongToIndex: Math.max(progressRow.lastBelongToIndex, linkTo),
      }))
    })

    // Failed log-message records carry nothing the watermark does not: the range
    // was never marked logged, so the session's next flush covers it again.
    // Pruned at startup so the error message survives the run that produced it.
    const pruned = await queue.pruneFailed(['log-message'])
    if (pruned > 0) status.info(`pruned ${pruned} failed log-message task(s); the watermarks re-derive their ranges`)

    // Progress rows whose session left nothing in the shelf (a wiped or replaced
    // shelf) are reset BEFORE backfill, so a live session among them is logged
    // from the start in this very run. See housekeeping.js for why it only acts
    // on positive evidence.
    if (configHandle.get().housekeeping?.reconcileOnStartup !== false) {
      await reconcileProgress({ progress: state.progress, cli, status })
    }

    await collector.backfillLiveSessions()
    status.info('collector running (backfill complete)')

    // The conversation tab's read side. Optional: it needs `webServer`, so a
    // headless or TUI composition simply has no Memory tab and nothing else
    // changes. The route authenticates itself — see memory-api.js.
    ctx.plugin({
      name: `${name}/memory-api`,
      inject: ['webServer'],
      apply: (c) => {
        const api = createMemoryApi({
          cli,
          read: (sessionId) => buildStatus({
            progressEntries: state.progress.entries(),
            taskEntries: state.tasks.entries(),
            sessionId,
          }),
          status,
        })
        c.effect(() => {
          const unregister = c.webServer.register(api.route)
          shared.memoryApi = api
          return () => {
            unregister()
            // Only if this fiber's own API is still the live one: a reload may
            // have mounted a successor before this disposer runs.
            if (shared.memoryApi === api) shared.memoryApi = undefined
          }
        }, `${name}: memory API route`)
      },
    })

    // Both passes need `sessionPersistence` for the full listing — live sessions
    // alone would make every unloaded session look gone, and carry the cwd a
    // scope is resolved from. A child fiber, registered only after the reconcile
    // pass above so the two never act on one row at once. Each pass keeps its
    // own switch: turning pruning off must not also stop consolidation backfill.
    const housekeeping = configHandle.get().housekeeping ?? {}
    if (housekeeping.pruneVanishedSessions !== false || housekeeping.backfillConsolidation !== false) {
      ctx.plugin({
        name: `${name}/housekeeping`,
        inject: ['sessionPersistence'],
        apply: (c) => {
          void (async () => {
            const headers = await c.sessionPersistence.list()
            const cwdById = new Map()
            for (const header of headers) {
              const id = String(header?.id ?? '')
              if (id !== '' && header?.cwd !== undefined) cwdById.set(id, String(header.cwd))
            }
            const knownSessionIds = new Set(headers.map((header) => String(header?.id ?? '')).filter((id) => id !== ''))
            if (housekeeping.pruneVanishedSessions !== false) {
              await pruneVanishedSessions({
                progress: state.progress,
                queue,
                knownSessionIds,
                isLive: (id) => ctx.sessions.get(id) !== undefined,
                status,
              })
            }
            // After pruning, so a vanished session's tail is never queued.
            if (housekeeping.backfillConsolidation !== false) {
              await backfillConsolidation({
                progress: state.progress,
                queue,
                cwdFor: (id) => cwdById.get(id),
                projectForCwd: collector.projectForCwd,
                minNewTokens: configHandle.get().consolidation.minNewTokens,
                status,
              })
            }
          })().catch((error) => {
            status.warn(`startup housekeeping skipped: ${String(error)}`)
          })
        },
      })
    }

    // Optional child fibers — each waits only for the services it needs.
    ctx.plugin({
      name: `${name}/consolidate`,
      inject: ['llm', 'sessions'],
      apply: (c) => {
        const consolidator = createConsolidator({
          queue,
          progress: state.progress,
          // Same resolver as the log executor: end-of-session consolidation runs
          // against a session the store has already released — and a startup
          // backfill runs against one it may never publish again.
          sessions: { get: resolveSession },
          llm: c.llm,
          cli,
          writer,
          getConfig: configHandle.get,
          status,
          modelLog,
          projectFor: collector.projectFor,
        })
        queue.registerExecutor('consolidate', invalidatingContent(consolidator.execute))
        // Shares the consolidator's route cursor so every model attempt — span
        // summary, adjudication, archive — rotates through the selected routes
        // together rather than each keeping its own place in the rotation.
        const cascade = createCascade({
          cli,
          llm: c.llm,
          selectRoute: consolidator.selectRoute,
          getConfig: configHandle.get,
          status,
          modelLog,
        })
        queue.registerExecutor('cascade', invalidatingContent(cascade.execute))
        shared.consolidator = consolidator
      },
    })

    ctx.plugin({
      name: `${name}/recall`,
      inject: ['agents'],
      apply: (c) => {
        createRecall({ ctx: c, cli, shelf, getConfig: configHandle.get, status, projectFor: collector.projectFor })
      },
    })

    // Auto-approve is for the agent's OWN bash `hypatia` calls — retrieval,
    // explicit remember/forget. This plugin's writes never pass through it:
    // they go over its own `hypatia mcp` connection (or argv arrays on the
    // CLI fallback), with no shell, no tool call and no approval in the path.
    if (configHandle.get().autoApprove !== false) {
      ctx.plugin({
        name: `${name}/auto-approve`,
        inject: ['approval', 'tools'],
        apply: (c) => {
          createAutoApprove(c, { getBinaries: () => configHandle.get().binaries, status })
        },
      })
    }

    if (cordisConfig.skills !== false) {
      ctx.plugin({
        name: `${name}/skills`,
        inject: ['skills'],
        apply: (c) => {
          void registerSkills(c, cordisConfig.skillsDir ?? DEFAULT_SKILLS_DIR, status, PLUGIN_NAME)
            .catch((error) => status.warn(`skill registration failed: ${String(error)}`))
        },
      })
    }
  }
}
