import test from 'node:test'
import assert from 'node:assert/strict'

import { countLoggableMessages, formatSpan, isLoggableMessage } from '../src/collector.js'

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
    ev('assistant/message', 2, { turn: 3, message: { content: [{ type: 'text', text: 'on it, 今天完成' }] } }),
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
