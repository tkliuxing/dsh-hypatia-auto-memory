import test from 'node:test'
import assert from 'node:assert/strict'

import { createCollector } from '../src/collector.js'

/**
 * Regression coverage for the turn-end checkpoint (lastCheckTurn): it marks
 * the most recent accepted consolidation task. Ordinary turns and low-token
 * evaluations must retain it so both thresholds behave as minimums.
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function makeHarness({ checkEveryTurns = 3, minNewTokens = 100 } = {}) {
  const progressRows = new Map()
  const progress = {
    get: (id) => progressRows.get(id),
    put: (id, row) => { progressRows.set(id, row) },
    rows: progressRows,
  }
  const enqueued = []
  // The drain is gated so a test can observe the window in which a disposed
  // session must still be resolvable.
  let openDrain
  const drained = new Promise((resolve) => { openDrain = resolve })
  const resumed = []
  const queue = {
    enqueue: async (task) => { enqueued.push(task) },
    whenIdle: async () => { await drained; return true },
    resumeSession: (id) => { resumed.push(id); return 1 },
  }

  let handler
  let disposeHandler
  let createdHandler
  const ctx = {
    sessions: { get: () => undefined },
    on: (event, fn) => {
      if (event === 'session/event') handler = fn
      else if (event === 'session/disposed') disposeHandler = fn
      else if (event === 'session/created') createdHandler = fn
      else assert.fail(`unexpected listener: ${event}`)
    },
  }

  // Consolidator semantics exercised against the REAL advanceProgress path in
  // the collector: both gates are minimums and the checkpoint advances only
  // after work is accepted.
  const onTurnEnd = async (sessionId, turn, state) => {
    const elapsed = turn - (state.lastCheckTurn ?? 0)
    if (elapsed < checkEveryTurns) return { resetTokens: false, advanceCheckpoint: false }
    if ((state.pendingTokens ?? 0) < minNewTokens) return { resetTokens: false, advanceCheckpoint: false }
    return { resetTokens: true, advanceCheckpoint: true }
  }

  const sessionEnds = []
  const collector = createCollector({
    ctx,
    queue,
    progress,
    getConfig: () => ({ collector: { enabled: true }, queue: { flushWindowMs: 0 } }),
    status: { error: () => {}, info: () => {} },
    onTurnEnd,
    onSessionEnd: async (sessionId, session) => { sessionEnds.push({ sessionId, seq: session.seq }) },
  })

  const session = { header: { id: 's1' }, inheritedEventCount: 0, seq: 0 }
  return {
    collector, progress, enqueued, session, sessionEnds, resumed,
    reopen: () => createdHandler(session),
    emit: (event) => handler(session, event),
    dispose: () => disposeHandler(session),
    openDrain: () => openDrain(),
  }
}

test('restart does not regress the durable pending-token count', async () => {
  const { collector, progress, emit } = makeHarness({ checkEveryTurns: 3, minNewTokens: 800 })
  // Pre-restart state: a previous process accumulated 672 durable tokens.
  progress.put('s1', { lastLoggedSeq: 0, lastConsolidatedSeq: 0, lastCheckTurn: 26, pendingTokens: 672 })
  // After restart the in-memory counter starts from zero and a few new
  // events add 220 before the next turn/end.
  collector.setPendingTokens('s1', 220)

  // This turn/end is below the turn gate, but the collector still re-stamps
  // progress — the durable count must keep the MAX (672), not drop to 220.
  emit({ type: 'turn/end', seq: 1, data: { turn: 27 } })
  await flush()
  assert.equal(progress.get('s1')?.pendingTokens, 672)

  // Once the in-memory count exceeds the durable one, the larger wins again.
  collector.setPendingTokens('s1', 900)
  emit({ type: 'turn/end', seq: 2, data: { turn: 28 } })
  await flush()
  assert.equal(progress.get('s1')?.pendingTokens, 900)
})

test('low tokens do not consume an elapsed turn interval', async () => {
  const { collector, progress, emit } = makeHarness({ checkEveryTurns: 3, minNewTokens: 100 })

  // The turn gate opens at turn 3, but no tokens are ready. The checkpoint
  // stays at 0 so the very next turn can trigger as soon as tokens arrive.
  for (let turn = 1; turn <= 3; turn += 1) {
    emit({ type: 'turn/end', seq: turn, data: { turn } })
    await flush()
  }
  assert.equal(progress.get('s1')?.lastCheckTurn, 0)
  assert.equal(progress.get('s1')?.pendingTokens, 0)

  collector.setPendingTokens('s1', 500)
  emit({ type: 'turn/end', seq: 4, data: { turn: 4 } })
  await flush()
  assert.equal(progress.get('s1')?.lastCheckTurn, 4)
  assert.equal(progress.get('s1')?.pendingTokens, 0)
})

test('an accepted task establishes the next minimum turn interval', async () => {
  const { collector, progress, emit } = makeHarness({ checkEveryTurns: 2, minNewTokens: 100 })

  collector.setPendingTokens('s1', 150)
  emit({ type: 'turn/end', seq: 1, data: { turn: 1 } })
  await flush()
  assert.equal(progress.get('s1')?.lastCheckTurn, 0)
  emit({ type: 'turn/end', seq: 2, data: { turn: 2 } })
  await flush()
  assert.equal(progress.get('s1')?.lastCheckTurn, 2)
  assert.equal(progress.get('s1')?.pendingTokens, 0)

  // Enough new tokens immediately after the first task still cannot trigger
  // until two more turns have elapsed from the accepted-task checkpoint.
  collector.setPendingTokens('s1', 150)
  emit({ type: 'turn/end', seq: 3, data: { turn: 3 } })
  await flush()
  assert.equal(progress.get('s1')?.lastCheckTurn, 2)
  assert.equal(progress.get('s1')?.pendingTokens, 150)
  emit({ type: 'turn/end', seq: 4, data: { turn: 4 } })
  await flush()
  assert.equal(progress.get('s1')?.lastCheckTurn, 4)
  assert.equal(progress.get('s1')?.pendingTokens, 0)
})

test('a span is cut at turn/end, not mid-turn', async () => {
  // Project scope resolves through git, so warm the per-session cache first;
  // otherwise the enqueue is still awaiting a subprocess when we assert.
  // `assistant/message` is appended before the tools it requested run. A span
  // cut by a timer therefore separated the assistant entry from its own tool
  // results — and `formatSpan` only emits a ledger next to an assistant
  // message, so those results were dropped rather than merely delayed.
  const h = makeHarness()
  await h.collector.projectFor(h.session)
  h.emit({ type: 'turn/start', seq: 0, data: { turn: 1 } })
  h.emit({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } })
  h.emit({ type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text: 'calling' }] } } })
  h.emit({ type: 'tool/call', seq: 3, data: { turn: 1, callId: 'c1', name: 'grep' } })
  await flush()
  assert.deepEqual(h.enqueued, [], 'nothing flushed while the turn is open')

  h.emit({ type: 'tool/result', seq: 4, data: { turn: 1, message: { source: { callId: 'c1' }, content: [] } } })
  h.emit({ type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } })
  await flush()

  assert.equal(h.enqueued.length, 1)
  assert.deepEqual(
    [h.enqueued[0].fromSeq, h.enqueued[0].toSeq, h.enqueued[0].immediate],
    [0, 6, true],
    'one span covering the whole turn, scheduled without waiting',
  )
})

test('the turn span starts at the watermark, not at the turn boundary', async () => {
  // Anything the previous turn left unlogged (a crash, a failed task) is picked
  // up by the next flush rather than being stranded behind the watermark.
  const h = makeHarness()
  await h.collector.projectFor(h.session)
  h.progress.put('s1', { lastLoggedSeq: 2, lastConsolidatedSeq: 0, lastCheckTurn: 0, pendingTokens: 0 })
  h.emit({ type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  await flush()
  assert.deepEqual([h.enqueued[0].fromSeq, h.enqueued[0].toSeq], [2, 10])
})

test('a forked child never re-logs its inherited prefix', async () => {
  const h = makeHarness()
  await h.collector.projectFor(h.session)
  h.session.inheritedEventCount = 40
  h.emit({ type: 'turn/end', seq: 42, data: { turn: 1, reason: { kind: 'completed' } } })
  await flush()
  assert.deepEqual([h.enqueued[0].fromSeq, h.enqueued[0].toSeq], [40, 43])
})

test('session close flushes the tail and consolidates regardless of thresholds', async () => {
  // A task under `checkEveryTurns` turns or `minNewTokens` tokens never trips
  // the ongoing gates. Without an end-of-session pass it would be logged and
  // never turned into knowledge — precisely the shape of a short, self-contained
  // fix worth remembering.
  const h = makeHarness({ checkEveryTurns: 50, minNewTokens: 999_999 })
  await h.collector.projectFor(h.session)
  h.progress.put('s1', { lastLoggedSeq: 0, lastConsolidatedSeq: 0, lastCheckTurn: 0, pendingTokens: 10 })
  h.session.seq = 12

  h.dispose()
  h.openDrain()
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.deepEqual([h.enqueued[0].fromSeq, h.enqueued[0].toSeq, h.enqueued[0].immediate], [0, 12, true])
  assert.deepEqual(h.sessionEnds, [{ sessionId: 's1', seq: 12 }])
})

test('a disposed session stays resolvable until its queued work drains', async () => {
  // Executors re-read the log from the session object, and the store has
  // already let go by the time `session/disposed` fires. Dropping the reference
  // immediately would make every queued task fail with "session not live".
  const h = makeHarness()
  await h.collector.projectFor(h.session)
  h.session.seq = 3
  assert.equal(h.collector.sessionFor('s1'), undefined, 'not tracked before disposal')

  h.dispose()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(h.collector.sessionFor('s1'), h.session, 'held while work is queued')

  h.openDrain()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(h.collector.sessionFor('s1'), undefined, 'released once drained')
})

test('a host session summary schedules the session node', async () => {
  // DSH emits no session-summary event of its own; a title or a compaction
  // summary is where a usable one actually shows up.
  for (const event of [
    { type: 'session/title', seq: 7, data: { title: 'Storage rewrite', messageSeqs: [1, 2] } },
    { type: 'compaction/summary', seq: 9, data: { summary: [{ type: 'text', text: 'so far…' }] } },
  ]) {
    const h = makeHarness()
    await h.collector.projectFor(h.session)
    h.emit(event)
    await flush()
    assert.deepEqual(
      [h.enqueued[0].kind, h.enqueued[0].fromSeq, h.enqueued[0].toSeq, h.enqueued[0].immediate],
      ['session-node', event.seq, event.seq + 1, true],
      event.type,
    )
  }
})

test('a session coming back resumes the tasks deferred for it', () => {
  // DSH loads sessions lazily; `session/created` fires for a reopened session as
  // well as a new one, and it is the moment deferred work can finally run.
  const h = makeHarness()
  h.reopen()
  assert.deepEqual(h.resumed, ['s1'])
})
