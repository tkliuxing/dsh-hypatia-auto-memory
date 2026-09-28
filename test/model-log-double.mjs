/**
 * A `modelLog` double for call-site tests.
 *
 * It records what `begin()` was called with and what each attempt was settled
 * with, so a test can assert what the pipeline reported about a model call
 * without touching a storage domain.
 *
 * `finish` appends synchronously (the async wrapper has no await before the
 * push), which is what keeps these assertions valid now that the call sites
 * deliberately do not await it — `void attempt.finish(...)`.
 *
 * `effort` and `usage` are captured exactly as the call site passed them: the
 * real log coerces and defaults them, so a test about the CALL SITE must see
 * `undefined` rather than the log's `''` / `0`.
 */
export function makeModelLogDouble() {
  const attempts = []
  return {
    attempts,
    begin: (purpose, route, effort) => {
      const record = { purpose, route, effort, done: [] }
      attempts.push(record)
      return {
        finish: async (outcome, detail = '', usage) => {
          record.done.push(outcome, detail)
          record.usage = usage
        },
      }
    },
    recent: () => [],
  }
}
