import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTranscript,
  createConsolidator,
  parseConsolidationOutput,
  PermanentConsolidationError,
} from '../src/consolidator.js'
import { createWriter } from '../src/writer.js'

function ev(type, seq, data = {}, time = 1725800000000) {
  return { type, seq, time, data }
}

test('buildTranscript renders roles and folds tool outcomes', () => {
  const events = [
    ev('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text: 'fix the bug' }] }),
    ev('tool/call', 2, { callId: 'c1', name: 'grep' }),
    ev('tool/result', 3, {
      message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'found 3 matches' }] },
    }),
    ev('assistant/message', 4, { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } }),
    // plugin-sourced user message must be skipped
    ev('user/message', 5, { source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: 'ctx' }] }),
  ]
  const { text: out, complete } = buildTranscript(events, { maxInputTokens: 10000 })
  assert.equal(complete, true)
  assert.ok(out.includes('U: fix the bug'))
  // The tool's readable NAME, resolved from the paired tool/call — not its callId.
  assert.ok(out.includes('T: grep ✅ found 3 matches'))
  assert.ok(out.includes('A: done'))
  assert.ok(!out.includes('ctx'))
})

test('buildTranscript unwraps nested tool-result blocks', () => {
  // A real DSH tool/result nests the payload: the message carries one
  // `tool-result` block whose own `content` holds the tool's blocks.
  const events = [
    ev('tool/call', 1, { callId: 'c1', name: 'read_file' }),
    ev('tool/result', 2, {
      message: {
        source: { callId: 'c1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'line one' }],
        }],
      },
    }),
  ]
  const { text: out } = buildTranscript(events, { maxInputTokens: 10000 })
  assert.ok(out.includes('T: read_file ✅ line one'), out)
})

test('buildTranscript redacts secrets and absolutizes dates before the model call', () => {
  const now = new Date('2025-09-09T12:00:00')
  const events = [
    ev('user/message', 1, {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'deploy today with sk-abcdef1234567890XYZ and password="hunter22"' }],
    }),
  ]
  const { text: out } = buildTranscript(events, { maxInputTokens: 10000 }, now)
  assert.ok(!out.includes('sk-abcdef1234567890XYZ'), out)
  assert.ok(!out.includes('hunter22'), out)
  assert.ok(out.includes('[REDACTED:secret:key]'), out)
  assert.ok(out.includes('[REDACTED:secret:credential]'), out)
  assert.ok(out.includes('2025-09-09'), out)
})

test('buildTranscript marks failed tools', () => {
  const events = [
    ev('tool/result', 1, {
      error: { name: 'Error', code: 'ENOENT' },
      message: { source: { callId: 'c9' }, content: [{ type: 'text', text: 'no such file' }] },
    }),
  ]
  const { text: out } = buildTranscript(events, { maxInputTokens: 10000 })
  // No paired tool/call in this span, so the name degrades to the generic label.
  assert.ok(out.includes('T: tool ❌'))
})

test('buildTranscript caps input keeping the OLDEST content and reports its reach', () => {
  // FIFO, per the protocol's batch order: an over-budget span consolidates its
  // head now and reports `lastSeq` so the watermark stops there. Keeping the
  // tail instead would strip content the caller then marked as consolidated.
  const events = []
  for (let i = 0; i < 100; i += 1) {
    events.push(ev('user/message', i, {
      source: { kind: 'user' },
      content: [{ type: 'text', text: `message ${i} ${'x'.repeat(200)}` }],
    }))
  }
  const { text: out, lastSeq, complete } = buildTranscript(events, { maxInputTokens: 1000 })
  assert.equal(complete, false)
  assert.ok(out.includes('message 0 '))
  assert.ok(!out.includes('message 99'))
  assert.ok(out.includes('later content deferred'))
  assert.ok(lastSeq >= 0 && lastSeq < 99, `lastSeq=${lastSeq}`)
})

test('buildTranscript admits an oversized single entry rather than wedging', () => {
  // Without this, a message larger than the whole budget would keep the
  // watermark pinned and every later trigger would re-run the same span.
  const events = [ev('user/message', 7, {
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'y'.repeat(50_000) }],
  })]
  const { text: out, lastSeq, complete } = buildTranscript(events, { maxInputTokens: 100 })
  assert.equal(complete, true)
  assert.equal(lastSeq, 7)
  assert.ok(out.includes('[...truncated'))
})

test('parseConsolidationOutput accepts a valid payload', () => {
  const parsed = parseConsolidationOutput(JSON.stringify({
    summary: '- did things',
    workUnits: [{ title: 'T', classification: 'bug-fix', content: '## Context', tags: ['a'] }],
  }), 3)
  assert.equal(parsed.summary, '- did things')
  assert.equal(parsed.workUnits.length, 1)
})

test('parseConsolidationOutput tolerates a markdown fence', () => {
  const parsed = parseConsolidationOutput('```json\n{"summary":"s","workUnits":[]}\n```', 3)
  assert.equal(parsed.summary, 's')
})

test('parseConsolidationOutput rejects garbage permanently', () => {
  assert.throws(() => parseConsolidationOutput('not json', 3), PermanentConsolidationError)
  assert.throws(() => parseConsolidationOutput('{"summary":""}', 3), PermanentConsolidationError)
  assert.throws(() => parseConsolidationOutput('[]', 3), PermanentConsolidationError)
  assert.throws(
    () => parseConsolidationOutput(JSON.stringify({
      summary: 'ok',
      workUnits: [{ title: '', content: 'x' }],
    }), 3),
    PermanentConsolidationError,
  )
})

test('parseConsolidationOutput trims an over-eager work-unit list instead of rejecting it', () => {
  // `maxWorkUnits` is a prompt instruction, not a contract. Rejecting the whole
  // answer for one extra unit also discarded a usable summary and left the
  // watermark in place, so every later trigger re-ran the same growing span.
  const parsed = parseConsolidationOutput(JSON.stringify({
    summary: 'ok',
    workUnits: Array.from({ length: 4 }, (_, i) => ({ title: `t${i}`, content: 'c' })),
  }), 3)
  assert.equal(parsed.summary, 'ok')
  assert.equal(parsed.workUnits.length, 3)
  assert.deepEqual(parsed.workUnits.map((u) => u.title), ['t0', 't1', 't2'])
})

test('onTurnEnd triggers only when both thresholds are met', async () => {
  const { createConsolidator } = await import('../src/consolidator.js')
  const enqueued = []
  const progress = {
    get: () => ({ lastLoggedSeq: 10, lastConsolidatedSeq: 2, lastCheckTurn: 0, pendingTokens: 0 }),
  }
  const sessions = { get: () => ({ seq: 10 }) }
  const c = createConsolidator({
    queue: { enqueue: async (t) => { enqueued.push(t) } },
    progress,
    sessions,
    llm: {},
    cli: {},
    writer: {},
    getConfig: () => ({
      enabled: true,
      consolidation: {
        enabled: true, provider: 'p', model: 'm', maxInputTokens: 1000,
        maxOutputTokens: 100, timeoutMs: 1000, checkEveryTurns: 5,
        minNewTokens: 100, maxWorkUnitsPerRun: 2,
      },
    }),
    status: { warn: () => {}, info: () => {}, count: () => {}, error: () => {}, markConsolidated: () => {} },
    projectFor: async () => 'demo',
  })
  // elapsed 4 < 5 -> turn gate closed
  let d = await c.onTurnEnd('s1', 4, { lastCheckTurn: 0, pendingTokens: 500 })
  assert.deepEqual(d, { resetTokens: false, advanceCheckpoint: false })
  assert.equal(enqueued.length, 0)
  // elapsed 5 but tokens 50 < 100 -> retain the anchor so turn 6 retries
  d = await c.onTurnEnd('s1', 5, { lastCheckTurn: 0, pendingTokens: 50 })
  assert.deepEqual(d, { resetTokens: false, advanceCheckpoint: false })
  assert.equal(enqueued.length, 0)
  // both thresholds -> trigger; range = [lastConsolidatedSeq, min(seq,lastLoggedSeq)]
  d = await c.onTurnEnd('s1', 6, { lastCheckTurn: 0, pendingTokens: 500 })
  assert.deepEqual(d, { resetTokens: true, advanceCheckpoint: true })
  assert.equal(enqueued.length, 1)
  assert.deepEqual(
    [enqueued[0].fromSeq, enqueued[0].toSeq, enqueued[0].project],
    [2, 10, 'demo'],
  )
})

test('onTurnEnd retains the checkpoint while consolidation is disabled', async () => {
  const { createConsolidator } = await import('../src/consolidator.js')
  const c = createConsolidator({
    queue: { enqueue: async () => { throw new Error('must not enqueue') } },
    progress: { get: () => ({ lastLoggedSeq: 10, lastConsolidatedSeq: 0 }) },
    sessions: { get: () => ({ seq: 10 }) },
    llm: {},
    cli: {},
    writer: {},
    getConfig: () => ({
      enabled: true,
      consolidation: { enabled: false },
    }),
    status: { warn: () => {}, info: () => {}, count: () => {}, error: () => {}, markConsolidated: () => {} },
    projectFor: async () => 'demo',
  })
  const d = await c.onTurnEnd('s1', 99, { lastCheckTurn: 0, pendingTokens: 99999 })
  assert.deepEqual(d, { resetTokens: false, advanceCheckpoint: false })
})

/** Minimal doubles for a full `execute` run. */
function makeExecuteHarness({ events, maxInputTokens }) {
  const progressMap = new Map()
  const progress = {
    get: (k) => progressMap.get(k),
    put: (k, v) => void progressMap.set(k, v),
  }
  const written = { knowledge: [], statements: [] }
  const cli = {
    async knowledgeGet() { return { found: false } },
    async knowledgeCreate(name, entry) { written.knowledge.push({ name, entry }) },
    async statementCreate(head, relation, tail) { written.statements.push([head, relation, tail]) },
    async search() { return [] },
  }
  const status = {
    info: () => {}, warn: () => {}, error: () => {},
    count: () => {}, markConsolidated: () => {},
  }
  const prompts = []
  const llm = {
    async *stream(request) {
      prompts.push(request.messages[0].content[0].text)
      const payload = JSON.stringify({ summary: '- did things', workUnits: [] })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: payload }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const consolidator = createConsolidator({
    queue: { async enqueue() {} },
    progress,
    sessions: {
      get: () => ({
        seq: events.length,
        snapshotEvents: (from, to) => events.filter((e) => e.seq >= from && e.seq < to),
      }),
    },
    llm,
    cli,
    writer: createWriter(cli, { status }),
    getConfig: () => ({
      enabled: true,
      consolidation: {
        enabled: true,
        models: [{ provider: 'p', model: 'm' }],
        maxInputTokens,
        maxOutputTokens: 2000,
        timeoutMs: 30_000,
        checkEveryTurns: 5,
        minNewTokens: 3000,
        maxWorkUnitsPerRun: 3,
      },
    }),
    status,
    projectFor: async () => 'demo',
  })
  return { consolidator, progressMap, written, prompts }
}

test('execute advances the watermark only over the span it actually consolidated', async () => {
  // Truncating the transcript but marking the whole task range consolidated
  // meant the dropped prefix was never extracted by anything, ever.
  const events = []
  for (let i = 0; i < 40; i += 1) {
    events.push(ev('user/message', i, {
      source: { kind: 'user' },
      content: [{ type: 'text', text: `message ${i} ${'x'.repeat(300)}` }],
    }))
  }
  const h = makeExecuteHarness({ events, maxInputTokens: 250 })
  await h.consolidator.execute({ sessionId: 's1', fromSeq: 0, toSeq: 40, project: 'demo' })

  const watermark = h.progressMap.get('s1').lastConsolidatedSeq
  assert.ok(watermark > 0 && watermark < 40, `watermark=${watermark} should stop short of 40`)
  // The summary entry names the range it truly covers, not the range requested.
  assert.equal(h.written.knowledge[0].name, `sum-s1-0-${watermark}`)
  // Every message inside that range is linked, and nothing beyond it is.
  const linked = h.written.statements.filter(([, rel]) => rel === 'summary').map(([, , tail]) => tail)
  assert.equal(linked.length, watermark)
  assert.equal(linked[linked.length - 1], `msg-s1-${watermark - 1}`)
})

test('execute covers the whole span when it fits, and never ships raw secrets', async () => {
  const events = [
    ev('user/message', 0, {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'deploy with sk-abcdef1234567890XYZ' }],
    }),
    ev('assistant/message', 1, { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } }),
  ]
  const h = makeExecuteHarness({ events, maxInputTokens: 10_000 })
  await h.consolidator.execute({ sessionId: 's1', fromSeq: 0, toSeq: 2, project: 'demo' })

  assert.equal(h.progressMap.get('s1').lastConsolidatedSeq, 2)
  assert.equal(h.written.knowledge[0].name, 'sum-s1-0-2')
  assert.equal(h.prompts.length, 1)
  assert.ok(!h.prompts[0].includes('sk-abcdef1234567890XYZ'), 'secret reached the model')
  assert.ok(h.prompts[0].includes('[REDACTED:secret:key]'))
})
