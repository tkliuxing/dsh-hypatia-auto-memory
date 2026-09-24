import test from 'node:test'
import assert from 'node:assert/strict'

import { backfillConsolidation, normalizeTaskProjects, pruneVanishedSessions, reconcileProgress, sessionDirectory } from '../src/housekeeping.js'
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

const CWDS = {
  live: '/w/proj',
  gone: undefined,
  a1: '/w/proj', a2: '/w/proj', a3: '/w/proj', a4: '/w/proj', a5: '/w/proj',
  b1: '/w/other',
}
const projectForCwd = async (cwd) => cwd.split('/').pop()

test('sessionDirectory reads the header, not the snapshot around it', () => {
  // `sessionPersistence.list()` yields `{header, revision, …}`. Reading
  // `id`/`cwd` off the snapshot — the shape this wiring consumed inline once —
  // produces an EMPTY index, and an empty index makes backfill skip every
  // session: measured on a live profile, fifteen unconsolidated tails and eight
  // of nine sessions holding messages with no summary, untouched by a restart.
  const { cwdById, knownSessionIds } = sessionDirectory([
    { header: { id: 'a', cwd: '/w/proj' }, revision: 'r1' },
    { header: { id: 'b' }, revision: 'r2' },
    { revision: 'r3' },
  ])

  assert.deepEqual([...knownSessionIds].sort(), ['a', 'b'], 'a header without cwd is still a known session')
  assert.deepEqual([...cwdById], [['a', '/w/proj']], 'the cwd comes from header.cwd')
  assert.equal(cwdById.get('b'), undefined)
})

test('sessionDirectory tolerates a listing call that returns nothing', () => {
  assert.deepEqual(sessionDirectory(undefined), { cwdById: new Map(), knownSessionIds: new Set() })
  assert.deepEqual(sessionDirectory([]), { cwdById: new Map(), knownSessionIds: new Set() })
})

test('backfill consolidates a logged tail the in-session trigger never reached', async () => {
  // A restart takes the session-end trigger with it: measured on a live
  // restart, nothing was written and the session came back unconsolidated.
  const progress = progressTable({ live: row({ lastLoggedSeq: 900, lastConsolidatedSeq: 400, pendingTokens: 1200 }) })
  const queue = enqueueingQueue()
  const result = await backfillConsolidation({
    progress, queue, cwdFor: (id) => CWDS[id], projectForCwd, status: quiet(),
  })

  assert.deepEqual(result.enqueued, ['live'])
  assert.deepEqual(queue.specs, [{
    kind: 'consolidate', sessionId: 'live', fromSeq: 400, toSeq: 900, project: 'proj', immediate: true,
  }])
})

test('backfill drains a tail the live trigger was right to skip', async () => {
  // The floor paces a live conversation, where a later turn will come. At boot
  // no later turn is coming, so the same tail would otherwise be skipped for
  // good — that is the whole bug: measured on a live shelf, fifteen sessions
  // carried 1–1950 pending tokens and none of them was ever consolidated.
  const progress = progressTable({ live: row({ lastLoggedSeq: 900, lastConsolidatedSeq: 400, pendingTokens: 12 }) })
  const queue = enqueueingQueue()
  const result = await backfillConsolidation({
    progress, queue, cwdFor: (id) => CWDS[id], projectForCwd, status: quiet(),
  })

  assert.deepEqual(result.enqueued, ['live'])
  assert.equal(result.skipped, 0)
})

test('backfill recovers a range whose consolidate task is stuck failed', async () => {
  // Measured: a truncated consolidation used to be classified permanent, and a
  // failed record is never re-scheduled (`resumeKind` skips it). Re-enqueueing
  // revives it — `writeTask` replaces a failed row with a fresh `pending` one —
  // and nothing else does, so this pass is that range's only way back in.
  const progress = progressTable({ live: row({ lastLoggedSeq: 900, lastConsolidatedSeq: 0, pendingTokens: 10 }) })
  const queue = {
    ...enqueueingQueue(),
    peek: (kind, sessionId) => (kind === 'consolidate' && sessionId === 'live' ? { status: 'failed' } : undefined),
  }
  const result = await backfillConsolidation({
    progress, queue, cwdFor: (id) => CWDS[id], projectForCwd, status: quiet(),
  })

  assert.deepEqual(result.enqueued, ['live'], 'a lost attempt outranks a cost heuristic')
  assert.equal(result.skipped, 0)
  assert.deepEqual(queue.specs, [{
    kind: 'consolidate', sessionId: 'live', fromSeq: 0, toSeq: 900, project: 'proj', immediate: true,
  }])
})

test('backfill spends at most the per-scope cap, biggest tails first', async () => {
  // The cap is what replaces the floor: a backlog drains over several starts
  // instead of one unbounded burst of model calls, and the largest unsummarised
  // spans go first so each call recovers as much as it can.
  const progress = progressTable({
    a1: row({ lastLoggedSeq: 100, lastConsolidatedSeq: 0, pendingTokens: 10 }),
    a2: row({ lastLoggedSeq: 200, lastConsolidatedSeq: 0, pendingTokens: 900 }),
    a3: row({ lastLoggedSeq: 300, lastConsolidatedSeq: 0, pendingTokens: 500 }),
    b1: row({ lastLoggedSeq: 400, lastConsolidatedSeq: 0, pendingTokens: 20 }),
  })
  const queue = enqueueingQueue()
  const result = await backfillConsolidation({
    progress, queue, cwdFor: (id) => CWDS[id], projectForCwd, perScopeLimit: 2, status: quiet(),
  })

  assert.deepEqual(result.enqueued, ['a2', 'a3', 'b1'], 'two from the first scope, one from the second')
  assert.equal(result.skipped, 1, 'the smallest tail of the capped scope waits')
  assert.deepEqual(queue.specs.map((s) => [s.sessionId, s.project]), [
    ['a2', 'proj'], ['a3', 'proj'], ['b1', 'other'],
  ])
})

test('backfill takes a failed range before a larger healthy one', async () => {
  const progress = progressTable({
    a1: row({ lastLoggedSeq: 100, lastConsolidatedSeq: 0, pendingTokens: 9000 }),
    a2: row({ lastLoggedSeq: 200, lastConsolidatedSeq: 0, pendingTokens: 5 }),
  })
  const queue = {
    ...enqueueingQueue(),
    peek: (kind, sessionId) => (sessionId === 'a2' ? { status: 'failed' } : undefined),
  }
  const result = await backfillConsolidation({
    progress, queue, cwdFor: (id) => CWDS[id], projectForCwd, perScopeLimit: 1, status: quiet(),
  })

  assert.deepEqual(result.enqueued, ['a2'])
})

test('backfill ignores a fully consolidated session and one DSH no longer lists', async () => {
  const progress = progressTable({
    live: row({ lastLoggedSeq: 900, lastConsolidatedSeq: 900, pendingTokens: 5000 }),
    gone: row({ lastLoggedSeq: 900, lastConsolidatedSeq: 0, pendingTokens: 5000 }),
  })
  const queue = enqueueingQueue()
  const result = await backfillConsolidation({
    progress, queue, cwdFor: (id) => CWDS[id], projectForCwd, status: quiet(),
  })

  assert.deepEqual(result.enqueued, [], 'no tail, and no session to resolve a scope from')
  assert.deepEqual(queue.specs, [])
})

/* ---------------------------------------------------------------------------- */
/* Queued tasks' projects                                                       */
/* ---------------------------------------------------------------------------- */

function taskTable(seed) {
  const map = new Map(Object.entries(seed))
  const updated = []
  return {
    map,
    updated,
    entries: () => map.entries(),
    update: async (key, fn) => {
      updated.push(key)
      map.set(key, fn(map.get(key)))
    },
  }
}

const task = (project, overrides = {}) => ({
  kind: 'log-message', sessionId: 's', fromSeq: 0, toSeq: 10, project, status: 'pending', attempts: 0, error: null, ...overrides,
})

test('queued tasks get the scope their project now resolves to', async () => {
  const tasks = taskTable({
    'log-message:root': task(''),
    'consolidate:comma': task('a,b', { kind: 'consolidate', status: 'running', attempts: 2 }),
    'cascade:fine': task('proj', { kind: 'cascade' }),
  })
  const status = quiet()
  assert.equal(await normalizeTaskProjects({ tasks, status }), 2)
  assert.equal(tasks.map.get('log-message:root').project, '/')
  assert.deepEqual(tasks.map.get('consolidate:comma'), task('a_b', { kind: 'consolidate', status: 'running', attempts: 2 }), 'nothing but the project changes')
  assert.deepEqual(tasks.updated.sort(), ['consolidate:comma', 'log-message:root'], 'a task already in scope form is not written')
  assert.match(status.lines[0][1], /2 queued task/)
})

test('nothing to rewrite writes nothing and says nothing', async () => {
  const tasks = taskTable({ 'log-message:a': task('proj') })
  const status = quiet()
  assert.equal(await normalizeTaskProjects({ tasks, status }), 0)
  assert.deepEqual(tasks.updated, [])
  assert.deepEqual(status.lines, [])
})

test('a failed task is left as it stands: it never runs again', async () => {
  const tasks = taskTable({ 'log-message:gone': task('', { status: 'failed', error: 'x' }) })
  assert.equal(await normalizeTaskProjects({ tasks, status: quiet() }), 0)
  assert.equal(tasks.map.get('log-message:gone').project, '')
})

test('one task that cannot be rewritten is reported, and the rest still are', async () => {
  const tasks = taskTable({ 'log-message:bad': task(''), 'log-message:good': task('a,b') })
  const update = tasks.update
  tasks.update = async (key, fn) => {
    if (key === 'log-message:bad') throw new Error('storage refused')
    return update(key, fn)
  }
  const status = quiet()
  assert.equal(await normalizeTaskProjects({ tasks, status }), 1)
  assert.equal(tasks.map.get('log-message:good').project, 'a_b')
  assert.ok(status.lines.some(([level, line]) => level === 'warn' && /log-message:bad.*storage refused/.test(line)))
})
