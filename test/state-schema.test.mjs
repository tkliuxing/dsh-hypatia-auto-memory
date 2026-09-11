import test from 'node:test'
import assert from 'node:assert/strict'

import { EMPTY_PROGRESS, advanceProgress, progressTable, taskTable } from '../src/state.js'
import { TaskDeferredError, createQueue } from '../src/queue.js'

/**
 * The storage service validates records when it READS them — at the next
 * startup — never when they are written. So a record the plugin writes today
 * that does not match its schema is a startup failure deferred to tomorrow.
 * This double applies that read-time check at write time and collects every
 * violation, so the suite fails where the plugin would have gone silent.
 */
function strictTable(spec) {
  const map = new Map()
  const violations = []
  const check = (key, value) => {
    const result = spec.valueSchema.safeParse(value)
    if (!result.success) violations.push({ key, issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
  }
  return {
    violations,
    map,
    get: (key) => map.get(key),
    put: (key, value) => { check(key, value); map.set(key, value); return Promise.resolve() },
    update: (key, fn) => {
      const next = fn(map.get(key))
      check(key, next)
      map.set(key, next)
      return Promise.resolve(next)
    },
    delete: (key) => Promise.resolve(map.delete(key)),
    entries: () => map.entries(),
  }
}

const silent = { info: () => {}, warn: () => {}, error: () => {}, count: () => {} }
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

test('every task record the queue writes would load back at the next startup', async () => {
  // A live profile went silent for a whole run: a freshly created task lacked
  // `error`, survived a restart, and failed validation when the domain opened.
  const table = strictTable(taskTable)
  let release
  let flakyCalls = 0
  const queue = createQueue({
    tasks: table,
    getConfig: () => ({ concurrency: 1, maxAttempts: 2, retryDelayMs: 5, flushWindowMs: 0 }),
    executors: {
      'log-message': async (task) => {
        if (task.sessionId === 'slow' && release === undefined) await new Promise((resolve) => { release = resolve })
      },
      consolidate: async (task) => {
        if (task.sessionId === 'flaky') { flakyCalls += 1; throw new Error('model route down') }
        throw new TaskDeferredError(`session ${task.sessionId} is not loaded`)
      },
    },
    status: silent,
  })

  // new -> running -> done
  await queue.enqueue({ kind: 'log-message', sessionId: 'plain', fromSeq: 0, toSeq: 3, project: 'p' })
  // new -> running, absorbs more work mid-run -> follow-up
  await queue.enqueue({ kind: 'log-message', sessionId: 'slow', fromSeq: 0, toSeq: 2, project: 'p' })
  await settle()
  await queue.enqueue({ kind: 'log-message', sessionId: 'slow', fromSeq: 2, toSeq: 5, project: 'p' })
  release()
  // new -> retried -> failed
  await queue.enqueue({ kind: 'consolidate', sessionId: 'flaky', fromSeq: 0, toSeq: 9, project: 'p' })
  // new -> deferred
  await queue.enqueue({ kind: 'consolidate', sessionId: 'unloaded', fromSeq: 0, toSeq: 9, project: 'p' })
  await settle(80)

  assert.equal(flakyCalls, 2, 'the retry path was exercised')
  assert.equal(table.get('consolidate:flaky').status, 'failed')
  assert.equal(table.get('consolidate:unloaded').status, 'deferred')
  assert.deepEqual(table.violations, [], 'a record that would stop the domain from opening')
})

test('a task row written without `error` still loads, as null', () => {
  // The exact row that took the plugin down in a live profile.
  const row = {
    kind: 'log-message',
    sessionId: 'session-41dceef6-9148-4f27-a3f2-ba4f2915f9dc',
    fromSeq: 1898,
    toSeq: 3953,
    project: 'hypatia',
    status: 'pending',
    attempts: 0,
    enqueuedAt: 1789094349000,
  }
  const parsed = taskTable.valueSchema.parse(row)
  assert.equal(parsed.error, null)
})

test('progress rows written today, and by older builds, load', () => {
  assert.deepEqual(progressTable.valueSchema.parse(EMPTY_PROGRESS), EMPTY_PROGRESS)

  // A row from before `hasSessionNode` / `lastBelongToIndex` existed.
  const legacy = progressTable.valueSchema.parse({
    lastLoggedSeq: 65723, lastConsolidatedSeq: 45712, lastCheckTurn: 20, pendingTokens: 0,
  })
  assert.equal(legacy.hasSessionNode, 0)
  assert.equal(legacy.lastBelongToIndex, 0)

  const table = strictTable(progressTable)
  advanceProgress(table, 's1', () => ({ lastLoggedSeq: 12 }))
  advanceProgress(table, 's1', (current) => ({ hasSessionNode: 1, lastBelongToIndex: current.lastBelongToIndex + 3 }))
  assert.deepEqual(table.violations, [])
})
