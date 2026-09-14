import test from 'node:test'
import assert from 'node:assert/strict'

import { createPersistedSessions, toReadOnlySession } from '../src/persisted-session.js'

const quiet = () => {
  const lines = []
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: () => {}, count: () => {} }
}

const log = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ seq: from + i, type: 'user/message' }))

test('a persisted log answers the same seq ranges a live Session would', () => {
  const session = toReadOnlySession({ meta: { id: 's', cwd: '/w' }, inheritedEventCount: 2, events: log(10) })

  assert.equal(session.seq, 10, 'seq is the next sequence number, as in the live Session')
  assert.equal(session.inheritedEventCount, 2)
  assert.equal(session.header.cwd, '/w')
  assert.deepEqual(session.snapshotEvents(3, 6).map((e) => e.seq), [3, 4, 5])
  assert.deepEqual(session.snapshotEvents().map((e) => e.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
})

test('ranges are measured from the first stored seq, not array position', () => {
  // A seeded or forked log need not start at 0; slicing by position would then
  // answer a different span than the watermark asked for.
  const session = toReadOnlySession({ meta: {}, inheritedEventCount: 0, events: log(5, 100) })

  assert.equal(session.seq, 105)
  assert.deepEqual(session.snapshotEvents(102, 104).map((e) => e.seq), [102, 103])
  assert.deepEqual(session.snapshotEvents(0, 101).map((e) => e.seq), [100], 'a range below the prefix clamps')
})

test('a malformed inspection yields no session rather than an empty one', () => {
  // An empty Session would consolidate an empty span and advance the watermark
  // past events that were never read.
  assert.equal(toReadOnlySession(undefined), undefined)
  assert.equal(toReadOnlySession({ meta: {} }), undefined)
})

test('a session is loaded once and served from cache', async () => {
  let loads = 0
  const persistence = { load: async () => { loads += 1; return { meta: {}, inheritedEventCount: 0, events: log(3) } } }
  const sessions = createPersistedSessions({ persistence, status: quiet() })

  const first = await sessions.get('a')
  const second = await sessions.get('a')
  assert.equal(loads, 1)
  assert.equal(first, second)
})

test('the cache is bounded — one entry is a whole event log', async () => {
  const seen = []
  const persistence = { load: async (id) => { seen.push(id); return { meta: {}, inheritedEventCount: 0, events: log(2) } } }
  const sessions = createPersistedSessions({ persistence, status: quiet(), cacheSize: 2 })

  await sessions.get('a')
  await sessions.get('b')
  await sessions.get('c')
  await sessions.get('a')
  assert.deepEqual(seen, ['a', 'b', 'c', 'a'], 'the oldest entry was evicted and re-read')
})

test('a read failure defers exactly as an unloaded session does', async () => {
  // Never a span consolidated from a partial log: no session, no work.
  const status = quiet()
  const sessions = createPersistedSessions({
    persistence: { load: async () => { throw new Error('storage is down') } },
    status,
  })

  assert.equal(await sessions.get('a'), undefined)
  assert.match(status.lines[0], /persisted session a could not be read: .*storage is down/)
})
