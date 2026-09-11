import test from 'node:test'
import assert from 'node:assert/strict'

import { countLoggableMessages, formatDuration, formatSpan, isCompactionReplacement, isLoggableMessage } from '../src/collector.js'

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
  // Two identical grep rows collapse into one with a counter and a total time.
  assert.match(out.markdown, /`grep` ×2 — ✅ 0ms total/)
  assert.match(out.markdown, /`bash` — ❌ 0ms — Error \(ENOENT\) — missing/)
  assert.ok(!out.markdown.includes('✅ ok'), 'a successful call\'s output is not stored')
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
  assert.match(first.markdown, /1\. `grep` — ✅/)
  assert.ok(!first.markdown.includes('`read`'), 'step 2 tools do not leak into step 1')
  assert.match(second.markdown, /1\. `read` — ✅/)
  assert.ok(!second.markdown.includes('`grep`'), 'step 1 tools do not leak into step 2')
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
  const ledger = entry.markdown.split('## Tool Calls')[1]
  assert.match(ledger, /1\. `grep` — ✅/)
  assert.ok(!/\n2\. /.test(ledger), 'the copy adds no second row')
  assert.ok(!ledger.includes('×2'), 'nor is it counted into the first')
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

test('the ledger records what was called, how long, and whether it worked — never the output', () => {
  // The hypatia-memory protocol: "never raw outputs". Output excerpts were 84% of
  // all stored message bytes, mostly file contents from `read`.
  const t0 = new Date('2025-09-09T10:00:00').getTime()
  const events = [
    ev('assistant/message', 1, { turn: 1, step: 1, message: { content: [
      { type: 'text', text: 'checking' },
      { type: 'tool-call', id: 'r1', name: 'read', arguments: '{}' },
    ] } }, t0),
    ev('tool/call', 2, { turn: 1, step: 1, callId: 'r1', name: 'read' }, t0),
    ev('tool/result', 3, { turn: 1, step: 1, message: { source: { callId: 'r1' }, content: [
      { type: 'tool-result', toolCallId: 'r1', content: [{ type: 'text', text: 'FILE CONTENTS line 1\nline 2' }] },
    ] } }, t0 + 340),
    ev('tool/call', 4, { turn: 1, step: 1, callId: 'r2', name: 'read' }, t0 + 400),
    ev('tool/result', 5, { turn: 1, step: 1, message: { source: { callId: 'r2' }, content: [{ type: 'text', text: 'more file text' }] } }, t0 + 1400),
    ev('tool/call', 6, { turn: 1, step: 1, callId: 'b1', name: 'bash' }, t0 + 1500),
    ev('tool/result', 7, { turn: 1, step: 1, error: { name: 'Error', code: 'ENOENT' }, message: { source: { callId: 'b1' }, content: [
      { type: 'text', text: 'Error: no such file\n    at foo (x.js:1:1)' },
    ] } }, t0 + 3500),
  ]
  const [entry] = formatSpan(events, { now: NOW })
  const ledger = entry.markdown.split('## Tool Calls')[1]
  assert.match(ledger, /1\. `read` ×2 — ✅ 1\.3s total/)
  assert.match(ledger, /2\. `bash` — ❌ 2\.0s — Error \(ENOENT\) — Error: no such file$/m)
  assert.ok(!entry.markdown.includes('FILE CONTENTS') && !entry.markdown.includes('more file text'), 'no output stored')
  assert.ok(!entry.markdown.includes(' at foo'), 'stack frames stripped from the error line')
  assert.match(entry.markdown, /## Content\nchecking\n/)
  assert.ok(!entry.markdown.includes('[tool-call]'), 'no placeholder for the call itself')
})

test('a step that only calls tools says so instead of storing placeholders', () => {
  const events = [
    ev('assistant/message', 1, { turn: 1, step: 1, message: { content: [{ type: 'tool-call', id: 'g', name: 'grep', arguments: '{}' }] } }),
    ev('tool/call', 2, { turn: 1, step: 1, callId: 'g', name: 'grep' }),
    ev('tool/result', 3, { turn: 1, step: 1, message: { source: { callId: 'g' }, content: [] } }),
  ]
  const [entry] = formatSpan(events, { now: NOW })
  assert.match(entry.markdown, /## Content\n\(tool calls only\)/)
  assert.ok(!entry.markdown.includes('[tool-call]'))
})

test('formatDuration stays human-scale', () => {
  assert.equal(formatDuration(340), '340ms')
  assert.equal(formatDuration(2400), '2.4s')
  assert.equal(formatDuration(192_000), '3m12s')
})
