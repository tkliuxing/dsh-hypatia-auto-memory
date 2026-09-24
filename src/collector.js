/**
 * Conversation collector: listens to the session/event feed, selects the
 * protocol's log-worthy events (human user messages, assistant messages,
 * tool activity for the ledger, turn boundaries for triggers), resolves the
 * project scope, and enqueues idempotent log tasks. Content is ALWAYS
 * re-read from the authoritative session log at execution time — this module
 * never caches message bodies.
 *
 * @module dsh-hypatia-auto-memory/collector
 */

import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import {
  absolutizeDates,
  blocksToText,
  capAssistant,
  estimateTokens,
  eventDate,
  flattenToolResult,
  oneLineError,
  projectScope,
  redactSecrets,
} from './content-policy.js'
import { EMPTY_PROGRESS, advanceProgress } from './progress.js'

const execFileAsync = promisify(execFile)

/**
 * Environment variables that point git at a repository other than the one
 * around `-C`. Inherited from whatever launched DSH (a git hook, say), they
 * would decide every session's project.
 */
const GIT_LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']

/** How long one `git rev-parse` may take before the cwd's own name is used. */
const GIT_TIMEOUT_MS = 3000

/** `process.env` without {@link GIT_LOCATION_VARS}. */
function gitEnv() {
  const env = { ...process.env }
  for (const name of GIT_LOCATION_VARS) delete env[name]
  return env
}

/**
 * Events carrying a host-produced session summary, from which the protocol's
 * `session-<id>` node is built. DSH emits no session-summary event of its own;
 * these two are where a usable one actually appears.
 */
const SESSION_SUMMARY_TYPES = new Set(['session/title', 'compaction/summary'])

/** Events the log layer records, per the hypatia-memory protocol. */
const RECORDED_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
])

/**
 * Whether an assistant/message event carries anything worth logging on its own.
 *
 * A turn that only issued tool calls (no text, no reasoning, no interruption
 * marker) adds nothing to the conversation record — the tool outcomes already
 * live in the session log if needed. Skipping these avoids msg-* entries whose
 * entire body would be `(tool calls only)` or an empty placeholder.
 *
 * @param {any} event
 * @returns {boolean}
 */
function hasAssistantContent(event) {
  const blocks = event.data?.message?.content ?? []
  for (const block of blocks) {
    if (block.type === 'text' && String(block.text ?? '').trim() !== '') return true
    if (block.type === 'image') return true
  }
  return false
}

/**
 * Whether this event becomes one `msg-*` entry.
 *
 * Plugin-sourced user messages (injected context, including this plugin's own
 * output) are excluded: they are not things the human said, and re-logging them
 * would let memory amplify into itself.
 *
 * Assistant turns whose only content is tool calls are also excluded: they have
 * no substantive message to remember.
 *
 * @param {any} event
 * @returns {boolean}
 */
export function isLoggableMessage(event) {
  if (event?.type === 'assistant/message') {
    const interrupted = event.data?.interrupted === true
    return interrupted || hasAssistantContent(event)
  }
  return event?.type === 'user/message' && event.data?.source?.kind === 'user'
}

/**
 * Position of the next logged message, counted over `events`.
 *
 * Entry names are `msg-<session>-<N>` where N is the protocol's "monotonic turn
 * counter within session (increment per logged message)" — a DENSE message
 * ordinal, not a session-log seq. The distinction is load-bearing: DSH appends
 * one `assistant/chunk` event per streamed token delta, so seq counts tokens.
 * Naming entries by seq produced a sparse, unpredictable keyspace, which breaks
 * `$not-summaried`'s FIFO batching and anything that walks `msg-*` in order.
 *
 * Derived by counting rather than stored, so the value cannot drift from the
 * log: the log is append-only, so the same prefix always yields the same index,
 * and a replay therefore reproduces exactly the same names.
 *
 * @param {readonly any[]} events - the prefix preceding the span being written.
 * @returns {number}
 */
export function countLoggableMessages(events) {
  let count = 0
  for (const event of events ?? []) {
    if (isLoggableMessage(event)) count += 1
  }
  return count
}

/**
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   queue: ReturnType<import('./queue.js').createQueue>,
 *   progress: any,
 *   getConfig: () => any,
 *   status: import('./status.js').StatusLog,
 *   onTurnEnd: (sessionId: string, turn: number) => void,
 * }} deps
 */
export function createCollector({ ctx, queue, progress, getConfig, status, onTurnEnd, onSessionEnd }) {
  /** @type {Map<string, string>} sessionId -> resolved project scope. */
  const projects = new Map()
  /** @type {Map<string, number>} sessionId -> unconsolidated token estimate. */
  const pendingTokens = new Map()
  /** @type {Map<string, Promise<string>>} cwd -> project scope promise. */
  const projectByCwd = new Map()
  /**
   * Sessions the store has released but whose queued work has not drained.
   *
   * Executors re-read content from the session log rather than caching it, so
   * they need the object itself. A disposed session is still perfectly readable
   * — `snapshotEvents` works fine — it is merely gone from `ctx.sessions`, so
   * holding the reference across the drain is what lets end-of-session work run
   * at all, rather than being deferred to wait for a session that has closed.
   *
   * @type {Map<string, any>}
   */
  const detached = new Map()

  const sessionIdOf = (session) => String(session?.header?.id ?? session?.id ?? '')

  /** The live session, or one kept alive only until its queued work drains. */
  function sessionFor(sessionId) {
    return ctx.sessions?.get?.(sessionId) ?? detached.get(sessionId)
  }

  /** Drop every per-session cache entry once nothing can need it again. */
  function forget(sessionId) {
    detached.delete(sessionId)
    projects.delete(sessionId)
    pendingTokens.delete(sessionId)
  }

  /**
   * Best-effort git-root basename; falls back to the bare cwd basename. Either
   * way it becomes a scope hypatia stores as given (see `projectScope`).
   *
   * Only git's line ending is cut: trimming is `projectScope`'s, and JS `trim`
   * strips characters hypatia keeps. A timeout says nothing about the
   * directory, so its fallback is not remembered for the next caller.
   */
  function resolveProjectForCwd(cwd) {
    let cached = projectByCwd.get(cwd)
    if (cached === undefined) {
      cached = execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        timeout: GIT_TIMEOUT_MS,
        env: gitEnv(),
      })
        .then(({ stdout }) => {
          const root = stdout.replace(/\r?\n$/, '')
          // git before 2.25 printed an empty line, exit 0, outside a work tree.
          if (root === '') throw new Error('git printed no top level')
          return basename(root)
        })
        .catch((error) => {
          if (error?.killed) projectByCwd.delete(cwd)
          return basename(cwd)
        })
        .then(projectScope)
      projectByCwd.set(cwd, cached)
    }
    return cached
  }

  /** Resolve (and cache) the project scope for one session. */
  async function projectFor(session) {
    const id = sessionIdOf(session)
    let project = projects.get(id)
    if (project === undefined) {
      const cwd = session?.header?.cwd ?? session?.meta?.cwd ?? process.cwd()
      project = await resolveProjectForCwd(String(cwd))
      projects.set(id, project)
    }
    return project
  }

  /**
   * True when this user/message event is a direct human prompt (as opposed to
   * plugin-injected context — including OUR OWN recall injections, which must
   * never be re-logged: a feedback loop would amplify memory into itself).
   */
  function isHumanMessage(event) {
    return event.data?.source?.kind === 'user'
  }

  /** Extract plain text from a user/message payload. */
  function userText(event) {
    return blocksToText(event.data?.content ?? [])
  }

  /** Extract plain text from an assistant/message payload. */
  function assistantText(event) {
    return blocksToText(event.data?.message?.content ?? [])
  }

  /** Accumulate the unconsolidated token estimate for one recorded event. */
  function accrueTokens(session, event) {
    const text = event.type === 'assistant/message'
      ? assistantText(event)
      : event.type === 'user/message' ? userText(event) : ''
    if (text.trim() === '') return
    const id = sessionIdOf(session)
    pendingTokens.set(id, (pendingTokens.get(id) ?? 0) + estimateTokens(text))
  }

  /**
   * Enqueue everything this session has not logged yet, up to `toSeq`.
   *
   * The lower bound is the watermark rather than any particular event, so the
   * span is whole by construction — including messages the loop appended before
   * the first `step/start` of the turn.
   */
  async function enqueueUnlogged(session, toSeq, { immediate = false } = {}) {
    const id = sessionIdOf(session)
    const current = progress.get(id) ?? EMPTY_PROGRESS
    // A forked child must not re-log the prefix it inherited from its parent.
    const fromSeq = Math.max(current.lastLoggedSeq, session.inheritedEventCount ?? 0)
    if (toSeq <= fromSeq) return
    const project = await projectFor(session)
    await queue.enqueue({ kind: 'log-message', sessionId: id, fromSeq, toSeq, project, immediate })
  }

  /** Enqueue creation of the `session-<id>` node from the summary at `seq`. */
  async function enqueueSessionNode(session, seq) {
    const id = sessionIdOf(session)
    const project = await projectFor(session)
    await queue.enqueue({
      kind: 'session-node',
      sessionId: id,
      fromSeq: seq,
      toSeq: seq + 1,
      project,
      immediate: true,
    })
  }

  // ---- session/event listener -------------------------------------------------

  const listener = (session, event) => {
    if (session === undefined || event === undefined) return
    if (getConfig().collector?.enabled === false) return
    if (!RECORDED_TYPES.has(event.type)) {
      if (SESSION_SUMMARY_TYPES.has(event.type)) {
        // The task carries the seq, not the text: content is always re-read
        // from the authoritative log at execution time.
        void enqueueSessionNode(session, event.seq).catch((error) => {
          status.error('collector failed to enqueue the session node', error)
        })
        return
      }
      if (event.type === 'step/end') {
        // The fallback flush is armed here rather than on each message.
        // `step/end` is appended once the step's tools have all run, so a span
        // cut at one never separates an assistant message from its own tool
        // results. Arming it on the message instead meant a turn longer than
        // the window was cut mid-step, and every entry written before the cut
        // kept a partial tool ledger for good (entries are never rewritten).
        const window = getConfig().queue?.flushWindowMs ?? 0
        if (window > 0) {
          void enqueueUnlogged(session, event.seq + 1).catch((error) => {
            status.error('collector failed to arm the fallback flush', error)
          })
        }
        return
      }
      if (event.type === 'turn/end') {
        const id = sessionIdOf(session)
        const turn = event.data?.turn ?? 0
        const previous = progress.get(id) ?? EMPTY_PROGRESS
        // Flush at the turn boundary, never mid-turn. `assistant/message` is
        // appended BEFORE the tools it requested run, so a timer that fired
        // while a slow tool was still working split the assistant entry from
        // its own results — and since `formatSpan` only emits a tool ledger
        // alongside an assistant message, those results were then dropped
        // entirely rather than merely landing late. `turn/end` is appended once
        // the step loop is done, so a turn-aligned span always holds both.
        void enqueueUnlogged(session, event.seq + 1, { immediate: true })
          .catch((error) => status.error('collector failed to enqueue turn span', error))
        // MAX of the two sources, not first-present: the in-memory counter
        // resets on process restart while the durable record keeps the
        // pre-restart accumulation — taking the in-memory value whenever it
        // merely exists would regress the count (e.g. durable 672 -> 220).
        const tokens = Math.max(pendingTokens.get(id) ?? 0, previous.pendingTokens ?? 0)
        // The checkpoint is a minimum-interval anchor, not a polling cursor.
        // Advance it only after consolidation work is durably accepted. When
        // tokens are low, logging lags, or enqueueing fails, retain the anchor
        // so the next turn can retry immediately instead of waiting N turns.
        // `reason` travels with the trigger state so the consolidator can tell a
        // completed turn from a user interrupt or a failure. Its `kind` set is
        // merge-extensible, so it is passed through verbatim rather than
        // interpreted here.
        void Promise.resolve(onTurnEnd(id, turn, {
          ...previous,
          pendingTokens: tokens,
          reason: event.data?.reason,
        }))
          .then((decision) => {
            if (decision?.resetTokens === true) pendingTokens.delete(id)
            return advanceProgress(progress, id, (current) => ({
              lastCheckTurn: decision?.advanceCheckpoint === true ? turn : current.lastCheckTurn,
              pendingTokens: decision?.resetTokens === true ? 0 : tokens,
            }))
          })
          .catch((error) => {
            status.error('consolidation trigger failed', error)
            return advanceProgress(progress, id, () => ({ pendingTokens: tokens }))
          })
      }
      return
    }
    if (event.type === 'user/message' && !isHumanMessage(event)) return
    accrueTokens(session, event)
    // No enqueue here: spans are cut at `step/end` (the fallback) and at
    // `turn/end`, both handled above.
  }

  ctx.on('session/event', listener)

  // ---- session close ------------------------------------------------------------

  /**
   * Final flush and consolidation for a session that is going away.
   *
   * DSH has no `session/end` LOG event; `session/disposed` is the only close
   * signal, and it hands over the session object as it leaves the store. This
   * is the one chance to turn a short exchange into knowledge: the ongoing
   * thresholds (`checkEveryTurns`, `minNewTokens`) are pacing knobs for a live
   * conversation, and a task that finishes under both of them would otherwise
   * be logged and never extracted.
   */
  async function finishSession(session) {
    const id = sessionIdOf(session)
    if (id === '') return
    detached.set(id, session)
    try {
      await enqueueUnlogged(session, session.seq ?? 0, { immediate: true })
      if (onSessionEnd !== undefined) await onSessionEnd(id, session)
      const drained = await queue.whenIdle(id)
      if (!drained) status.warn(`session ${id} still had queued work when its grace period expired`)
    } catch (error) {
      status.error('session-end consolidation failed', error)
    } finally {
      forget(id)
    }
  }

  ctx.on('session/disposed', (session) => {
    if (getConfig().collector?.enabled === false) return
    void finishSession(session)
  })

  // ---- session (re)open -----------------------------------------------------------

  /**
   * Resume whatever this session's tasks were waiting on.
   *
   * DSH loads sessions lazily, so work persisted by an earlier run — or queued
   * for a session that closed before it ran — finds no session to read and is
   * deferred rather than failed. `session/created` fires both for a new session
   * and for one reopened from disk, which is the moment that work can run.
   */
  ctx.on('session/created', (session) => {
    const id = sessionIdOf(session)
    if (id === '' || typeof queue.resumeSession !== 'function') return
    const resumed = queue.resumeSession(id)
    if (resumed > 0) status.info(`session ${id} is live again; resumed ${resumed} deferred task(s)`)
  })

  // ---- boot backfill ------------------------------------------------------------

  /**
   * For every live session, enqueue any log range the watermark has not
   * covered — from plugin crash, kill -9, or HMR reload. Under the same task
   * ids the queue coalesces these with anything already persisted.
   */
  async function backfillLiveSessions() {
    const live = ctx.sessions?.list?.() ?? []
    for (const session of live) {
      const id = sessionIdOf(session)
      const before = (progress.get(id) ?? EMPTY_PROGRESS).lastLoggedSeq
      const end = session.seq ?? 0
      // Immediate: a boot backfill is recovering a span that is already closed,
      // so there is nothing for a coalescing window to wait for.
      await enqueueUnlogged(session, end, { immediate: true })
      if (end > Math.max(before, session.inheritedEventCount ?? 0)) {
        status.info(`backfill: session ${id} range [${Math.max(before, session.inheritedEventCount ?? 0)}, ${end})`)
      }
    }
  }

  return {
    backfillLiveSessions,
    projectFor,
    // Startup housekeeping resolves a scope from a persisted session header's
    // cwd, with no Session to hand — `projectFor` needs one, and caches by its
    // id, so it cannot serve that path.
    projectForCwd: resolveProjectForCwd,
    sessionFor,
    /** Drain the in-memory pending-token counter (called after a consolidation trigger). */
    takePendingTokens(sessionId) {
      const value = pendingTokens.get(sessionId) ?? 0
      pendingTokens.delete(sessionId)
      return value
    },
    setPendingTokens(sessionId, value) {
      pendingTokens.set(sessionId, value)
    },
  }
}

/**
 * Format one event span into per-message markdown per the protocol's logging
 * rules (redaction, date absolutization, assistant capping, tool ledger).
 * Reads events from the session log snapshot [fromSeq, toSeq).
 *
 * Exported for the queue executor and for tests.
 *
 * @param {readonly any[]} events - events exactly as recorded (with seq/time/data).
 * @param {{now?: Date, maxAssistantChars?: number, maxUserChars?: number,
 *          toolLedger?: boolean, baseIndex?: number, before?: any}} [policy]
 * `baseIndex` is the dense message ordinal the first entry of this span takes;
 * see {@link countLoggableMessages}. `before` is the event just ahead of the
 * span, which decides whether a leading `tool/result` is a compaction
 * replacement (see {@link isCompactionReplacement}). `now` is only the fallback
 * base for relative dates in an event that carries no timestamp.
 * @returns {Array<{seq: number, index: number, role: string, markdown: string, tokens: number}>}
 */
export function formatSpan(events, policy = {}) {
  const now = policy.now ?? new Date()
  const maxAssistantChars = policy.maxAssistantChars ?? 8000
  const maxUserChars = policy.maxUserChars ?? 32000
  const toolLedger = policy.toolLedger !== false
  let index = policy.baseIndex ?? 0
  const bySeq = new Map(events.map((e) => [e.seq, e]))

  // Pass 1: pair tool/call with tool/result inside this span -> ledger by step.
  // A step is one model call plus the tools it requested, so a step is exactly
  // what one assistant message's ledger should cover. Keying by turn instead
  // hung the whole turn's tool activity on every assistant message in it.
  //
  // The ledger records what was called, how long it took and whether it
  // succeeded — never what it returned (the hypatia-memory protocol: "never raw
  // outputs"). Output excerpts were 84% of all stored message bytes, mostly
  // file paths and file contents from `read`, and they made unrelated keyword
  // searches match raw chat logs through text nobody had written.
  /** @type {Map<string, Array<{name: string, ok: boolean, ms: number | undefined, error: string | undefined}>>} */
  const ledgerByStep = new Map()
  if (toolLedger) {
    for (const event of events) {
      if (event.type !== 'tool/result') continue
      if (isCompactionReplacement(event, bySeq, policy.before)) continue
      const callId = event.data?.message?.source?.callId
      const call = callId === undefined ? undefined : bySeq.get(findCallSeq(events, callId))
      const name = call?.data?.name ?? 'tool'
      const failure = event.data?.error
      // A failure keeps one line of what went wrong: that is the part worth
      // remembering, and the protocol asks for it.
      const detail = failure === undefined ? '' : oneLineError(flattenToolResult(event))
      const error = failure === undefined
        ? undefined
        : `${failure.name}${failure.code ? ` (${failure.code})` : ''}${detail === '' ? '' : ` — ${detail}`}`
      const ms = typeof call?.time === 'number' && typeof event.time === 'number' && event.time >= call.time
        ? event.time - call.time
        : undefined
      const key = stepKey(event)
      const list = ledgerByStep.get(key) ?? []
      list.push({ name, ok: failure === undefined, ms, error })
      ledgerByStep.set(key, list)
    }
  }

  // Pass 2: format user/assistant messages.
  const formatted = []
  for (const event of events) {
    if (!isLoggableMessage(event)) continue

    const role = event.type === 'user/message' ? 'user' : 'assistant'
    const raw = role === 'user' ? blocksToText(event.data?.content ?? []) : blocksToText(event.data?.message?.content ?? [])
    // Redact BEFORE capping: a cut landing inside a secret would otherwise leave
    // a fragment too short for the patterns to recognise. Relative dates are
    // resolved against when the message was sent, not when it is written.
    const limit = role === 'assistant' ? maxAssistantChars : maxUserChars
    const redacted = absolutizeDates(capAssistant(redactSecrets(raw), limit), eventDate(event, now))
    const interrupted = event.type === 'assistant/message' && event.data?.interrupted === true

    const sections = [
      '## Role',
      role,
      '',
      '## Timestamp',
      new Date(event.time).toISOString(),
      '',
    ]
    // Only assistant/message payloads carry a turn number; user messages are
    // positioned between turns, so stamping them with a fake turn 0 would lie.
    if (role === 'assistant') {
      sections.push('## Turn', String(event.data?.turn ?? 0), '')
    }
    const ledger = role === 'assistant' ? ledgerByStep.get(stepKey(event)) : undefined
    const hasLedger = ledger !== undefined && ledger.length > 0
    // A step that only called tools has no text of its own; say so rather than
    // leave an empty section.
    const body = redacted.trim() === '' && hasLedger ? '(tool calls only)' : redacted
    sections.push('## Content', body + (interrupted ? '\n\n[turn interrupted mid-stream]' : ''))

    if (hasLedger) {
      sections.push('', '## Tool Calls', ...renderLedger(ledger))
    }

    const markdown = sections.join('\n')
    formatted.push({ seq: event.seq, index, role, markdown, tokens: estimateTokens(markdown) })
    index += 1
  }
  return formatted
}

/** Ledger key: tool activity belongs to the step that requested it. */
function stepKey(event) {
  return `${event.data?.turn ?? 0}:${event.data?.step ?? 0}`
}

/**
 * Whether a `tool/result` is a compaction replacement rather than a tool outcome.
 *
 * When DSH compaction prunes an old tool result it appends a replacement copy of
 * it IMMEDIATELY after its `compaction/prune` event — the adjacency is
 * contractual in dsh-compaction. The copy carries the original turn/step, often
 * tens of thousands of events after that step ended, so it restates something
 * already recorded. Treating it as new activity would re-add it to a ledger or a
 * transcript, and it is the only way a result ever follows its own `step/end`.
 *
 * @param {any} event
 * @param {Map<number, any>} bySeq - events of the span, by seq.
 * @param {any} [before] - the event just ahead of the span, if known.
 * @returns {boolean}
 */
export function isCompactionReplacement(event, bySeq, before) {
  if (event?.type !== 'tool/result') return false
  const previous = bySeq.get(event.seq - 1) ?? (before?.seq === event.seq - 1 ? before : undefined)
  return previous?.type === 'compaction/prune'
}

/** Locate the tool/call seq for one callId within the span. */
function findCallSeq(events, callId) {
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.callId === callId) return event.seq
  }
  return -1
}

/** Human-scale duration: `340ms`, `2.4s`, `3m12s`. */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m${Math.round((ms - minutes * 60_000) / 1000)}s`
}

/**
 * Render one step's ledger. Consecutive calls of the same tool with the same
 * outcome collapse into one numbered row carrying a count and their total
 * time; a failure keeps its one-line error.
 *
 *   1. `read` ×5 — ✅ 1.2s total
 *   2. `bash` — ❌ 2.0s — Error (ENOENT) — no such file
 */
function renderLedger(ledger) {
  const rows = []
  for (const entry of ledger) {
    const prev = rows[rows.length - 1]
    if (prev !== undefined && prev.name === entry.name && prev.ok === entry.ok && prev.error === entry.error) {
      prev.count += 1
      prev.ms = prev.ms === undefined || entry.ms === undefined ? undefined : prev.ms + entry.ms
    } else {
      rows.push({ ...entry, count: 1 })
    }
  }
  return rows.map((row, i) => {
    const times = row.count > 1 ? ` ×${row.count}` : ''
    const took = row.ms === undefined ? '' : ` ${formatDuration(row.ms)}${row.count > 1 ? ' total' : ''}`
    const tail = row.ok ? '' : ` — ${row.error}`
    return `${i + 1}. \`${row.name}\`${times} — ${row.ok ? '✅' : '❌'}${took}${tail}`
  })
}
