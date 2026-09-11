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
  flattenToolResult,
  oneLineError,
  redactSecrets,
} from './content-policy.js'
import { EMPTY_PROGRESS, advanceProgress } from './progress.js'

const execFileAsync = promisify(execFile)

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
 * Whether this event becomes one `msg-*` entry.
 *
 * Plugin-sourced user messages (injected context, including this plugin's own
 * output) are excluded: they are not things the human said, and re-logging them
 * would let memory amplify into itself.
 *
 * @param {any} event
 * @returns {boolean}
 */
export function isLoggableMessage(event) {
  if (event?.type === 'assistant/message') return true
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
  /** @type {Map<string, Promise<string>>} cwd -> git root basename promise. */
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

  /** Best-effort git-root basename; falls back to the bare cwd basename. */
  function resolveProjectForCwd(cwd) {
    let cached = projectByCwd.get(cwd)
    if (cached === undefined) {
      cached = execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 3000 })
        .then(([out]) => basename(out.trim()))
        .catch(() => basename(cwd))
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
            advanceProgress(progress, id, (current) => ({
              lastCheckTurn: decision?.advanceCheckpoint === true ? turn : current.lastCheckTurn,
              pendingTokens: decision?.resetTokens === true ? 0 : tokens,
            }))
            if (decision?.resetTokens === true) pendingTokens.delete(id)
          })
          .catch((error) => {
            status.error('consolidation trigger failed', error)
            advanceProgress(progress, id, () => ({ pendingTokens: tokens }))
          })
      }
      return
    }
    if (event.type === 'user/message' && !isHumanMessage(event)) return
    accrueTokens(session, event)
    // No enqueue here: the span is cut at `turn/end` (see above). The
    // flush-window fallback below only covers a turn that runs long enough that
    // waiting for its end would risk losing work to a crash.
    if (event.type !== 'assistant/message' && event.type !== 'user/message') return
    const window = getConfig().queue?.flushWindowMs ?? 0
    if (window > 0) {
      void enqueueUnlogged(session, event.seq + 1).catch((error) => {
        status.error('collector failed to arm the fallback flush', error)
      })
    }
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
 * @param {{now?: Date, maxAssistantChars?: number, toolLedger?: boolean, baseIndex?: number}} [policy]
 * `baseIndex` is the dense message ordinal the first entry of this span takes;
 * see {@link countLoggableMessages}.
 * @returns {Array<{seq: number, index: number, role: string, markdown: string, tokens: number}>}
 */
export function formatSpan(events, policy = {}) {
  const now = policy.now ?? new Date()
  const maxAssistantChars = policy.maxAssistantChars ?? 8000
  const toolLedger = policy.toolLedger !== false
  let index = policy.baseIndex ?? 0
  const bySeq = new Map(events.map((e) => [e.seq, e]))

  // Pass 1: pair tool/call with tool/result inside this span -> ledger by turn.
  /** @type {Map<number, Array<{name: string, line: string}>>} */
  const ledgerByTurn = new Map()
  if (toolLedger) {
    for (const event of events) {
      if (event.type !== 'tool/result') continue
      const callId = event.data?.message?.source?.callId
      const call = callId === undefined ? undefined : bySeq.get(findCallSeq(events, callId))
      const name = call?.data?.name ?? 'tool'
      const error = event.data?.error
      let line
      if (error !== undefined) {
        line = `❌ ${error.name}${error.code ? ` (${error.code})` : ''} — ${oneLineError(flattenToolResult(event))}`
      } else {
        const text = flattenToolResult(event)
        line = text.trim() === '' ? '✅' : `✅ ${oneLineError(text)}`
      }
      const turn = event.data?.turn ?? 0
      const list = ledgerByTurn.get(turn) ?? []
      list.push({ name, line })
      ledgerByTurn.set(turn, list)
    }
  }

  // Pass 2: format user/assistant messages.
  const formatted = []
  for (const event of events) {
    if (!isLoggableMessage(event)) continue

    const role = event.type === 'user/message' ? 'user' : 'assistant'
    const raw = role === 'user' ? blocksToText(event.data?.content ?? []) : blocksToText(event.data?.message?.content ?? [])
    const redacted = absolutizeDates(redactSecrets(role === 'assistant' ? capAssistant(raw, maxAssistantChars) : raw), now)
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
    sections.push('## Content', redacted + (interrupted ? '\n\n[turn interrupted mid-stream]' : ''))

    const ledger = ledgerByTurn.get(event.data?.turn ?? 0)
    if (role === 'assistant' && ledger !== undefined && ledger.length > 0) {
      // Collapse repeated identical tool lines into `name ×N`.
      const collapsed = collapseLedger(ledger)
      sections.push('', '## Tool Calls', ...collapsed.map((entry, i) => `${i + 1}. \`${entry.name}\` — ${entry.line}`))
    }

    const markdown = sections.join('\n')
    formatted.push({ seq: event.seq, index, role, markdown, tokens: estimateTokens(markdown) })
    index += 1
  }
  return formatted
}

/** Locate the tool/call seq for one callId within the span. */
function findCallSeq(events, callId) {
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.callId === callId) return event.seq
  }
  return -1
}

/** Collapse consecutive identical ledger entries into one `×N` row. */
function collapseLedger(ledger) {
  const out = []
  for (const entry of ledger) {
    const prev = out[out.length - 1]
    if (prev !== undefined && prev.name === entry.name && prev.line === entry.line) {
      prev.count += 1
    } else {
      out.push({ ...entry, count: 1 })
    }
  }
  return out.map((e) => ({
    name: e.name,
    line: e.count > 1 ? `${e.line} ×${e.count}` : e.line,
  }))
}
