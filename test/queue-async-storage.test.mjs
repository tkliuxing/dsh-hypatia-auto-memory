import test from 'node:test'
import assert from 'node:assert/strict'

import { TaskDeferredError, createQueue } from '../src/queue.js'
import { EMPTY_PROGRESS, advanceProgress } from '../src/progress.js'

/**
 * A table double with the storage service's real write semantics: a write is
 * queued, and what `get` returns changes only once the (simulated) durable
 * write resolves. The rest of the suite uses synchronous Maps, which is exactly
 * why a queue that did not await its writes passed every test while freshly
 * enqueued immediate tasks never ran in a live profile.
 */
function asyncApplyTable(seed = {}) {
  const records = new Map(Object.entries(seed))
  let chain = Promise.resolve()
  const job = (fn) => {
    const result = chain.then(fn)
    chain = result.catch(() => {})
    return result
  }
  const io = () => new Promise((resolve) => setTimeout(resolve, 3))
  return {
    records,
    get: (key) => records.get(key),
    put: (key, value) => job(async () => { await io(); records.set(key, value) }),
    update: (key, fn) => job(async () => {
      await io()
      if (!records.has(key)) throw new Error(`no record '${key}' to update`)
      const next = fn(records.get(key))
      records.set(key, next)
      return next
    }),
    delete: (key) => job(async () => { await io(); return records.delete(key) }),
    entries: () => records.entries(),
  }
}

const silent = { info: () => {}, warn: () => {}, error: () => {}, count: () => {} }
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))
const config = (overrides = {}) => () => ({ concurrency: 1, maxAttempts: 3, retryDelayMs: 5, flushWindowMs: 0, ...overrides })

test('a freshly enqueued immediate task runs', async () => {
  // The live failure: session-node, consolidate and cascade tasks all enqueue
  // immediately under a new id; `runTask` looked the id up before the write had
  // landed, found nothing, and returned. The task sat `pending` forever.
  const table = asyncApplyTable()
  const ran = []
  const queue = createQueue({
    tasks: table,
    getConfig: config({ flushWindowMs: 120_000 }),
    executors: { 'session-node': async (task) => { ran.push([task.fromSeq, task.toSeq]) } },
    status: silent,
  })
  await queue.enqueue({ kind: 'session-node', sessionId: 's', fromSeq: 13, toSeq: 14, project: 'p', immediate: true })
  await settle()
  assert.deepEqual(ran, [[13, 14]])
  assert.equal(table.get('session-node:s'), undefined, 'done and removed')
})

test('enqueue resolves only once its record is readable', async () => {
  const table = asyncApplyTable()
  const queue = createQueue({ tasks: table, getConfig: config({ flushWindowMs: 120_000 }), executors: {}, status: silent })
  await queue.enqueue({ kind: 'log-message', sessionId: 's', fromSeq: 0, toSeq: 4, project: 'p' })
  assert.deepEqual([table.get('log-message:s')?.fromSeq, table.get('log-message:s')?.toSeq], [0, 4])
  await queue.dispose()
})

test('interleaved enqueues of one id both land in its range', async () => {
  // Unchained, both would see "no record" and both `put`, the later write
  // discarding the earlier range.
  const table = asyncApplyTable()
  const queue = createQueue({ tasks: table, getConfig: config({ flushWindowMs: 120_000 }), executors: {}, status: silent })
  await Promise.all([
    queue.enqueue({ kind: 'log-message', sessionId: 's', fromSeq: 0, toSeq: 9, project: 'p' }),
    queue.enqueue({ kind: 'log-message', sessionId: 's', fromSeq: 0, toSeq: 4, project: 'p' }),
  ])
  assert.deepEqual([table.get('log-message:s').fromSeq, table.get('log-message:s').toSeq], [0, 9])
  await queue.dispose()
})

test('work absorbed mid-run still runs as a follow-up', async () => {
  const table = asyncApplyTable()
  const seen = []
  let release
  const queue = createQueue({
    tasks: table,
    getConfig: config(),
    executors: {
      'log-message': async (task) => {
        seen.push([task.fromSeq, task.toSeq])
        if (seen.length === 1) await new Promise((resolve) => { release = resolve })
      },
    },
    status: silent,
  })
  await queue.enqueue({ kind: 'log-message', sessionId: 's', fromSeq: 0, toSeq: 2, project: 'p' })
  await settle(30)
  await queue.enqueue({ kind: 'log-message', sessionId: 's', fromSeq: 2, toSeq: 5, project: 'p' })
  release()
  await settle()
  assert.deepEqual(seen, [[0, 2], [2, 5]])
  assert.equal(table.get('log-message:s'), undefined)
})

test('a deferred task resumes when its session returns', async () => {
  const table = asyncApplyTable()
  let available = false
  let calls = 0
  const queue = createQueue({
    tasks: table,
    getConfig: config(),
    executors: {
      consolidate: async () => {
        calls += 1
        if (!available) throw new TaskDeferredError('not loaded')
      },
    },
    status: silent,
  })
  await queue.enqueue({ kind: 'consolidate', sessionId: 's', fromSeq: 0, toSeq: 5, project: 'p', immediate: true })
  await settle()
  assert.equal(table.get('consolidate:s').status, 'deferred')
  available = true
  queue.resumeSession('s')
  await settle()
  assert.equal(calls, 2)
  assert.equal(table.get('consolidate:s'), undefined)
})

test('pruneFailed resolves after the records are gone', async () => {
  const table = asyncApplyTable({
    'log-message:a': { kind: 'log-message', sessionId: 'a', status: 'failed', fromSeq: 0, toSeq: 1, attempts: 3, error: 'x' },
  })
  const queue = createQueue({ tasks: table, getConfig: config(), executors: {}, status: silent })
  assert.equal(await queue.pruneFailed(['log-message']), 1)
  assert.equal(table.get('log-message:a'), undefined)
})

test('concurrent progress updates of one session keep every field', async () => {
  // Unchained, the second read-modify-write read the record before the first
  // had landed and wrote it back, reverting the first writer's field.
  const table = asyncApplyTable()
  await Promise.all([
    advanceProgress(table, 's', () => ({ lastLoggedSeq: 120 })),
    advanceProgress(table, 's', () => ({ lastCheckTurn: 7 })),
    advanceProgress(table, 's', (current) => ({ pendingTokens: current.pendingTokens + 50 })),
    advanceProgress(table, 's', (current) => ({ pendingTokens: current.pendingTokens + 25 })),
  ])
  assert.deepEqual(table.get('s'), { ...EMPTY_PROGRESS, lastLoggedSeq: 120, lastCheckTurn: 7, pendingTokens: 75 })
})

test('a legacy progress row is filled from the defaults before a patch reads it', async () => {
  const table = asyncApplyTable({ s: { lastLoggedSeq: 10, lastConsolidatedSeq: 0, lastCheckTurn: 0, pendingTokens: 0 } })
  await advanceProgress(table, 's', (current) => ({ lastBelongToIndex: current.lastBelongToIndex + 3 }))
  assert.equal(table.get('s').lastBelongToIndex, 3, 'not NaN from undefined + 3')
  assert.equal(table.get('s').hasSessionNode, 0)
})
