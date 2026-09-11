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

/**
 * Read-modify-write one progress record with protocol defaults, so every
 * writer (collector triggers, log executor, consolidation executor) composes
 * without clobbering each other's fields.
 *
 * @param {any} progressTable
 * @param {string} sessionId
 * @param {(current: typeof EMPTY_PROGRESS) => Partial<typeof EMPTY_PROGRESS>} patch
 */
export function advanceProgress(progressTable, sessionId, patch) {
  const current = progressTable.get(sessionId) ?? EMPTY_PROGRESS
  progressTable.put(sessionId, { ...current, ...patch(current) })
}
