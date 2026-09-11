/**
 * Persistent work queue for auto-memory tasks.
 *
 * Design properties:
 * - Durable before scheduled: every task is written to the state domain
 *   before any timer starts, so a crash never loses an accepted unit of work.
 * - Per-session ordering: tasks of one session run on one promise chain;
 *   cross-session concurrency is bounded by `queue.concurrency`.
 * - Coalescing: a pending task absorbs adjacent ranges of the same
 *   (kind, session), collapsing burst writes into fewer runs.
 * - Crash convergence: executors are idempotent (get-before-create writer),
 *   and backfill re-enqueues unfinished ranges under the same task id, so a
 *   replay converges instead of duplicating.
 * - Deferral: an executor that cannot run yet throws `TaskDeferredError`; the
 *   task waits as `deferred`, spending no attempts, until `resumeSession`.
 * - Dispose: timers cleared, in-flight chains awaited up to a deadline;
 *   everything not finished stays durable for the next boot.
 *
 * @module dsh-hypatia-auto-memory/queue
 */

const DISPOSE_DEADLINE_MS = 5000

/**
 * Thrown by an executor that cannot run YET — typically because the session it
 * reads from is not loaded — as opposed to one that failed.
 *
 * The remedy differs, so the signal must too. A timed retry is the right answer
 * to a flaky CLI call and the wrong one here: DSH loads sessions lazily, so a
 * session that is not live now may stay that way for hours, and three retries
 * five seconds apart only stamped `failed` on work that was never attempted. A
 * deferred task keeps its attempt count, holds no timer, and is scheduled again
 * by `resumeSession` when its session next appears.
 */
export class TaskDeferredError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TaskDeferredError'
    this.deferred = true
  }
}

/**
 * @param {{
 *   tasks: any,                 // storageDomain tasks table
 *   getConfig: () => {concurrency: number, maxAttempts: number, retryDelayMs: number, flushWindowMs: number},
 *   executors: Record<string, (task: any) => Promise<void>>,
 *   status: import('./status.js').StatusLog,
 *   now?: () => number,
 * }} deps
 */
export function createQueue({ tasks, getConfig, executors = {}, status, now = Date.now }) {
  /** @type {Map<string, Promise<void>>} one chain per session */
  const chains = new Map()
  /** @type {Map<string, NodeJS.Timeout>} flush-window timers, key = task id */
  const timers = new Map()
  /** @type {Set<string>} task ids currently on a chain */
  const scheduled = new Set()
  /** @type {Set<string>} ids that absorbed new work mid-run and must run again */
  const followups = new Set()
  let running = 0
  let waiters = []
  let disposed = false

  const taskId = (kind, sessionId) => `${kind}:${sessionId}`

  /**
   * Take one of the `concurrency` slots.
   * @returns {Promise<boolean>} true when a slot was granted; false when dispose
   * cancelled the wait, in which case the caller must NOT release.
   */
  const acquire = () => new Promise((resolve) => {
    // Deliberately NOT short-circuiting on `disposed`: dispose's contract is to
    // await in-flight work, and a task already on a chain counts as in-flight.
    // Only waiters still queued for a slot are cancelled, by `cancelWaiters`.
    if (running < getConfig().concurrency) {
      running += 1
      resolve(true)
      return
    }
    waiters.push((granted) => {
      if (granted) running += 1
      resolve(granted)
    })
  })

  /** Hand the freed slot to exactly one waiter — never more. */
  const release = () => {
    running -= 1
    const next = waiters.shift()
    if (next) next(true)
  }

  /** Dispose only: drop every queued waiter without granting it a slot. */
  const cancelWaiters = () => {
    const pending = waiters
    waiters = []
    for (const waiter of pending) waiter(false)
  }

  /** @type {Map<string, Promise<string>>} in-flight persist per task id */
  const persisting = new Map()

  /**
   * Load-or-create the durable record, absorbing the range into an existing
   * pending task of the same (kind, session) when present.
   *
   * Two properties of the storage table shape this:
   *
   * - A write lands in memory only once it is durable: `put`/`update` queue the
   *   write and resolve after it, and `get` sees nothing until then. Returning
   *   before the write landed let `runTask` look the id up, find nothing, and
   *   return — a freshly enqueued immediate task silently never ran and sat in
   *   the table as `pending`. Every write here is awaited.
   * - Two enqueues of one id interleaving would each see "no record" and each
   *   `put`, the later one discarding the earlier range. Persists of one id are
   *   therefore chained.
   *
   * @returns {Promise<string>} the task id, once its record is readable.
   */
  function persistTask(spec) {
    const id = taskId(spec.kind, spec.sessionId)
    const previous = persisting.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => writeTask(id, spec))
    persisting.set(id, next)
    next.catch(() => {}).finally(() => {
      if (persisting.get(id) === next) persisting.delete(id)
    })
    return next
  }

  async function writeTask(id, spec) {
    const existing = tasks.get(id)
    if (existing !== undefined && existing.status !== 'failed') {
      await tasks.update(id, (t) => ({
        ...t,
        fromSeq: Math.min(t.fromSeq, spec.fromSeq),
        toSeq: Math.max(t.toSeq, spec.toSeq),
        project: spec.project || t.project,
      }))
      return id
    }
    await tasks.put(id, {
      kind: spec.kind,
      sessionId: spec.sessionId,
      fromSeq: spec.fromSeq,
      toSeq: spec.toSeq,
      project: spec.project,
      status: 'pending',
      attempts: 0,
      // Written explicitly: the stored schema requires the key, and the storage
      // service only checks that on the next read — i.e. at the next startup.
      error: null,
      enqueuedAt: now(),
    })
    return id
  }

  /** Schedule one persisted task onto its session chain. */
  function schedule(id) {
    if (disposed || scheduled.has(id)) return
    scheduled.add(id)
    const sessionId = id.slice(id.indexOf(':') + 1)
    const prev = chains.get(sessionId) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => runTask(id))
      .finally(() => {
        scheduled.delete(id)
        if (chains.get(sessionId) === next) chains.delete(sessionId)
        // Re-schedule only AFTER leaving `scheduled`, otherwise the guard at the
        // top of this function would swallow the follow-up run.
        if (followups.delete(id)) schedule(id)
      })
    chains.set(sessionId, next)
  }

  /** Load, execute with retry bookkeeping, and settle one task. */
  async function runTask(id) {
    const record = tasks.get(id)
    if (record === undefined || record.status === 'failed') return
    const executor = executors[record.kind]
    if (executor === undefined) {
      status.error(`no executor for task kind "${record.kind}"`, new Error(id))
      return
    }
    if ((await acquire()) === false) return
    try {
      await tasks.update(id, (t) => ({ ...t, status: 'running' }))
      try {
        const snapshot = tasks.get(id)
        await executor(snapshot)
        // `enqueue` widens a running task's range in place, but cannot schedule
        // it (the id is already in `scheduled`). Deleting unconditionally here
        // therefore discarded everything that arrived mid-run — and because the
        // log executor advances its watermark past what it DID cover, the gap
        // became unreachable to boot backfill too. Compare before deleting.
        const latest = tasks.get(id)
        const grewForward = latest !== undefined && latest.toSeq > snapshot.toSeq
        const grewBackward = latest !== undefined && latest.fromSeq < snapshot.fromSeq
        if (grewForward || grewBackward) {
          await tasks.update(id, (t) => ({
            ...t,
            // Forward growth re-runs only the uncovered tail. Backward growth
            // (a backfill reaching under this task) re-runs the whole widened
            // range; writes are get-before-create, so replay converges.
            fromSeq: grewBackward ? latest.fromSeq : snapshot.toSeq,
            status: 'pending',
            attempts: 0,
            error: null,
          }))
          followups.add(id)
        } else {
          await tasks.delete(id)
        }
        status.count('tasksDone')
      } catch (error) {
        if (error?.deferred === true) {
          await tasks.update(id, (t) => ({
            ...t,
            status: 'deferred',
            error: error instanceof Error ? error.message : String(error),
          }))
          status.info(`task ${id} deferred: ${error.message}`)
          return
        }
        // Permanent failures (e.g. malformed model output) get no retries —
        // re-running an unhealable task only wedges the session chain.
        const attempts = error?.permanent === true
          ? getConfig().maxAttempts
          : (tasks.get(id)?.attempts ?? record.attempts) + 1
        const config = getConfig()
        if (attempts < config.maxAttempts) {
          await tasks.update(id, (t) => ({
            ...t,
            status: 'pending',
            attempts,
            error: error instanceof Error ? error.message : String(error),
          }))
          status.warn(`task ${id} failed (attempt ${attempts}), retrying: ${String(error)}`)
          setTimer(id, () => schedule(id), config.retryDelayMs)
        } else {
          await tasks.update(id, (t) => ({
            ...t,
            status: 'failed',
            attempts,
            error: error instanceof Error ? error.message : String(error),
          }))
          status.count('tasksFailed')
          status.error(`task ${id} failed permanently after ${attempts} attempts`, error)
        }
      }
    } finally {
      release()
    }
  }

  function setTimer(id, fn, delay) {
    if (disposed) return
    const timer = setTimeout(() => {
      timers.delete(id)
      fn()
    }, delay)
    timers.set(id, timer)
  }

  /**
   * Schedule every persisted, unfinished task of one kind.
   *
   * Log ranges were always recoverable from the watermarks, but a pending
   * consolidate / cascade / session-node record carries its own range and
   * nothing re-derived it: a restart between persisting one and running it left
   * it sitting in the table until some later trigger happened to reuse its id.
   * `running` is included on purpose — seen at registration it can only mean
   * the previous process died mid-task. `failed` stays put for inspection, and
   * `deferred` waits for its session to come back (see `resumeSession`).
   */
  function resumeKind(kind) {
    if (typeof tasks.entries !== 'function') return
    for (const [id, record] of tasks.entries()) {
      if (record?.kind !== kind || record.status === 'failed' || record.status === 'deferred') continue
      schedule(id)
    }
  }

  return {
    /**
     * Register or replace the executor for one task kind (late binding), and
     * resume any backlog of that kind a previous process left persisted.
     *
     * Executors attach at different times — `consolidate` and `cascade` only
     * once the `llm` service arrives — so resuming per kind, at registration, is
     * what guarantees a task is never scheduled before something can run it.
     */
    registerExecutor(kind, executor) {
      executors[kind] = executor
      resumeKind(kind)
    },

    /**
     * Accept one unit of work: persist, then run after the flush window
     * (which coalesces bursts). Resolves once the durable record exists.
     */
    async enqueue(spec) {
      if (disposed) return
      const id = await persistTask(spec)
      // `immediate` skips the coalescing window for a span that is already known
      // to be complete — a finished turn, or a session shutting down. Waiting
      // would only delay it, and for a turn it risks the next arrival splitting
      // a span that must stay whole.
      const window = spec.immediate === true ? 0 : getConfig().flushWindowMs
      if (spec.immediate === true) {
        const pending = timers.get(id)
        if (pending !== undefined) {
          clearTimeout(pending)
          timers.delete(id)
        }
      }
      if (window > 0 && !scheduled.has(id)) {
        if (!timers.has(id)) {
          setTimer(id, () => schedule(id), window)
        }
      } else {
        schedule(id)
      }
    },

    /** Resume every unfinished task whose kind currently has an executor. */
    async requeueAll() {
      for (const kind of Object.keys(executors)) resumeKind(kind)
    },

    /** One task currently persisted for (kind, session), if any. */
    peek(kind, sessionId) {
      return tasks.get(taskId(kind, sessionId))
    },

    /**
     * Schedule every deferred task of one session — called when the session
     * becomes live again, which is the only thing a deferred task waits for.
     * @param {string} sessionId
     * @returns {number} how many tasks were resumed.
     */
    resumeSession(sessionId) {
      if (typeof tasks.entries !== 'function') return 0
      const ids = []
      for (const [id, record] of tasks.entries()) {
        if (record?.sessionId === sessionId && record.status === 'deferred') ids.push(id)
      }
      for (const id of ids) schedule(id)
      return ids.length
    },

    /**
     * Delete `failed` records of the given kinds.
     *
     * Only for kinds whose work is fully re-derivable from progress watermarks:
     * a failed `log-message` never advanced `lastLoggedSeq`, so that session's
     * next flush covers the same range anyway, and the record carries nothing
     * but an error message. Called once at startup, so the message survives for
     * the whole run that produced it.
     * @param {readonly string[]} kinds
     * @returns {Promise<number>} how many records were removed, once removed.
     */
    async pruneFailed(kinds) {
      if (typeof tasks.entries !== 'function') return 0
      const ids = []
      for (const [id, record] of tasks.entries()) {
        if (record?.status === 'failed' && kinds.includes(record.kind)) ids.push(id)
      }
      for (const id of ids) await tasks.delete(id)
      return ids.length
    },

    /** Every session id that currently owns at least one task record. */
    sessionIds() {
      const ids = new Set()
      if (typeof tasks.entries !== 'function') return ids
      for (const [, record] of tasks.entries()) {
        if (typeof record?.sessionId === 'string') ids.add(record.sessionId)
      }
      return ids
    },

    /**
     * Drop every task of one session — for a session that no longer exists, whose
     * work could never run again and would otherwise wait forever as `deferred`.
     * A task already executing is left to finish.
     * @param {string} sessionId
     * @returns {Promise<number>} how many records were removed.
     */
    async forgetSession(sessionId) {
      if (typeof tasks.entries !== 'function') return 0
      const ids = []
      for (const [id, record] of tasks.entries()) {
        if (record?.sessionId !== sessionId) continue
        if (record.status === 'running' || scheduled.has(id)) continue
        ids.push(id)
      }
      for (const id of ids) {
        const timer = timers.get(id)
        if (timer !== undefined) {
          clearTimeout(timer)
          timers.delete(id)
        }
        await tasks.delete(id)
      }
      return ids.length
    },

    /**
     * Resolve once this session has no work left in flight.
     *
     * Used to decide when a disposed session's object can be released: its
     * executors still need `snapshotEvents` from it, and the store has already
     * let go. Waiting on the chain alone is not enough — a task sitting on a
     * retry timer holds no chain — so pending records are checked too.
     *
     * @param {string} sessionId
     * @param {{timeoutMs?: number, kinds?: readonly string[]}} [options]
     */
    async whenIdle(sessionId, { timeoutMs = 60_000, kinds = ['log-message', 'consolidate'] } = {}) {
      const deadline = now() + timeoutMs
      while (now() < deadline) {
        const chain = chains.get(sessionId)
        if (chain !== undefined) {
          await chain.catch(() => {})
          continue
        }
        const outstanding = kinds.some((kind) => {
          const record = tasks.get(taskId(kind, sessionId))
          // Deferred work cannot run until its session is back, so it is not
          // something to wait for here.
          return record !== undefined && record.status !== 'failed' && record.status !== 'deferred'
        })
        if (!outstanding) return true
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return false
    },

    pendingCount() {
      return scheduled.size + timers.size + followups.size
    },

    /** Stop accepting work; await in-flight up to the deadline. */
    async dispose() {
      disposed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      const pending = [...chains.values()]
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => setTimeout(resolve, DISPOSE_DEADLINE_MS)),
      ])
      chains.clear()
      scheduled.clear()
      followups.clear()
      cancelWaiters()
    },
  }
}
