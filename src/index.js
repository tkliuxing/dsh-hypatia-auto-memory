/**
 * dsh-hypatia-auto-memory — event-driven Hypatia memory for DSH.
 *
 * One host plugin whose collect fiber owns the durable core (state domain,
 * queue, CLI, writer, collector); three optional child fibers attach the
 * model-dependent capabilities so a deployment missing `llm` still logs
 * conversations, and a deployment missing `skills` still remembers:
 *
 *   collect  (inject sessions, storageDomain, subprocess, settings)
 *     ├─ consolidate (inject llm, sessions)   — span summaries, cascade, work units
 *     ├─ recall      (inject agents)          — rules/taboos preload at session start
 *     └─ skills      (inject skills)          — DSH-specific hypatia-memory skill
 *
 * @module dsh-hypatia-auto-memory
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { absolutizeDates, blocksToText, redactSecrets } from './content-policy.js'
import { installConfig } from './config.js'
import { openState } from './state.js'
import { EMPTY_PROGRESS, advanceProgress } from './progress.js'
import { createStatus } from './status.js'
import { createHypatiaCli } from './hypatia-cli.js'
import { createWriter } from './writer.js'
import { TaskDeferredError, createQueue } from './queue.js'
import { countLoggableMessages, createCollector, formatSpan } from './collector.js'
import { createCascade } from './cascade.js'
import { createConsolidator, PLUGIN_NAME } from './consolidator.js'
import { createRecall } from './recall.js'

export const name = 'dsh-hypatia-auto-memory'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_SKILLS_DIR = join(PACKAGE_ROOT, 'skills')

/* -------------------------------------------------------------------------- */
/* Skill packaging                                                            */
/* -------------------------------------------------------------------------- */

/** Minimal YAML-frontmatter reader (same contract as dsh-hypatia). */
function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (match === null) return { attributes: {}, body: source }
  const attributes = {}
  for (const line of match[1].split('\n')) {
    const pair = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (pair !== null) attributes[pair[1]] = pair[2].trim()
  }
  return { attributes, body: source.slice(match[0].length) }
}

/** Register the packaged hypatia-memory skill, refusing to shadow another provider's. */
function registerSkills(ctx, skillsDir, status) {
  let entries
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    status.warn(`skills dir unreadable: ${skillsDir}`)
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory() === false) continue
    const skillFile = join(skillsDir, entry.name, 'SKILL.md')
    if (existsSync(skillFile) === false) continue
    const { attributes, body } = parseFrontmatter(readFileSync(skillFile, 'utf8'))
    const skillName = attributes.name ?? entry.name
    void (async () => {
      const existing = await ctx.skills.get(skillName).catch(() => undefined)
      if (existing !== undefined && existing.provider !== PLUGIN_NAME) {
        status.warn(
          `skill "${skillName}" already provided by ${existing.provider}; `
          + 'set skills: false on that plugin (e.g. dsh-hypatia) to use the auto-memory variant',
        )
        return
      }
      ctx.skills.register({
        name: skillName,
        description: attributes.description ?? '',
        content: body,
        path: skillFile,
        source: 'bundled',
        provider: PLUGIN_NAME,
        resourceBase: dirname(skillFile),
        invocation: { modelInvocable: true, userInvocable: attributes['user-invocable'] !== 'false' },
      })
      status.info(`registered bundled skill: ${skillName}`)
    })()
  }
}

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

    const state = await openState(ctx)
    if (disposed) {
      await state.domain.close().catch(() => {})
      return
    }

    const queue = createQueue({
      tasks: state.tasks,
      getConfig: () => configHandle.get().queue,
      status,
    })
    const cli = createHypatiaCli(ctx, {
      get binaries() {
        return configHandle.get().binaries
      },
      log: (message) => status.info(message),
    })
    // Late-bound: adjudication needs a model route, which only the consolidate
    // fiber has. Without it the writer stores a unit with no relationship, which
    // is the correct degradation — never a guessed one.
    const shared = { consolidator: undefined }

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

    /** Log executor: re-read the span, format per protocol, write idempotently. */
    queue.registerExecutor('log-message', async (task) => {
      // Resolved through the collector, not `ctx.sessions`: a session closing
      // down has already left the store while its final span is still queued.
      const session = collector.sessionFor(task.sessionId)
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
        toolLedger: config.collector.toolLedger,
        baseIndex,
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
      advanceProgress(state.progress, task.sessionId, (current) => ({
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
      const session = collector.sessionFor(task.sessionId)
      if (session === undefined) {
        throw new TaskDeferredError(`session ${task.sessionId} is not loaded; deferred until it is`)
      }
      const [event] = session.snapshotEvents(task.fromSeq, task.toSeq)
      if (event === undefined) return
      const summary = event.type === 'session/title'
        ? String(event.data?.title ?? '')
        : blocksToText(event.data?.summary ?? [])
      const markdown = absolutizeDates(redactSecrets(summary), new Date()).trim()
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
      advanceProgress(state.progress, task.sessionId, (progressRow) => ({
        hasSessionNode: 1,
        lastBelongToIndex: Math.max(progressRow.lastBelongToIndex, linkTo),
      }))
    })

    // Failed log-message records carry nothing the watermark does not: the range
    // was never marked logged, so the session's next flush covers it again.
    // Pruned at startup so the error message survives the run that produced it.
    const pruned = queue.pruneFailed(['log-message'])
    if (pruned > 0) status.info(`pruned ${pruned} failed log-message task(s); the watermarks re-derive their ranges`)

    await collector.backfillLiveSessions()
    status.info('collector running (backfill complete)')

    // Optional child fibers — each waits only for the services it needs.
    ctx.plugin({
      name: `${name}/consolidate`,
      inject: ['llm', 'sessions'],
      apply: (c) => {
        const consolidator = createConsolidator({
          queue,
          progress: state.progress,
          // Same resolver as the log executor: end-of-session consolidation runs
          // against a session the store has already released.
          sessions: { get: collector.sessionFor },
          llm: c.llm,
          cli,
          writer,
          getConfig: configHandle.get,
          status,
          projectFor: collector.projectFor,
        })
        queue.registerExecutor('consolidate', consolidator.execute)
        // Shares the consolidator's route cursor so every model attempt — span
        // summary, adjudication, archive — rotates through the selected routes
        // together rather than each keeping its own place in the rotation.
        const cascade = createCascade({
          cli,
          llm: c.llm,
          selectRoute: consolidator.selectRoute,
          getConfig: configHandle.get,
          status,
        })
        queue.registerExecutor('cascade', cascade.execute)
        shared.consolidator = consolidator
      },
    })

    ctx.plugin({
      name: `${name}/recall`,
      inject: ['agents'],
      apply: (c) => {
        createRecall({ ctx: c, cli, getConfig: configHandle.get, status, projectFor: collector.projectFor })
      },
    })

    if (cordisConfig.skills !== false) {
      ctx.plugin({
        name: `${name}/skills`,
        inject: ['skills'],
        apply: (c) => {
          registerSkills(c, cordisConfig.skillsDir ?? DEFAULT_SKILLS_DIR, status)
        },
      })
    }

    ctx.effect(() => () => {
      void queue.dispose()
    }, `${name}: dispose queue`)
  }
}
