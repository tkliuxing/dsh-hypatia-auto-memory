/**
 * Flattening the two state tables into what the conversation's Memory tab reads.
 *
 * Why this exists. Everything the background pipeline knows about a session —
 * how far it has been logged, how far it has been consolidated, how many tokens
 * are still waiting, whether the `session-<id>` node exists, which tasks are
 * stuck — lives in the state domain, on disk, readable only by stopping DSH and
 * opening a JSON file. The checklist in the README tells a user to confirm
 * logging with a hand-typed `hypatia knowledge-get msg-<sessionId>-<n>`. That is
 * the gap this closes: a conversation tab that answers "did this session get
 * remembered, and is anything stuck" without leaving the browser.
 *
 * Pure, so it is tested without a storage domain, a cordis context or hypatia.
 * The route that serves it lives in memory-api.js.
 *
 * @module dsh-hypatia-auto-memory/memory-status
 */

import { EMPTY_PROGRESS } from './progress.js'

/** How many failed tasks the shared failure list carries. */
export const FAILED_LIMIT = 20

/** How long a task `error` may be in the payload. */
export const ERROR_MAX = 200

/**
 * Bound a task error the way every other diagnostic path in this plugin does.
 * @param {unknown} value - a task's stored `error` field.
 * @returns {string} the message, capped, or '' when it is not a string.
 */
export function boundedError(value) {
  if (typeof value !== 'string') return ''
  return value.length > ERROR_MAX ? `${value.slice(0, ERROR_MAX)}…` : value
}

/** A session row with no progress of its own — a session known only from a task. */
function emptyEntry(id) {
  return {
    id,
    logged: EMPTY_PROGRESS.lastLoggedSeq,
    consolidated: EMPTY_PROGRESS.lastConsolidatedSeq,
    checkTurn: EMPTY_PROGRESS.lastCheckTurn,
    pendingTokens: EMPTY_PROGRESS.pendingTokens,
    sessionNode: EMPTY_PROGRESS.hasSessionNode === 1,
    belongTo: EMPTY_PROGRESS.lastBelongToIndex,
    deferred: 0,
    failed: 0,
    error: '',
  }
}

/**
 * Fold the two state tables into per-session rows plus a shared failure list.
 *
 * Sessions come from `progress` (one row per session the shelf has seen) and are
 * topped up from `tasks`, so a session whose only trace is a stuck task still
 * appears with a reason rather than looking untouched. Task counts are folded
 * onto their session; the failure list carries bounded error text, and
 * `deferred` only counts, since a deferred task is waiting on a load, not on a
 * person.
 *
 * With `sessionId` the fold covers that one session: the failure cap then
 * bounds only its failures, so other sessions' backlog cannot crowd them out,
 * and a per-request read does not build a row for every session on the shelf.
 *
 * @param {{
 *   progressEntries: Iterable<[string, any]>,
 *   taskEntries: Iterable<[string, any]>,
 *   sessionId?: string,
 * }} deps - raw table entries for the shelf in use, and optionally the one
 *   session to keep.
 * @returns {{sessions: object[], failed: object[], total: number}}
 */
export function buildStatus({ progressEntries, taskEntries, sessionId: only }) {
  const bySession = new Map()
  for (const [key, row] of progressEntries) {
    if (only !== undefined && key !== only) continue
    const current = { ...EMPTY_PROGRESS, ...(row ?? {}) }
    bySession.set(key, {
      id: key,
      logged: current.lastLoggedSeq,
      consolidated: current.lastConsolidatedSeq,
      checkTurn: current.lastCheckTurn,
      pendingTokens: current.pendingTokens,
      sessionNode: current.hasSessionNode === 1,
      belongTo: current.lastBelongToIndex,
      deferred: 0,
      failed: 0,
      error: '',
    })
  }

  const failed = []
  for (const [id, record] of taskEntries) {
    const sessionId = String(record?.sessionId ?? '')
    if (sessionId === '') continue
    if (only !== undefined && sessionId !== only) continue
    const entry = bySession.get(sessionId) ?? emptyEntry(sessionId)
    const status = String(record?.status ?? '')
    if (status === 'deferred') entry.deferred += 1
    if (status === 'failed') {
      entry.failed += 1
      if (entry.error === '') entry.error = boundedError(record?.error)
      failed.push({
        kind: String(record?.kind ?? ''),
        sessionId,
        attempts: Number(record?.attempts ?? 0),
        error: boundedError(record?.error),
      })
    }
    bySession.set(sessionId, entry)
  }

  // The tasks table is keyed `<kind>:<sessionId>`, so insertion order is kind-major
  // and not a recency order. Truncating is therefore arbitrary rather than
  // "newest"; it is a bound on the payload, not a ranking.
  return { sessions: [...bySession.values()], failed: failed.slice(0, FAILED_LIMIT), total: bySession.size }
}

/**
 * Collapse the fold to the one session the tab is bound to.
 *
 * The derived flags are computed here rather than in the browser so there is one
 * definition of "caught up" and one place to change it.
 *
 * @param {{sessions: object[], failed: object[]}} built - the output of {@link buildStatus}.
 * @param {string} sessionId - the session the tab is showing.
 * @returns {object} the session view; `known` is false for a session with no trace yet.
 */
export function sessionView(built, sessionId) {
  const row = built.sessions.find((session) => session.id === sessionId)
  const failedTasks = built.failed.filter((task) => task.sessionId === sessionId)
  if (row === undefined) {
    return {
      sessionId,
      known: false,
      loggedSeq: 0,
      consolidatedSeq: 0,
      // Nothing logged and nothing consolidated is not a backlog.
      caughtUp: true,
      pendingTokens: 0,
      sessionNode: false,
      belongTo: 0,
      deferred: 0,
      failed: 0,
      failedTasks,
      error: '',
    }
  }
  return {
    sessionId,
    known: true,
    loggedSeq: row.logged,
    consolidatedSeq: row.consolidated,
    // Both watermarks start at 0, so an unlogged session reads as caught up
    // rather than as behind — `known` separates "nothing to do" from "nothing done".
    caughtUp: row.consolidated >= row.logged,
    pendingTokens: row.pendingTokens,
    sessionNode: row.sessionNode,
    belongTo: row.belongTo,
    deferred: row.deferred,
    failed: row.failed,
    failedTasks,
    error: row.error,
  }
}
