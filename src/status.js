/**
 * Aggregated operational status: structured log lines plus counters that the
 * README's ops checklist (and any future settings card) can read. Deliberately
 * in-memory — durable facts (watermarks, failed tasks) live in the state
 * domain; this is the live dashboard layer.
 *
 * @module dsh-hypatia-auto-memory/status
 */

export function createStatus(ctx, label = 'hypatia-auto-memory') {
  let log
  const counters = new Map()
  let lastError = ''
  let lastConsolidatedAt = 0

  const logger = () => {
    if (log === undefined) {
      try {
        log = ctx.logger(label)
      } catch {
        log = { info: () => {}, warn: () => {}, error: () => {} }
      }
    }
    return log
  }

  return {
    info(message) {
      logger().info(message)
    },
    warn(message) {
      logger().warn(message)
    },
    error(message, error) {
      lastError = error instanceof Error ? `${message}: ${error.message}` : `${message}: ${String(error)}`
      logger().error(lastError)
    },
    /** Bump one counter ('written' | 'duplicate' | 'failed' | ...). */
    count(name, by = 1) {
      counters.set(name, (counters.get(name) ?? 0) + by)
    },
    markConsolidated() {
      lastConsolidatedAt = Date.now()
    },
    snapshot() {
      return {
        counters: Object.fromEntries(counters),
        lastError,
        lastConsolidatedAt,
      }
    },
  }
}
