/**
 * Startup housekeeping for the progress and task tables.
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

import { projectScope } from './content-policy.js'
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

/**
 * Consolidate a logged tail that the in-session trigger never reached.
 *
 * The session-end trigger cannot survive a process restart. DSH does run its
 * close path at shutdown — it appends `session/end-seed` to the open session —
 * but nothing this plugin enqueues there becomes durable before the process is
 * gone: measured on a live restart, the storage file was not written at all and
 * the session came back with `lastConsolidatedSeq: 0`. A short session that
 * never reached the turn/token thresholds thus produced no knowledge, which is
 * exactly the case the session-end trigger was added for.
 *
 * Gated on the SAME floor as the live trigger and read from the row, not by
 * loading the session: `pendingTokens` is the estimate accumulated up to the
 * last turn that ended, so a tail too small to be worth a model call while the
 * session was alive stays too small here. Without that gate every restart would
 * spend one model call per session carrying any tail at all.
 *
 * A session DSH no longer lists is skipped (`cwdFor` returns undefined) — its
 * row belongs to {@link pruneVanishedSessions}. One that is listed but not
 * loaded is fine: the executor defers the task until that session is opened.
 *
 * @param {{
 *   progress: any,
 *   queue: { enqueue: (spec: any) => Promise<void> },
 *   cwdFor: (sessionId: string) => string | undefined,
 *   projectForCwd: (cwd: string) => Promise<string>,
 *   minNewTokens: number,
 *   status: import('./status.js').StatusLog,
 * }} deps
 * @returns {Promise<{enqueued: string[], skippedBelowFloor: number}>}
 */
export async function backfillConsolidation({ progress, queue, cwdFor, projectForCwd, minNewTokens, status }) {
  if (typeof progress.entries !== 'function') return { enqueued: [], skippedBelowFloor: 0 }
  const enqueued = []
  let skippedBelowFloor = 0
  for (const [sessionId, row] of [...progress.entries()]) {
    const fromSeq = row?.lastConsolidatedSeq ?? 0
    const toSeq = row?.lastLoggedSeq ?? 0
    if (toSeq <= fromSeq) continue
    if ((row?.pendingTokens ?? 0) < minNewTokens) {
      skippedBelowFloor += 1
      continue
    }
    const cwd = cwdFor(sessionId)
    if (cwd === undefined) continue
    const project = await projectForCwd(cwd)
    await queue.enqueue({ kind: 'consolidate', sessionId, fromSeq, toSeq, project, immediate: true })
    enqueued.push(sessionId)
  }
  if (enqueued.length > 0) {
    status.info(`consolidation backfill: queued ${enqueued.length} session(s) whose logged tail was never consolidated`)
  }
  return { enqueued, skippedBelowFloor }
}

/**
 * Rewrite each persisted task's project to the scope `projectScope` makes of
 * it.
 *
 * A task carries the project it was queued under, and its executor writes with
 * it as stored. One queued before project names became scopes — for a session
 * at `/`, or in a directory whose name has a comma — would otherwise write one
 * more span that no query of its project finds. Every kind of task is queued
 * with a project, so an empty one can only be the `/` case. Run before any
 * executor is registered, so no task is read mid-rewrite.
 *
 * @param {{tasks: any, status: import('./status.js').StatusLog}} deps
 * @returns {Promise<number>} how many tasks were rewritten.
 */
export async function normalizeTaskProjects({ tasks, status }) {
  if (typeof tasks.entries !== 'function') return 0
  let rewritten = 0
  for (const [id, record] of [...tasks.entries()]) {
    // A failed task never runs again; it is kept, or pruned, as it stands.
    if (typeof record?.project !== 'string' || record.status === 'failed') continue
    const scope = projectScope(record.project)
    if (scope === record.project) continue
    try {
      await tasks.update(id, (task) => ({ ...task, project: scope }))
      rewritten += 1
    } catch (error) {
      // Best effort: the task then writes one span under the old name, which
      // is what it would have done anyway. Not a reason to stop collecting.
      status.warn(`could not rewrite the project of task ${id}: ${String(error)}`)
    }
  }
  if (rewritten > 0) status.info(`rewrote the project of ${rewritten} queued task(s) to a scope hypatia stores as given`)
  return rewritten
}
