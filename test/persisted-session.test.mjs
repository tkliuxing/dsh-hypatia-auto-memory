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

/**
 * A handle-serving double for `sessionPersistence`, closing over the log it returns.
 * @param events - events the handle's `read()` answers with.
 */
function persistenceDouble(events = log(3)) {
  const calls = { opened: [], read: 0, closed: 0 }
  const persistence = {
    async open(id, access) {
      calls.opened.push([id, access])
      return {
        header: { id, cwd: '/w' },
        inheritedEventCount: 0,
        async read() { calls.read += 1; return { events } },
        async close() { calls.closed += 1 },
      }
    },
  }
  return { persistence, calls }
}

test('a session is loaded once and served from cache', async () => {
  const { persistence, calls } = persistenceDouble()
  const sessions = createPersistedSessions({ persistence, status: quiet() })

  const first = await sessions.get('a')
  const second = await sessions.get('a')
  assert.deepEqual(calls.opened, [['a', 'read']], 'one read-only handle, then the cache')
  assert.equal(calls.closed, 1)
  assert.equal(first, second)
})

test('the cache is bounded — one entry is a whole event log', async () => {
  const seen = []
  const persistence = {
    async open(id) {
      seen.push(id)
      return {
        header: { id },
        inheritedEventCount: 0,
        async read() { return { events: log(2) } },
        async close() {},
      }
    },
  }
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
    persistence: { open: async () => { throw new Error('storage is down') } },
    status,
  })

  assert.equal(await sessions.get('a'), undefined)
  assert.match(status.lines[0], /persisted session a could not be read: .*storage is down/)
})

test('a handle is closed even when its read fails', async () => {
  // A read handle holds backend state (an open file, a lock); leaking one per
  // lookup would strand the log it was opened for.
  let closed = 0
  const sessions = createPersistedSessions({
    persistence: {
      open: async (id) => ({
        header: { id },
        inheritedEventCount: 0,
        async read() { throw new Error('log is corrupt') },
        async close() { closed += 1 },
      }),
    },
    status: quiet(),
  })

  assert.equal(await sessions.get('a'), undefined)
  assert.equal(closed, 1)
})

test('the service surface a wrong call would miss is exercised', async () => {
  // The bug this covers: this module used to call `persistence.load(id)`, which
  // the service does not expose (`create`/`open`/`flush`/`stat`/`list` only).
  // The TypeError was swallowed by the read-failure guard, so every unloaded
  // session looked like one that had never been written and its consolidation
  // stayed deferred forever. Asserting the entry point by name is what keeps a
  // rename in dsh from silently degrading into "no session" again.
  const { persistence, calls } = persistenceDouble(log(4))
  const sessions = createPersistedSessions({ persistence, status: quiet() })

  const session = await sessions.get('s1')

  assert.deepEqual(calls.opened, [['s1', 'read']], 'opened read-only')
  assert.equal(calls.read, 1)
  assert.equal(session.seq, 4, 'the stored log answered the range, rather than resolving to nothing')
})
