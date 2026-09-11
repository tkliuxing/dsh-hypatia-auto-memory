/**
 * Progress-watermark helpers — pure, dependency-free. Split out from state.js
 * so queue/collector/consolidator logic stays importable (and unit-testable)
 * without the DSH package graph.
 *
 * @module dsh-hypatia-auto-memory/progress
 */

/** Default watermark for a session the plugin has never seen. */
export const EMPTY_PROGRESS = {
  lastLoggedSeq: 0,
  lastConsolidatedSeq: 0,
  lastCheckTurn: 0,
  pendingTokens: 0,
  hasSessionNode: 0,
  lastBelongToIndex: 0,
}

/** @type {WeakMap<object, Map<string, Promise<void>>>} per table, per session */
const chains = new WeakMap()

/**
 * Read-modify-write one progress record with protocol defaults, so every
 * writer (collector triggers, log executor, consolidation executor) composes
 * without clobbering each other's fields.
 *
 * That guarantee needs two things the storage table does not give for free.
 * Its `put` resolves once the write is durable and only then updates what `get`
 * returns, so a second read-modify-write started before the first landed read
 * the stale record and wrote it back — silently reverting the first writer's
 * field. Updates of one session are therefore chained, each reading only after
 * the previous one landed. And rows written before newer fields existed are
 * filled from `EMPTY_PROGRESS`, so a patch never computes from `undefined`.
 *
 * @param {any} progressTable
 * @param {string} sessionId
 * @param {(current: typeof EMPTY_PROGRESS) => Partial<typeof EMPTY_PROGRESS>} patch
 * @returns {Promise<void>} resolution once this update is durable.
 */
export function advanceProgress(progressTable, sessionId, patch) {
  let perTable = chains.get(progressTable)
  if (perTable === undefined) {
    perTable = new Map()
    chains.set(progressTable, perTable)
  }
  const previous = perTable.get(sessionId) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    const current = { ...EMPTY_PROGRESS, ...(progressTable.get(sessionId) ?? {}) }
    await progressTable.put(sessionId, { ...current, ...patch(current) })
  })
  perTable.set(sessionId, next)
  next.catch(() => {}).finally(() => {
    if (perTable.get(sessionId) === next) perTable.delete(sessionId)
  })
  return next
}
