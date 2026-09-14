import test from 'node:test'
import assert from 'node:assert/strict'

import { backfillConsolidation, pruneVanishedSessions, reconcileProgress } from '../src/housekeeping.js'
import { EMPTY_PROGRESS } from '../src/progress.js'

function progressTable(seed) {
  const map = new Map(Object.entries(seed))
  return {
    map,
    get: (key) => map.get(key),
    put: (key, value) => { map.set(key, value); return Promise.resolve() },
    delete: (key) => Promise.resolve(map.delete(key)),
    entries: () => map.entries(),
  }
}

const row = (overrides = {}) => ({ ...EMPTY_PROGRESS, lastLoggedSeq: 500, lastConsolidatedSeq: 300, lastCheckTurn: 4, ...overrides })
const quiet = () => {
  const lines = []
  return { lines, info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]), error: () => {}, count: () => {} }
}

test('reconcile resets a row whose session has no entry left in the shelf', async () => {
  // A live profile: the shelf had been replaced, and 7 of 10 rows still claimed
  // work that no longer existed — so those sessions would never be logged again.
  const progress = progressTable({ gone: row(), kept: row() })
  const cli = { query: async (jse) => (jse.includes('msg-kept-') ? [{ name: 'msg-kept-0' }] : []) }
  const result = await reconcileProgress({ progress, cli, status: quiet() })

  assert.deepEqual(result.reset, ['gone'])
  assert.deepEqual(progress.get('gone'), EMPTY_PROGRESS, 'fully reset: re-logged and re-consolidated from the start')
  assert.deepEqual(progress.get('kept'), row(), 'untouched')
})

test('reconcile leaves a row alone when the shelf cannot be asked', async () => {
  // A failed query proves nothing about the shelf. Treating it as "empty" would
  // reset every row whenever hypatia or its database was briefly unavailable.
  const progress = progressTable({ s: row() })
  const status = quiet()
  const cli = { query: async () => { throw new Error('connection refused') } }
  const result = await reconcileProgress({ progress, cli, status })

  assert.deepEqual(result.reset, [])
  assert.equal(result.unverified, 1)
  assert.deepEqual(progress.get('s'), row())
  assert.match(status.lines[0][1], /skipped s: shelf query failed/)
})

test('reconcile ignores rows that never logged anything', async () => {
  let asked = 0
  const progress = progressTable({ fresh: { ...EMPTY_PROGRESS } })
  await reconcileProgress({ progress, cli: { query: async () => { asked += 1; return [] } }, status: quiet() })
  assert.equal(asked, 0)
})

test('reconcile asks for exactly one entry of exactly that session', async () => {
  const seen = []
  const progress = progressTable({ 'session-41dceef6': row() })
  await reconcileProgress({ progress, cli: { query: async (jse) => { seen.push(JSON.parse(jse)); return [{}] } }, status: quiet() })
  assert.deepEqual(seen, [{ $knowledge: [['$like', 'name', 'msg-session-41dceef6-%']], limit: 1 }])
})

function fakeQueue(taskSessions = []) {
  const forgotten = []
  return {
    forgotten,
    sessionIds: () => new Set(taskSessions),
    forgetSession: async (id) => { forgotten.push(id); return 1 },
  }
}

test('prune removes the row and tasks of a session DSH no longer has', async () => {
  const progress = progressTable({ alive: row(), vanished: row() })
  const queue = fakeQueue(['vanished', 'orphan-task-only'])
  const result = await pruneVanishedSessions({
    progress, queue, knownSessionIds: new Set(['alive']), status: quiet(),
  })

  assert.deepEqual(result.removed.sort(), ['orphan-task-only', 'vanished'])
  assert.equal(progress.get('vanished'), undefined)
  assert.ok(progress.get('alive'), 'a known session keeps its row')
  assert.deepEqual(queue.forgotten.sort(), ['orphan-task-only', 'vanished'], 'tasks with no row are cleaned too')
})

test('prune never removes a session that is live, even if unlisted', async () => {
  const progress = progressTable({ 'just-created': row() })
  const result = await pruneVanishedSessions({
    progress, queue: fakeQueue(), knownSessionIds: new Set(['other']),
    isLive: (id) => id === 'just-created', status: quiet(),
  })
  assert.deepEqual(result.removed, [])
  assert.ok(progress.get('just-created'))
})

test('an empty session listing prunes nothing', async () => {
  // A persistence layer that has not finished loading would otherwise look like
  // "every session is gone" and wipe the table in one pass.
  const progress = progressTable({ a: row(), b: row() })
  const queue = fakeQueue(['a'])
  const status = quiet()
  const result = await pruneVanishedSessions({ progress, queue, knownSessionIds: new Set(), status })

  assert.equal(result.skipped, true)
  assert.equal(progress.map.size, 2)
  assert.deepEqual(queue.forgotten, [])
  assert.match(status.lines[0][1], /not proof that none exist/)
})

function enqueueingQueue() {
  const specs = []
  return { specs, enqueue: async (spec) => { specs.push(spec) } }
}

const CWDS = { live: '/w/proj', gone: undefined }
const projectForCwd = async (cwd) => cwd.split('/').pop()

test('backfill consolidates a logged tail the in-session trigger never reached', async () => {
  // A restart takes the session-end trigger with it: measured on a live
  // restart, nothing was written and the session came back unconsolidated.
  const progress = progressTable({ live: row({ lastLoggedSeq: 900, lastConsolidatedSeq: 400, pendingTokens: 1200 }) })
  const queue = enqueueingQueue()
  const result = await backfillConsolidation({
    progress, queue, cwdFor: (id) => CWDS[id], projectForCwd, minNewTokens: 800, status: quiet(),
  })

  assert.deepEqual(result.enqueued, ['live'])
  assert.deepEqual(queue.specs, [{
    kind: 'consolidate', sessionId: 'live', fromSeq: 400, toSeq: 900, project: 'proj', immediate: true,
  }])
})

test('backfill respects the same token floor as the live trigger', async () => {
  // Otherwise every restart spends one model call per session with any tail.
  const progress = progressTable({ live: row({ lastLoggedSeq: 900, lastConsolidatedSeq: 400, pendingTokens: 799 }) })
  const queue = enqueueingQueue()
  const result = await backfillConsolidation({
    progress, queue, cwdFor: (id) => CWDS[id], projectForCwd, minNewTokens: 800, status: quiet(),
  })

  assert.deepEqual(result.enqueued, [])
  assert.equal(result.skippedBelowFloor, 1)
  assert.deepEqual(queue.specs, [])
})

test('backfill ignores a fully consolidated session and one DSH no longer lists', async () => {
  const progress = progressTable({
    live: row({ lastLoggedSeq: 900, lastConsolidatedSeq: 900, pendingTokens: 5000 }),
    gone: row({ lastLoggedSeq: 900, lastConsolidatedSeq: 0, pendingTokens: 5000 }),
  })
  const queue = enqueueingQueue()
  const result = await backfillConsolidation({
    progress, queue, cwdFor: (id) => CWDS[id], projectForCwd, minNewTokens: 800, status: quiet(),
  })

  assert.deepEqual(result.enqueued, [], 'no tail, and no session to resolve a scope from')
  assert.deepEqual(queue.specs, [])
})
