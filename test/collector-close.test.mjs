/**
 * The shutdown sweep: what a closing session owes must be durable before the
 * queue stops accepting work.
 *
 * The bug this covers: `session/disposed` observers are fire-and-forget in DSH,
 * the collect fiber is torn down before the session store releases its sessions,
 * and the queue dies with that fiber — so every `enqueue` after `queue.dispose()`
 * was a silent no-op and a whole run's tails were dropped. The sweep runs first
 * (cordis disposes a fiber's effects in reverse registration order) and persists
 * both ranges; the model call is left to the next start.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createCollector } from '../src/collector.js'
import { EMPTY_PROGRESS } from '../src/progress.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function makeHarness({ sessions = [], rows = {} } = {}) {
  const progressRows = new Map(Object.entries(rows).map(([id, row]) => [id, { ...EMPTY_PROGRESS, ...row }]))
  const progress = {
    get: (id) => progressRows.get(id),
    put: (id, row) => { progressRows.set(id, row) },
    rows: progressRows,
  }
  /** Specs the queue accepted, and an enqueue that fails once `dispose` ran. */
  const specs = []
  let disposed = false
  const waited = []
  const waitedIdle = []
  const queue = {
    enqueue: async (spec) => {
      if (disposed) throw new Error('enqueue after dispose')
      specs.push(spec)
    },
    whenTaskSettled: async (kind, sessionId, options) => { waited.push([kind, sessionId, options]); return true },
    whenIdle: async (sessionId) => { waitedIdle.push(sessionId); return true },
    resumeSession: () => 0,
    dispose: async () => { disposed = true },
  }
  const errors = []
  const status = {
    info: () => {}, warn: (m) => errors.push(['warn', m]), error: (m) => errors.push(['error', m]), count: () => {},
  }
  const sessionEnds = []
  const ctx = {
    sessions: { list: () => sessions, get: (id) => sessions.find((s) => s.header.id === id) },
    on: () => {},
  }
  const collector = createCollector({
    ctx,
    queue,
    progress,
    getConfig: () => ({ collector: { enabled: true }, queue: { flushWindowMs: 0 } }),
    status,
    onTurnEnd: async () => ({ resetTokens: false, advanceCheckpoint: false }),
    // A stand-in for the consolidator, with its contract: it enqueues the range
    // the watermarks say is owed, and reports false when there is none. The
    // fresh tail the log task was just handed is NOT in that range — the
    // executor advances `lastLoggedSeq` when it runs — so a shutdown that only
    // has an unlogged tail leaves it to the next start's backfill, which is
    // exactly why that pass ignores the token floor.
    onSessionEnd: async (sessionId, session) => {
      sessionEnds.push(sessionId)
      const row = progress.get(sessionId)
      const fromSeq = row?.lastConsolidatedSeq ?? 0
      const toSeq = row?.lastLoggedSeq ?? 0
      if (toSeq <= fromSeq) return false
      await queue.enqueue({ kind: 'consolidate', sessionId, fromSeq, toSeq, project: 'demo', immediate: true })
      return true
    },
  })
  return { collector, progress, specs, errors, sessionEnds, waited, waitedIdle, queue }
}

const session = (id, seq, cwd = '/tmp/demo') => ({ header: { id, cwd }, inheritedEventCount: 0, seq })

test('the closing sweep persists both ranges before the queue can stop', async () => {
  // A session that owes a logged-but-unconsolidated range AND a fresh, unlogged
  // tail is the case a shutdown must not lose: the first is what the model was
  // always supposed to see, the second is the last turn.
  const h = makeHarness({ sessions: [session('s1', 40)], rows: { s1: { lastLoggedSeq: 30 } } })

  const owed = await h.collector.finalizeLiveSessions()
  // The order the process would use: the sweep's work, then the queue's death.
  await h.queue.dispose()
  await flush()

  assert.equal(owed, 1)
  assert.deepEqual(h.specs.map((spec) => spec.kind), ['log-message', 'consolidate'],
    'the log range is queued before the consolidation that reads the same span')
  assert.deepEqual(h.specs[0], {
    kind: 'log-message', sessionId: 's1', fromSeq: 30, toSeq: 40, project: 'demo', immediate: true,
  })
  assert.deepEqual(h.specs[1], {
    kind: 'consolidate', sessionId: 's1', fromSeq: 0, toSeq: 30, project: 'demo', immediate: true,
  })
  assert.deepEqual(h.errors, [], 'no enqueue raced the queue disposal')
  assert.deepEqual(h.sessionEnds, ['s1'])
})

test('the sweep waits for the final write, not for the model call behind it', async () => {
  const h = makeHarness({ sessions: [session('s1', 40)] })

  await h.collector.finalizeLiveSessions()

  assert.deepEqual(h.waited, [['log-message', 's1', { timeoutMs: 2000 }]])
  assert.deepEqual(h.waitedIdle, [],
    'whenIdle would follow the session chain into a model call and outlive the shutdown budget')
})

test('a session whose watermark already covers it owes nothing', async () => {
  const h = makeHarness({
    sessions: [session('s1', 40)],
    rows: { s1: { lastLoggedSeq: 40, lastConsolidatedSeq: 40 } },
  })

  const owed = await h.collector.finalizeLiveSessions()

  assert.equal(owed, 0)
  assert.deepEqual(h.specs, [], 'no empty range is queued')
})

test('every open session is swept, each once', async () => {
  const h = makeHarness({ sessions: [session('s1', 10), session('s2', 20), session('s3', 30)] })

  const owed = await h.collector.finalizeLiveSessions()

  assert.equal(owed, 3)
  assert.deepEqual(h.specs.filter((spec) => spec.kind === 'log-message').map((spec) => spec.sessionId),
    ['s1', 's2', 's3'])
})

test('a failing session does not stop the rest of the sweep', async () => {
  const sessions = [session('s1', 10), session('s2', 20)]
  const h = makeHarness({ sessions })
  // The first session cannot resolve a scope, so its enqueue never happens.
  h.collector // keep the reference explicit: the double is swapped in below.
  const original = h.queue.enqueue
  let calls = 0
  h.queue.enqueue = async (spec) => {
    calls += 1
    if (calls === 1) throw new Error('storage refused the write')
    await original(spec)
  }

  const owed = await h.collector.finalizeLiveSessions()

  assert.equal(owed, 1, 'the second session still got its tail persisted')
  assert.equal(h.errors.filter(([level]) => level === 'error').length, 1)
  assert.deepEqual(h.specs.filter((spec) => spec.kind === 'log-message').map((spec) => spec.sessionId), ['s2'])
})
