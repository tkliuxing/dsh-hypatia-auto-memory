/**
 * Withdrawal detection: which surface replacements mean "the user took this
 * branch back" and which do not.
 *
 * The predicate is the safety boundary of the whole correction
 * (docs/rewind-memory-consistency.md §2.2–§2.4): a false positive deletes real
 * history, a false negative merely leaves the pre-existing behavior in place.
 * Every case here is a producer that exists on a real host, and the `kind`
 * strings are the ones its code actually sends.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  WITHDRAWAL_SOURCE_KINDS, withdrawalWork, withdrawnOrdinals, withdrawnRanges, withdrawnSeqs,
} from '../src/collector.js'

/** One surface-replacement marker exactly as the log carries it. */
function marker(seq, { type = 'user/message', kind, from, to, cited } = {}) {
  return {
    type,
    seq,
    time: 1_791_853_771_605,
    data: { content: [{ type: 'text', text: '(empty message)' }], source: { kind }, role: 'user' },
    surfaceOp: { op: 'replace', startSeq: from, endSeq: to },
    ...(cited === undefined ? {} : { sourceEventSeqs: cited }),
  }
}

/** One ordinary append-origin message. */
function message(seq, kind = 'user') {
  return {
    type: 'user/message',
    seq,
    time: 1_791_853_771_605,
    data: { content: [{ type: 'text', text: 'a question' }], source: { kind }, role: 'user' },
    surfaceOp: 'append',
  }
}

test('a rewind marker is a withdrawal, and cites the seqs it shadows', () => {
  // The sampled marker from session-007cef11: seq 389, shadowing 365..367.
  const ranges = withdrawnRanges([
    message(365),
    marker(389, { kind: 'dsh-rewind', from: 365, to: 367, cited: [365, 367] }),
    message(397),
  ])

  assert.equal(ranges.length, 1)
  assert.equal(ranges[0].kind, 'dsh-rewind')
  assert.equal(ranges[0].at, 389)
  assert.deepEqual([ranges[0].from, ranges[0].to], [365, 367])
  assert.deepEqual([...ranges[0].seqs].sort((a, b) => a - b), [365, 367])
})

test('both rollback plugins land on one kind, so one predicate covers them', () => {
  // `@domitor-syh/dsh-rollback` and `@nianchu/dsh-rollback` share
  // `plugin:rollback` (lib/index.js:964 and :1465 respectively), and both cite
  // `sourceEventSeqs` beside the range.
  const ranges = withdrawnRanges([marker(20, { kind: 'plugin:rollback', from: 5, to: 9, cited: [5, 7, 9] })])
  assert.deepEqual([...ranges[0].seqs].sort((a, b) => a - b), [5, 7, 9])
})

test('compaction is not a withdrawal, however much it looks like one', () => {
  // `compaction-basic` appends a `user/message` with `source.kind =
  // 'compact-checkpoint'` (region.ts:506-509). The folded region is real
  // history, summarised for the model rather than discarded by the user — and
  // `dsh-clear-mind` reuses the very same seam, which is why this case is the
  // one the correction is built around.
  const ranges = withdrawnRanges([
    marker(500, { kind: 'compact-checkpoint', from: 10, to: 400, cited: [10, 400] }),
    marker(600, { kind: 'dsh-clear-mind', from: 20, to: 30, cited: [20, 30] }),
  ])
  assert.deepEqual(ranges, [])
})

test('the other producers that replace surface nodes are not withdrawals', () => {
  const ranges = withdrawnRanges([
    // `dsh-retrace` sends `model`; too generic to key a deletion on.
    marker(30, { kind: 'model', from: 3, to: 4, cited: [3, 4] }),
    // `@kyle123740/dsh-message-recall` sends `user` plus a `producer` field —
    // a kind that identifies nothing on its own.
    { ...marker(40, { from: 5, to: 6, cited: [5, 6] }), data: { content: [], source: { kind: 'user', producer: 'message-recall' } } },
    // `agent-context-editor` edits and condenses with its own source.
    marker(50, { kind: 'context-editor', from: 7, to: 8, cited: [7, 8] }),
    // The runtime-context snapshot replaces itself, as a `system/message`.
    marker(60, { type: 'system/message', kind: 'system-prompt', from: 9, to: 9, cited: [9] }),
    // The tool-result pruner replaces one `tool/result` with its pruned copy.
    marker(70, { type: 'tool/result', kind: 'tool', from: 11, to: 11, cited: [11] }),
  ])
  assert.deepEqual(ranges, [])
})

test('appends and logs without surface metadata contribute nothing', () => {
  assert.deepEqual(withdrawnRanges([message(1), message(2, 'plugin:x')]), [])
  // A log written before `surfaceOp` existed has no marker to find, so the
  // whole feature is a silent no-op there rather than a guess.
  const legacy = { type: 'user/message', seq: 3, time: 0, data: { content: [], source: { kind: 'user' } } }
  assert.deepEqual(withdrawnRanges([legacy]), [])
})

test('the citation is the only reading, and a marker without one is not a withdrawal', () => {
  // The host only requires the list to INCLUDE the shadowed nodes, so what the
  // marker hid is the list itself, not the range: the range denotes surface
  // order, which a slice containing a compaction checkpoint can render
  // `startSeq > endSeq`. Reading the range instead would be a guess — and the
  // wrong kind of guess, since everything it names gets deleted.
  const cited = withdrawnRanges([marker(20, { kind: 'dsh-rewind', from: 5, to: 8, cited: [5, 8] })])
  assert.deepEqual([...cited[0].seqs].sort((a, b) => a - b), [5, 8])

  // No list at all is the one case this build cannot read, and it has to fail
  // safe. The host refuses an empty list on a replacement, so this is a log from
  // somewhere else entirely.
  assert.deepEqual(withdrawnRanges([marker(20, { kind: 'dsh-rewind', from: 5, to: 8 })]), [])
  assert.deepEqual(withdrawnRanges([marker(20, { kind: 'dsh-rewind', from: 5, to: 8, cited: [] })]), [])
})

test('a rollback marker is read as a set, whatever order it lists', () => {
  // `seqsForStorage` rotates the list for three or more seqs so the store's
  // range encoder cannot compress it: the last shadowed seq comes first. Order
  // must therefore not matter — and a range read off the ends would be wrong.
  const rotated = marker(30, { kind: 'plugin:rollback', from: 10, to: 12, cited: [12, 10, 11] })
  assert.deepEqual([...withdrawnSeqs([rotated])].sort((a, b) => a - b), [10, 11, 12])
})

test('withdrawnSeqs unions every marker in the slice', () => {
  // Two rewinds in one session (the plugin has no limit on repeats) hide four
  // messages; the set is what the executor and the summariser both read.
  const seqs = withdrawnSeqs([
    marker(30, { kind: 'dsh-rewind', from: 10, to: 12, cited: [10, 12] }),
    message(40),
    marker(50, { kind: 'plugin:rollback', from: 41, to: 44, cited: [41, 44] }),
  ])
  assert.deepEqual([...seqs].sort((a, b) => a - b), [10, 12, 41, 44])
})

test('ordinals are counted the way the entry names are', () => {
  // `withdrawnOrdinals` has to agree with the `baseIndex` the log executor
  // computes, or a retraction would name somebody else's entry. The counted
  // prefix is the log's own: non-messages and unlogged plugin injections
  // contribute nothing, and the inherited prefix of a fork contributes none.
  const log = [
    { type: 'turn/start', seq: 0, time: 0, data: {} },
    message(1),                                   // ordinal 0
    message(2, 'plugin:some-injection'),          // not logged
    message(3),                                   // ordinal 1
    { type: 'assistant/message', seq: 4, time: 0, data: { turn: 1, message: { content: [{ type: 'text', text: 'hi' }] } } }, // ordinal 2
    message(5),                                   // ordinal 3
    { type: 'tool/call', seq: 6, time: 0, data: { callId: 'c', name: 'grep' } },
    message(7),                                   // ordinal 4
  ]

  assert.deepEqual(
    [...withdrawnOrdinals(log, new Set([3, 7]), 0)],
    [[3, 1], [7, 4]],
  )
  // A shadowed non-message has no entry to name, and nothing to retract.
  assert.deepEqual([...withdrawnOrdinals(log, new Set([6]), 0)], [])
  // Forked logs: the inherited prefix owns the low ordinals, so a child's first
  // own message is ordinal 0 — the executor passes the same bound it counts
  // `baseIndex` from, and events below it are not in the slice at all.
  const own = log.filter((event) => event.seq >= 5)
  assert.deepEqual([...withdrawnOrdinals(own, new Set([7]), 5)], [[7, 1]])
  assert.deepEqual([...withdrawnOrdinals(log, new Set([3]), 5)], [], 'the prefix own no ordinal')
  assert.deepEqual([...withdrawnOrdinals(log, new Set())], [])
})

test('a marker never withdraws itself', () => {
  // A false positive here would delete the marker's own entry — and it has none,
  // because the marker is plugin-sourced and never logged as a human message.
  const seqs = withdrawnSeqs([marker(389, { kind: 'dsh-rewind', from: 365, to: 367, cited: [365, 367] })])
  assert.equal(seqs.has(389), false)
})

test('withdrawalWork splits the two faces of a withdrawal by position', () => {
  // One session, one rewind: messages at seq 1 and 2 were already written by an
  // earlier span (they are before it), the message at seq 5 is in the span being
  // written now, and seq 6 is a marker (never a message of its own).
  const prefix = [
    message(0),                                    // ordinal 0
    { type: 'tool/call', seq: 1, time: 0, data: { callId: 'c', name: 'grep' } },
    message(2),                                    // ordinal 1
    message(3, 'plugin:injection'),                // not logged
  ]
  const log = [
    message(4),                                    // ordinal 2 — the anchor the user rewound to
    message(5),                                    // ordinal 3
    marker(6, { kind: 'dsh-rewind', from: 2, to: 5, cited: [2, 5] }),
    message(7),                                    // ordinal 4
  ]

  const work = withdrawalWork({ log, prefix, fromSeq: 4, inherited: 0 })
  // Both shadowed seqs are known; only the one already written has an entry.
  assert.deepEqual([...work.seqs].sort((a, b) => a - b), [2, 5])
  assert.deepEqual([...work.retract], [[2, 1]], 'seq 2 was ordinal 1; the tool/call added none')
  // The anchor (seq 4) is not cited and is not touched.
  assert.equal(work.seqs.has(4), false)
})

test('withdrawalWork costs nothing when nothing was withdrawn', () => {
  const log = [message(0), message(1)]
  const work = withdrawalWork({ log, prefix: [], fromSeq: 0, inherited: 0 })
  assert.deepEqual([...work.seqs], [])
  assert.deepEqual([...work.retract], [])
})

test('withdrawalWork counts retraction ordinals from the inherited prefix', () => {
  // A forked session: the inherited prefix owns the low ordinals, so the child's
  // first own message is ordinal 0 — the same count `baseIndex` uses.
  const prefix = [
    { type: 'session/end-seed', seq: 0, time: 0, data: {} },
    message(1),                                    // inherited, not counted
    message(2),                                    // child ordinal 0
  ]
  const log = [
    message(3),                                    // child ordinal 1
    marker(4, { kind: 'plugin:rollback', from: 2, to: 3, cited: [2, 3] }),
  ]

  const work = withdrawalWork({ log, prefix, fromSeq: 3, inherited: 2 })
  assert.deepEqual([...work.retract], [[2, 0]], 'the inherited message is not an ordinal of ours')
})

test('the whitelist is exactly the audited producers', () => {
  // Widening it is a decision, not a refactor: each member is a claim that a
  // replacement from that source means the user took the branch back.
  assert.deepEqual([...WITHDRAWAL_SOURCE_KINDS].sort(), ['dsh-rewind', 'plugin:rollback'])
})
