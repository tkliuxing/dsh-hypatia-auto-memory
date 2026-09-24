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
 */
export function makeModelLogDouble() {
  const attempts = []
  return {
    attempts,
    begin: (purpose, route) => {
      const record = { purpose, route, done: [] }
      attempts.push(record)
      return {
        finish: async (outcome, detail = '') => {
          record.done.push(outcome, detail)
        },
      }
    },
    recent: () => [],
  }
}
