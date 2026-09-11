/**
 * Startup housekeeping for the progress table.
 *
 * A progress row is this plugin's only record of how far a session has been
 * logged and consolidated. It lives in DSH's storage, not in hypatia, so the two
 * can drift apart: a shelf that is replaced or wiped leaves every row claiming
 * work that no longer exists (a live profile had 7 of its 10 rows in that
 * state), and a session that disappears from DSH leaves a row, and possibly
 * tasks, that nothing will ever need again.
 *
 * Both passes are deliberately conservative, because resetting a row is not
 * free: the session is re-logged from the start (writes are get-before-create,
 * so no duplicates, but one CLI round trip per message) and re-consolidated
 * from the start (a fresh summary under a new name, and a model call). So a row
 * is only touched on POSITIVE evidence, and any doubt — a failed query, an
 * empty session listing — leaves it alone.
 *
 * @module dsh-hypatia-auto-memory/housekeeping
 */

import { EMPTY_PROGRESS, advanceProgress } from './progress.js'

/**
 * Reset every row whose session has no `msg-*` entry left in the shelf.
 *
 * Positive evidence only: a row is reset when the watermark says messages were
 * logged AND the shelf query succeeded AND it returned nothing for that
 * session. A query that fails proves nothing about the shelf — hypatia could be
 * missing, or its database down — so that row is left exactly as it was.
 *
 * Trade-off, by design: a session whose messages were ALL deliberately deleted
 * looks the same as one whose shelf was wiped, and will be logged again the next
 * time it is active. Disable with `housekeeping.reconcileOnStartup: false`.
 *
 * @param {{
 *   progress: any,
 *   cli: { query: (jse: string) => Promise<any[]> },
 *   status: import('./status.js').StatusLog,
 * }} deps
 * @returns {Promise<{checked: number, reset: string[], unverified: number}>}
 */
export async function reconcileProgress({ progress, cli, status }) {
  if (typeof progress.entries !== 'function') return { checked: 0, reset: [], unverified: 0 }
  const reset = []
  let checked = 0
  let unverified = 0
  // Snapshot first: resetting rows while iterating the live table would be
  // iterating a collection that is being written.
  for (const [sessionId, row] of [...progress.entries()]) {
    if ((row?.lastLoggedSeq ?? 0) <= 0) continue
    checked += 1
    let rows
    try {
      rows = await cli.query(JSON.stringify({ $knowledge: [['$like', 'name', `msg-${sessionId}-%`]], limit: 1 }))
    } catch (error) {
      unverified += 1
      status.warn(`progress reconcile skipped ${sessionId}: shelf query failed (${String(error)})`)
      continue
    }
    if (rows.length > 0) continue
    await advanceProgress(progress, sessionId, () => ({ ...EMPTY_PROGRESS }))
    reset.push(sessionId)
  }
  if (reset.length > 0) {
    status.info(`progress reconcile: reset ${reset.length} session(s) with no entries left in the shelf; they re-log on their next activity`)
  }
  return { checked, reset, unverified }
}

/**
 * Remove the progress row and tasks of every session DSH no longer knows.
 *
 * `knownSessionIds` must be DSH's full persisted listing. An EMPTY listing is
 * treated as "unknown", never as "no sessions exist": a persistence layer that
 * has not finished loading, or failed quietly, would otherwise delete every row
 * in one pass. Sessions currently live are always kept.
 *
 * @param {{
 *   progress: any,
 *   queue: { sessionIds: () => Set<string>, forgetSession: (id: string) => Promise<number> },
 *   knownSessionIds: Set<string>,
 *   isLive?: (sessionId: string) => boolean,
 *   status: import('./status.js').StatusLog,
 * }} deps
 * @returns {Promise<{removed: string[], skipped: boolean}>}
 */
export async function pruneVanishedSessions({ progress, queue, knownSessionIds, isLive = () => false, status }) {
  if (knownSessionIds.size === 0) {
    status.warn('progress prune skipped: DSH reported no persisted sessions, which is not proof that none exist')
    return { removed: [], skipped: true }
  }
  const candidates = new Set(typeof progress.entries === 'function' ? [...progress.entries()].map(([id]) => id) : [])
  for (const id of queue.sessionIds()) candidates.add(id)

  const removed = []
  for (const sessionId of candidates) {
    if (knownSessionIds.has(sessionId) || isLive(sessionId)) continue
    await queue.forgetSession(sessionId)
    if (progress.get(sessionId) !== undefined) await progress.delete(sessionId)
    removed.push(sessionId)
  }
  if (removed.length > 0) {
    status.info(`progress prune: removed ${removed.length} session(s) DSH no longer has`)
  }
  return { removed, skipped: false }
}
