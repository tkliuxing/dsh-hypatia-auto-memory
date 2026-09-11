import test from 'node:test'
import assert from 'node:assert/strict'

import { countLoggableMessages, formatSpan, isCompactionReplacement, isLoggableMessage } from '../src/collector.js'

const NOW = new Date('2025-09-09T12:00:00Z')

function ev(type, seq, data = {}, time = 1725800000000) {
  return { type, seq, time, data }
}

test('formatSpan renders user and assistant messages with policy applied', () => {
  const events = [
    ev('user/message', 1, {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'token=supersecret please fix sk-abcdef1234567890 now' }],
    }),
    ev('assistant/message', 2, { turn: 3, message: { content: [{ type: 'text', text: 'on it, 今天完成' }] } },
      new Date('2025-09-09T10:00:00').getTime()),
  ]
  const out = formatSpan(events, { now: NOW })
  assert.equal(out.length, 2)
  const [user, assistant] = out
  assert.equal(user.role, 'user')
  assert.match(user.markdown, /## Role\nuser/)
  assert.match(user.markdown, /## Content\ntoken=\[REDACTED:secret:credential\] please fix \[REDACTED:secret:key\] now/)
  assert.equal(assistant.role, 'assistant')
  assert.match(assistant.markdown, /## Turn\n3/)
  assert.match(assistant.markdown, /2025-09-09完成/)
  assert.ok(!user.markdown.includes('## Turn'), 'user messages carry no fake turn')
})

test('formatSpan skips plugin-sourced user messages', () => {
  const events = [
    ev('user/message', 1, { source: { kind: 'plugin', plugin: 'recall' }, content: [{ type: 'text', text: 'ref' }] }),
  ]
  assert.equal(formatSpan(events, { now: NOW }).length, 0)
})

test('formatSpan marks interrupted assistant turns', () => {
  const events = [
    ev('assistant/message', 1, { turn: 1, interrupted: true, message: { content: [{ type: 'text', text: 'partial' }] } }),
  ]
  const [out] = formatSpan(events, { now: NOW })
  assert.match(out.markdown, /\[turn interrupted mid-stream\]/)
})

test('formatSpan attaches a collapsed tool ledger to assistant turns', () => {
  const events = [
    ev('tool/call', 1, { callId: 'c1', name: 'grep' }),
    ev('tool/result', 2, {
      turn: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] },
    }),
    ev('tool/call', 3, { callId: 'c2', name: 'grep' }),
    ev('tool/result', 4, {
      turn: 1,
      message: { source: { callId: 'c2' }, content: [{ type: 'text', text: 'ok' }] },
    }),
    ev('tool/call', 5, { callId: 'c3', name: 'bash' }),
    ev('tool/result', 6, {
      turn: 1,
      error: { name: 'Error', code: 'ENOENT' },
      message: { source: { callId: 'c3' }, content: [{ type: 'text', text: 'missing' }] },
    }),
    ev('assistant/message', 7, { turn: 1, message: { content: [{ type: 'text', text: 'report' }] } }),
  ]
  const [out] = formatSpan(events, { now: NOW })
  assert.match(out.markdown, /## Tool Calls/)
  // Two identical grep rows collapse into one with a counter.
  assert.match(out.markdown, /`grep` — ✅ ok ×2/)
  assert.match(out.markdown, /`bash` — ❌ Error \(ENOENT\)/)
})

test('formatSpan caps long assistant text', () => {
  const events = [
    ev('assistant/message', 1, { turn: 1, message: { content: [{ type: 'text', text: 'y'.repeat(900) }] } }),
  ]
  const [out] = formatSpan(events, { now: NOW, maxAssistantChars: 500 })
  assert.match(out.markdown, /\[\.{3}truncated 400 chars\]/)
})

test('formatSpan disables the ledger when toolLedger is false', () => {
  const events = [
    ev('tool/result', 1, {
      turn: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'x' }] },
    }),
    ev('assistant/message', 2, { turn: 1, message: { content: [{ type: 'text', text: 'a' }] } }),
  ]
  const [out] = formatSpan(events, { now: NOW, toolLedger: false })
  assert.ok(!out.markdown.includes('## Tool Calls'))
})

test('message ordinals are dense, and skip everything that is not a logged message', () => {
  // DSH appends one `assistant/chunk` per streamed token delta, so seq counts
  // tokens. Naming entries by seq produced a sparse keyspace that broke
  // `$not-summaried`'s FIFO batching and any ordered walk of `msg-*`.
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text: 'a' }] }),
    ev('assistant/chunk', 2, { turn: 1, chunk: {} }),
    ev('assistant/chunk', 3, { turn: 1, chunk: {} }),
    ev('assistant/message', 4, { turn: 1, message: { content: [{ type: 'text', text: 'b' }] } }),
    // Plugin-injected context is not a human message and must not take an ordinal.
    ev('user/message', 5, { source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: 'ctx' }] }),
    ev('tool/call', 6, { turn: 1, callId: 'c1', name: 'grep' }),
    ev('assistant/message', 7, { turn: 1, message: { content: [{ type: 'text', text: 'c' }] } }),
  ]
  const out = formatSpan(events, { now: NOW })
  assert.deepEqual(out.map((item) => item.index), [0, 1, 2])
  assert.deepEqual(out.map((item) => item.seq), [1, 4, 7])
})

test('countLoggableMessages gives the ordinal a span continues from', () => {
  const prefix = [
    ev('user/message', 0, { source: { kind: 'user' }, content: [] }),
    ev('assistant/chunk', 1, {}),
    ev('assistant/message', 2, { turn: 1, message: { content: [] } }),
    ev('user/message', 3, { source: { kind: 'plugin', plugin: 'p' }, content: [] }),
  ]
  assert.equal(countLoggableMessages(prefix), 2)
  assert.equal(countLoggableMessages([]), 0)
  assert.equal(countLoggableMessages(undefined), 0)

  // The whole point: the same prefix always yields the same base, so a replay
  // reproduces exactly the same entry names instead of duplicating them.
  const span = [ev('assistant/message', 4, { turn: 2, message: { content: [{ type: 'text', text: 'x' }] } })]
  const first = formatSpan(span, { now: NOW, baseIndex: countLoggableMessages(prefix) })
  const replay = formatSpan(span, { now: NOW, baseIndex: countLoggableMessages(prefix) })
  assert.equal(first[0].index, 2)
  assert.deepEqual(first.map((i) => i.index), replay.map((i) => i.index))
})

test('isLoggableMessage is the single predicate both writers share', () => {
  // The consolidator derives link targets with this same predicate, so a
  // divergence here would silently produce edges pointing at absent entries.
  assert.equal(isLoggableMessage(ev('assistant/message', 0, {})), true)
  assert.equal(isLoggableMessage(ev('user/message', 0, { source: { kind: 'user' } })), true)
  assert.equal(isLoggableMessage(ev('user/message', 0, { source: { kind: 'plugin' } })), false)
  assert.equal(isLoggableMessage(ev('tool/result', 0, {})), false)
  assert.equal(isLoggableMessage(undefined), false)
})

test('relative dates resolve against when the message was sent, not when it is written', () => {
  // A task deferred until its session reopens can be written days later; "明天"
  // must still mean the day after the user said it.
  const sent = new Date('2025-09-01T10:00:00').getTime()
  const events = [ev('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text: '明天发布' }] }, sent)]
  const [entry] = formatSpan(events, { now: new Date('2025-09-20T10:00:00') })
  assert.match(entry.markdown, /2025-09-02发布/)
})

test('each assistant message carries only its own step\'s tool ledger', () => {
  const events = [
    ev('assistant/message', 1, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'step one' }] } }),
    ev('tool/call', 2, { turn: 1, step: 1, callId: 'a', name: 'grep' }),
    ev('tool/result', 3, { turn: 1, step: 1, message: { source: { callId: 'a' }, content: [{ type: 'text', text: 'found a' }] } }),
    ev('step/end', 4, { turn: 1, step: 1 }),
    ev('assistant/message', 5, { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'step two' }] } }),
    ev('tool/call', 6, { turn: 1, step: 2, callId: 'b', name: 'read' }),
    ev('tool/result', 7, { turn: 1, step: 2, message: { source: { callId: 'b' }, content: [{ type: 'text', text: 'read b' }] } }),
    ev('step/end', 8, { turn: 1, step: 2 }),
  ]
  const [first, second] = formatSpan(events, { now: NOW })
  assert.match(first.markdown, /`grep` — ✅ found a/)
  assert.ok(!first.markdown.includes('read b'), 'step 2 tools do not leak into step 1')
  assert.match(second.markdown, /`read` — ✅ read b/)
  assert.ok(!second.markdown.includes('found a'), 'step 1 tools do not leak into step 2')
})

test('a compaction replacement is not counted as tool activity', () => {
  // DSH compaction re-appends a pruned result right after its own
  // `compaction/prune` event, carrying the original turn and step.
  const events = [
    ev('assistant/message', 10, { turn: 4, step: 1, message: { content: [{ type: 'text', text: 'working' }] } }),
    ev('tool/call', 11, { turn: 4, step: 1, callId: 'c', name: 'grep' }),
    ev('tool/result', 12, { turn: 4, step: 1, message: { source: { callId: 'c' }, content: [{ type: 'text', text: 'real result' }] } }),
    ev('compaction/prune', 13, { shadowedRange: { start: 12, end: 13 } }),
    ev('tool/result', 14, { turn: 4, step: 1, message: { source: { callId: 'c' }, content: [{ type: 'text', text: 'pruned copy' }] } }),
  ]
  const [entry] = formatSpan(events, { now: NOW })
  assert.match(entry.markdown, /real result/)
  assert.ok(!entry.markdown.includes('pruned copy'))
  assert.ok(!entry.markdown.includes('×2'), 'not collapsed with its own copy either')
})

test('a replacement that opens the span is recognised through the event before it', () => {
  const prune = ev('compaction/prune', 99, {})
  const replacement = ev('tool/result', 100, { turn: 1, step: 1, message: { source: { callId: 'x' }, content: [] } })
  const bySeq = new Map([[100, replacement]])
  assert.equal(isCompactionReplacement(replacement, bySeq, prune), true)
  assert.equal(isCompactionReplacement(replacement, bySeq, undefined), false)
  assert.equal(isCompactionReplacement(replacement, bySeq, ev('step/end', 99, {})), false)
})

test('user messages are capped, and redacted before the cut', () => {
  // A cut landing inside a secret would leave a fragment too short to match:
  // capped first, the 1000-char cut keeps ` sk-AAAAAA` — six characters after
  // the prefix, under the pattern's minimum of eight — so it would leak as-is.
  const secret = 'sk-' + 'A'.repeat(40)
  const text = 'x'.repeat(989) + ' ' + secret + ' ' + 'y'.repeat(5000)
  const events = [ev('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text }] })]
  const [entry] = formatSpan(events, { now: NOW, maxUserChars: 1000 })
  assert.match(entry.markdown, /\[\.\.\.truncated \d+ chars\]/)
  assert.ok(!entry.markdown.includes('sk-AAAA'), 'no secret fragment survives the cut')
  assert.ok(entry.markdown.length < 1400)
})
