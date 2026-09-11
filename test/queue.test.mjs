import test from 'node:test'
import assert from 'node:assert/strict'

import { createQueue } from '../src/queue.js'

/** Map-backed storageDomain table double. */
function makeTable(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    get: (k) => map.get(k),
    put: (k, v) => void map.set(k, v),
    update: (k, fn) => {
      const next = fn(map.get(k))
      map.set(k, next)
    },
    delete: (k) => void map.delete(k),
    dump: () => [...map.entries()],
    entries: () => map.entries(),
    map,
  }
}

function makeStatus() {
  const lines = []
  return {
    lines,
    info: (m) => lines.push(['info', m]),
    warn: (m) => lines.push(['warn', m]),
    error: (m) => lines.push(['error', m]),
    count: () => {},
  }
}

const CONFIG = { concurrency: 2, maxAttempts: 3, retryDelayMs: 5, flushWindowMs: 0 }

test('coalesces same-session tasks into one run and keeps sessions separate', async () => {
  const runs = []
  const queue = createQueue({
    tasks: makeTable(),
    getConfig: () => CONFIG,
    executors: {
      'log-message': async (task) => {
        runs.push(task)
      },
    },
    status: makeStatus(),
  })
  await queue.enqueue({ kind: 'log-message', sessionId: 'a', fromSeq: 0, toSeq: 1, project: 'p' })
  await queue.enqueue({ kind: 'log-message', sessionId: 'a', fromSeq: 1, toSeq: 2, project: 'p' })
  await queue.enqueue({ kind: 'log-message', sessionId: 'b', fromSeq: 0, toSeq: 1, project: 'p' })
  await new Promise((r) => setTimeout(r, 30))
  // 'a' merged into ONE task covering [0, 2); 'b' ran its own task.
  assert.equal(runs.length, 2)
  const a = runs.find((t) => t.sessionId === 'a')
  const b = runs.find((t) => t.sessionId === 'b')
  assert.deepEqual([a.fromSeq, a.toSeq], [0, 2])
  assert.deepEqual([b.fromSeq, b.toSeq], [0, 1])
})

test('keeps per-session task order on the chain', async () => {
  const order = []
  let releaseFirst
  const gate = new Promise((r) => { releaseFirst = r })
  const queue = createQueue({
    tasks: makeTable(),
    getConfig: () => ({ ...CONFIG, flushWindowMs: 1 }),
    executors: {
      'log-message': async (task) => {
        if (order.length === 0) await gate // hold the first 'a' task open
        order.push(task.sessionId)
      },
      consolidate: async (task) => {
        order.push(task.sessionId)
      },
    },
    status: makeStatus(),
  })
  // Use distinct kinds so tasks are not coalesced into one record.
  await queue.enqueue({ kind: 'log-message', sessionId: 'a', fromSeq: 0, toSeq: 1, project: 'p' })
  await queue.enqueue({ kind: 'consolidate', sessionId: 'a', fromSeq: 0, toSeq: 5, project: 'p' })
  await new Promise((r) => setTimeout(r, 10))
  releaseFirst()
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(order, ['a', 'a'])
})

test('coalesces adjacent ranges of the same session into one task', async () => {
  const ran = []
  const table = makeTable()
  const queue = createQueue({
    tasks: table,
    getConfig: () => ({ ...CONFIG, flushWindowMs: 30 }),
    executors: { 'log-message': async (t) => ran.push([t.fromSeq, t.toSeq]) },
    status: makeStatus(),
  })
  await queue.enqueue({ kind: 'log-message', sessionId: 'a', fromSeq: 0, toSeq: 1, project: 'p' })
  await queue.enqueue({ kind: 'log-message', sessionId: 'a', fromSeq: 1, toSeq: 2, project: 'p' })
  await queue.enqueue({ kind: 'log-message', sessionId: 'a', fromSeq: 2, toSeq: 3, project: 'p' })
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(ran.length, 1)
  assert.deepEqual(ran[0], [0, 3])
  assert.equal(table.dump().length, 0, 'finished task deleted')
})

test('retries transient failures then succeeds', async () => {
  let attempts = 0
  const table = makeTable()
  const queue = createQueue({
    tasks: table,
    getConfig: () => CONFIG,
    executors: {
      'log-message': async () => {
        attempts += 1
        if (attempts < 3) throw new Error('transient')
      },
    },
    status: makeStatus(),
  })
  await queue.enqueue({ kind: 'log-message', sessionId: 'a', fromSeq: 0, toSeq: 1, project: 'p' })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(attempts, 3)
  assert.equal(table.dump().length, 0)
})

test('permanent failures skip retries and stay failed', async () => {
  const err = new Error('bad output')
  err.permanent = true
  const table = makeTable()
  const queue = createQueue({
    tasks: table,
    getConfig: () => CONFIG,
    executors: { consolidate: async () => { throw err } },
    status: makeStatus(),
  })
  await queue.enqueue({ kind: 'consolidate', sessionId: 'a', fromSeq: 0, toSeq: 5, project: 'p' })
  await new Promise((r) => setTimeout(r, 50))
  const record = table.get('consolidate:a')
  assert.equal(record.status, 'failed')
  assert.equal(record.attempts, CONFIG.maxAttempts)
  assert.ok(record.error.includes('bad output'))
})

test('exhausted retries mark the task failed', async () => {
  const table = makeTable()
  const queue = createQueue({
    tasks: table,
    getConfig: () => ({ ...CONFIG, maxAttempts: 2 }),
    executors: { 'log-message': async () => { throw new Error('always down') } },
    status: makeStatus(),
  })
  await queue.enqueue({ kind: 'log-message', sessionId: 'a', fromSeq: 0, toSeq: 1, project: 'p' })
  await new Promise((r) => setTimeout(r, 60))
  const record = table.get('log-message:a')
  assert.equal(record.status, 'failed')
  assert.equal(record.attempts, 2)
})

test('dispose waits for in-flight work and refuses new tasks', async () => {
  let finished = false
  const queue = createQueue({
    tasks: makeTable(),
    getConfig: () => CONFIG,
    executors: {
      'log-message': async () => {
        await new Promise((r) => setTimeout(r, 30))
        finished = true
      },
    },
    status: makeStatus(),
  })
  await queue.enqueue({ kind: 'log-message', sessionId: 'a', fromSeq: 0, toSeq: 1, project: 'p' })
  await queue.dispose()
  assert.equal(finished, true)
  await queue.enqueue({ kind: 'log-message', sessionId: 'a', fromSeq: 1, toSeq: 2, project: 'p' })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(finished, true, 'no new work after dispose')
})

test('boot backfill reuses the same task id (crash convergence)', async () => {
  const ran = []
  const table = makeTable({
    'log-message:a': {
      kind: 'log-message', sessionId: 'a', fromSeq: 0, toSeq: 2,
      project: 'p', status: 'running', attempts: 0, enqueuedAt: 0,
    },
  })
  const queue = createQueue({
    tasks: table,
    getConfig: () => CONFIG,
    executors: { 'log-message': async (t) => ran.push(t.toSeq) },
    status: makeStatus(),
  })
  // Backfill enqueues the uncovered range under the same id; the stale
  // 'running' record is absorbed and the merged range runs once.
  await queue.enqueue({ kind: 'log-message', sessionId: 'a', fromSeq: 0, toSeq: 5, project: 'p' })
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(ran, [5])
})

test('honours the cross-session concurrency ceiling', async () => {
  // `release()` hands the freed slot to exactly one waiter. An extra blanket
  // wake-up alongside it resolved every queued waiter at once, so a configured
  // ceiling of 1 ran three hypatia CLI spawns at a time.
  let inflight = 0
  let peak = 0
  const queue = createQueue({
    tasks: makeTable(),
    getConfig: () => ({ ...CONFIG, concurrency: 1 }),
    executors: {
      'log-message': async () => {
        inflight += 1
        peak = Math.max(peak, inflight)
        await new Promise((r) => setTimeout(r, 20))
        inflight -= 1
      },
    },
    status: makeStatus(),
  })
  for (const sessionId of ['a', 'b', 'c', 'd']) {
    await queue.enqueue({ kind: 'log-message', sessionId, fromSeq: 0, toSeq: 1, project: 'p' })
  }
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(peak, 1, `peak inflight was ${peak}`)
})

test('re-runs a range absorbed while the task was executing', async () => {
  // `enqueue` widens a running task's record but cannot schedule it (the id is
  // already marked scheduled). Deleting the record on success therefore dropped
  // the absorbed range — and because the log executor advances its watermark
  // past what it did cover, boot backfill could not recover the gap either.
  const table = makeTable()
  const seen = []
  let release
  const queue = createQueue({
    tasks: table,
    getConfig: () => ({ ...CONFIG, concurrency: 1, flushWindowMs: 5 }),
    executors: {
      'log-message': async (task) => {
        seen.push([task.fromSeq, task.toSeq])
        if (seen.length === 1) await new Promise((r) => { release = r })
      },
    },
    status: makeStatus(),
  })

  await queue.enqueue({ kind: 'log-message', sessionId: 's1', fromSeq: 0, toSeq: 1, project: 'p' })
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(seen, [[0, 1]], 'first task is mid-flight')

  await queue.enqueue({ kind: 'log-message', sessionId: 's1', fromSeq: 1, toSeq: 2, project: 'p' })
  await queue.enqueue({ kind: 'log-message', sessionId: 's1', fromSeq: 2, toSeq: 3, project: 'p' })
  release()
  await new Promise((r) => setTimeout(r, 80))

  assert.deepEqual(seen, [[0, 1], [1, 3]], 'absorbed tail ran as a follow-up')
  assert.equal(table.get('log-message:s1'), undefined, 'record cleared once fully covered')
})

test('a backfill reaching under a running task re-runs the widened range', async () => {
  const table = makeTable()
  const seen = []
  let release
  const queue = createQueue({
    tasks: table,
    getConfig: () => ({ ...CONFIG, concurrency: 1, flushWindowMs: 5 }),
    executors: {
      'log-message': async (task) => {
        seen.push([task.fromSeq, task.toSeq])
        if (seen.length === 1) await new Promise((r) => { release = r })
      },
    },
    status: makeStatus(),
  })

  await queue.enqueue({ kind: 'log-message', sessionId: 's1', fromSeq: 10, toSeq: 12, project: 'p' })
  await new Promise((r) => setTimeout(r, 30))
  await queue.enqueue({ kind: 'log-message', sessionId: 's1', fromSeq: 4, toSeq: 12, project: 'p' })
  release()
  await new Promise((r) => setTimeout(r, 80))

  // Writes are get-before-create, so replaying the overlap converges.
  assert.deepEqual(seen, [[10, 12], [4, 12]])
})

test('registering an executor resumes the backlog of its kind', async () => {
  // A consolidate / cascade / session-node record carries its own range, and
  // nothing re-derived it: a restart between persisting and running one left it
  // in the table until some later trigger happened to reuse its id.
  const table = makeTable({
    'consolidate:a': { kind: 'consolidate', sessionId: 'a', fromSeq: 0, toSeq: 5, project: 'p', status: 'pending', attempts: 0, enqueuedAt: 0 },
    'consolidate:b': { kind: 'consolidate', sessionId: 'b', fromSeq: 0, toSeq: 5, project: 'p', status: 'running', attempts: 0, enqueuedAt: 0 },
    'consolidate:c': { kind: 'consolidate', sessionId: 'c', fromSeq: 0, toSeq: 5, project: 'p', status: 'failed', attempts: 3, enqueuedAt: 0 },
    'cascade:a': { kind: 'cascade', sessionId: 'a', fromSeq: 0, toSeq: 5, project: 'p', status: 'pending', attempts: 0, enqueuedAt: 0 },
  })
  const ran = []
  const queue = createQueue({ tasks: table, getConfig: () => CONFIG, status: makeStatus() })

  queue.registerExecutor('consolidate', async (task) => { ran.push(`consolidate:${task.sessionId}`) })
  await new Promise((resolve) => setTimeout(resolve, 20))

  // `running` at registration can only mean the previous process died mid-task.
  assert.deepEqual(ran.sort(), ['consolidate:a', 'consolidate:b'])
  assert.equal(table.get('consolidate:c').status, 'failed', 'failed tasks stay for inspection')
  assert.ok(table.get('cascade:a'), 'another kind waits for its own executor')

  queue.registerExecutor('cascade', async (task) => { ran.push(`cascade:${task.sessionId}`) })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(ran.includes('cascade:a'))
  assert.equal(table.get('cascade:a'), undefined)
})
