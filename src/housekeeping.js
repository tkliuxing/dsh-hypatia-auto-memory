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
 * Index the stored-session listing the way this module's callers need it.
 *
 * `sessionPersistence.list()` yields `SessionPersistenceSnapshot` — an object
 * wrapping `header` — NOT the header itself. Reading `id`/`cwd` off the
 * snapshot compiles, type-checks behind an `any`, and yields an empty index:
 * `cwdFor` then answers undefined for every session, so
 * {@link backfillConsolidation} skipped all of them and a live profile's
 * fifteen unconsolidated tails survived every restart. TypeScript cannot catch
 * that here (the service arrives as a cordis service), so the shape is consumed
 * in one exported, unit-tested place instead of inline in the composition.
 *
 * @param {readonly any[]} snapshots - the `sessionPersistence.list()` result.
 * @returns {{cwdById: Map<string, string>, knownSessionIds: Set<string>}}
 */
export function sessionDirectory(snapshots) {
  const cwdById = new Map()
  const knownSessionIds = new Set()
  for (const snapshot of snapshots ?? []) {
    const id = String(snapshot?.header?.id ?? '')
    if (id === '') continue
    knownSessionIds.add(id)
    if (snapshot?.header?.cwd !== undefined) cwdById.set(id, String(snapshot.header.cwd))
  }
  return { cwdById, knownSessionIds }
}

/**
 * Consolidate logged tails the in-session trigger never reached.
 *
 * This is the path that finishes what a shutdown could only persist, and what a
 * crash or `kill -9` left behind entirely. A session that ended under the turn
 * and token thresholds has no summary on the shelf and nothing scheduled to make
 * one: the shutdown sweep persists the range (see `finalizeLiveSessions`) and
 * this pass, running at the next start, turns it into knowledge.
 *
 * The live trigger's token floor deliberately does NOT apply.
 *
 * The floor exists to stop a live conversation from paying a model call per
 * small turn, and it is right there — there is always a later turn to wait for.
 * At boot there is no later turn: a tail skipped here is skipped permanently,
 * which was measured on a live profile as fifteen sessions carrying 1–1950
 * pending tokens, none ever consolidated, and eight of nine sessions with
 * messages and `lastConsolidatedSeq: 0`. Cost is bounded by `perScopeLimit`
 * instead — at most that many sessions per project scope per start, biggest
 * tails first — so a backlog drains over several starts rather than in one
 * unbounded burst of model calls.
 *
 * A range whose consolidate record is `failed` is taken first whatever its size:
 * it was attempted and lost, `resumeKind` will not re-schedule a `failed` row,
 * and the enqueue below revives it as `pending` with a fresh attempt budget.
 *
 * A session DSH no longer lists is skipped (`cwdFor` returns undefined) — its
 * row belongs to {@link pruneVanishedSessions}. One that is listed but not
 * loaded is fine: the executor resolves it from persistence.
 *
 * @param {{
 *   progress: any,
 *   queue: { enqueue: (spec: any) => Promise<void>, peek?: (kind: string, sessionId: string) => any },
 *   cwdFor: (sessionId: string) => string | undefined,
 *   projectForCwd: (cwd: string) => Promise<string>,
 *   perScopeLimit?: number,
 *   status: import('./status.js').StatusLog,
 * }} deps
 * @returns {Promise<{enqueued: string[], skipped: number, scopes: number}>}
 */
export async function backfillConsolidation({
  progress, queue, cwdFor, projectForCwd, perScopeLimit = 4, status,
}) {
  if (typeof progress.entries !== 'function') return { enqueued: [], skipped: 0, scopes: 0 }
  // Guarded rather than trusted: a NaN here would make `slice(0, NaN)` empty and
  // silently disable the pass, which is the one failure this whole path exists
  // to prevent. The schema bounds the configured value; this bounds a caller.
  const limit = Number.isFinite(perScopeLimit) ? Math.max(1, Math.floor(perScopeLimit)) : 4
  /** @type {Map<string, Array<{sessionId: string, fromSeq: number, toSeq: number, failed: boolean, weight: number}>>} */
  const byProject = new Map()
  for (const [sessionId, row] of [...progress.entries()]) {
    const fromSeq = row?.lastConsolidatedSeq ?? 0
    const toSeq = row?.lastLoggedSeq ?? 0
    if (toSeq <= fromSeq) continue
    const cwd = cwdFor(sessionId)
    // A failed task carries the scope its own earlier attempt resolved, which is
    // what lets it revive itself. `cwdFor` reads the persistence listing, and a
    // session DSH has not checkpointed yet is absent from it — measured: a
    // truncated consolidation stayed `failed` through a full restart, because
    // its live session had no cwd in that listing and this loop dropped it. The
    // stored scope is the one the log was written under, so reusing it cannot
    // mis-scope the retry, and a replay writes under it either way.
    const existing = queue.peek?.('consolidate', sessionId)
    const project = cwd !== undefined
      ? await projectForCwd(cwd)
      : (typeof existing?.project === 'string' && existing.project !== '' ? existing.project : undefined)
    if (project === undefined) continue
    const list = byProject.get(project) ?? []
    list.push({
      sessionId,
      fromSeq,
      toSeq,
      failed: existing?.status === 'failed',
      weight: row?.pendingTokens ?? 0,
    })
    byProject.set(project, list)
  }

  const enqueued = []
  let skipped = 0
  for (const [project, list] of byProject) {
    // A lost attempt first, then the largest tail: the most knowledge recovered
    // per model call the budget allows. The session id breaks ties so the choice
    // is deterministic across starts rather than table-order dependent.
    list.sort((a, b) => Number(b.failed) - Number(a.failed)
      || b.weight - a.weight
      || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
    for (const item of list.slice(0, limit)) {
      await queue.enqueue({
        kind: 'consolidate',
        sessionId: item.sessionId,
        fromSeq: item.fromSeq,
        toSeq: item.toSeq,
        project,
        immediate: true,
      })
      enqueued.push(item.sessionId)
    }
    skipped += Math.max(0, list.length - limit)
  }
  if (enqueued.length > 0) {
    status.info(`consolidation backfill: queued ${enqueued.length} session(s) with an unconsolidated tail`
      + (skipped > 0 ? `; ${skipped} more wait for a later start` : ''))
  }
  return { enqueued, skipped, scopes: byProject.size }
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
