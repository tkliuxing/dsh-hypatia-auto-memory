import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ADJUDICATION_MAX_TOKENS,
  ADJUDICATION_REASONING_EFFORT,
  buildTranscript,
  consolidationStart,
  createConsolidator,
  parseConsolidationOutput,
  PermanentConsolidationError,
} from '../src/consolidator.js'
import { createWriter } from '../src/writer.js'
import { TaskDeferredError } from '../src/queue.js'
import { makeModelLogDouble } from './model-log-double.mjs'

const silentStatus = { warn: () => {}, info: () => {}, count: () => {}, error: () => {}, markConsolidated: () => {} }

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
  // Tool outputs themselves are not fed to the consolidation model.
  assert.ok(out.includes('T: grep ✅'))
  assert.ok(!out.includes('found 3 matches'))
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
  assert.ok(out.includes('T: read_file ✅'), out)
  assert.ok(!out.includes('line one'), out)
})

test('buildTranscript redacts secrets and absolutizes dates before the model call', () => {
  // Written a week after it was said: "today" is the day it was SAID.
  const now = new Date('2025-09-09T12:00:00')
  const said = new Date('2025-09-01T10:00:00').getTime()
  const events = [
    ev('user/message', 1, {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'deploy today with sk-abcdef1234567890XYZ and password="hunter22"' }],
    }, said),
  ]
  const { text: out } = buildTranscript(events, { maxInputTokens: 10000 }, now)
  assert.ok(!out.includes('sk-abcdef1234567890XYZ'), out)
  assert.ok(!out.includes('hunter22'), out)
  assert.ok(out.includes('[REDACTED:secret:key]'), out)
  assert.ok(out.includes('[REDACTED:secret:credential]'), out)
  assert.ok(out.includes('deploy 2025-09-01 with'), out)
  assert.ok(!out.includes('2025-09-09'), 'not the consolidation time')
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
function makeExecuteHarness({ events, maxInputTokens, inherited = 0, modelLog, finishKind = 'stop', finishFailure, replyText }) {
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
      const payload = replyText ?? JSON.stringify({ summary: '- did things', workUnits: [] })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: payload }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
      yield {
        type: 'finish',
        reason: finishFailure === undefined
          ? { kind: finishKind }
          : { kind: finishKind, failure: { message: finishFailure } },
      }
    },
  }
  const enqueued = []
  const consolidator = createConsolidator({
    queue: { async enqueue(task) { enqueued.push(task) } },
    progress,
    sessions: {
      get: () => ({
        seq: events.length,
        inheritedEventCount: inherited,
        snapshotEvents: (from, to = Infinity) => events.filter((e) => e.seq >= from && e.seq < to),
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
    modelLog,
    projectFor: async () => 'demo',
  })
  return { consolidator, progressMap, written, prompts, enqueued }
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

test('execute records the model attempt that produced the summary', async () => {
  // Without this row, "which model summarised that span" is unanswerable: the
  // cursor that picked it lives only in this process.
  const events = [
    ev('user/message', 0, { source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] }),
    ev('assistant/message', 1, { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } }),
  ]
  const modelLog = makeModelLogDouble()
  const h = makeExecuteHarness({ events, maxInputTokens: 10_000, modelLog })
  await h.consolidator.execute({ sessionId: 's1', fromSeq: 0, toSeq: 2, project: 'demo' })

  assert.deepEqual(modelLog.attempts.map((a) => [a.purpose, a.route, ...a.done]), [
    ['memory-consolidation', { provider: 'p', model: 'm' }, 'ok', ''],
  ])
})

test('a model call that ends without usable output is recorded as incomplete', async () => {
  // The output cap consumes the round-robin cursor and produces no summary, so
  // without this row a truncated attempt would look from outside exactly like
  // an attempt that never happened.
  const events = [
    ev('user/message', 0, { source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] }),
    ev('assistant/message', 1, { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } }),
  ]
  const modelLog = makeModelLogDouble()
  const h = makeExecuteHarness({ events, maxInputTokens: 10_000, modelLog, finishKind: 'max-tokens' })

  await assert.rejects(
    h.consolidator.execute({ sessionId: 's1', fromSeq: 0, toSeq: 2, project: 'demo' }),
    PermanentConsolidationError,
  )
  assert.deepEqual(modelLog.attempts.map((a) => [a.purpose, ...a.done]), [
    ['memory-consolidation', 'incomplete', 'max-tokens'],
  ])
  assert.deepEqual(h.written.knowledge, [], 'no summary is stored for an unusable reply')
})

test('an aborted call keeps the provider reason in the error it throws', async () => {
  // Recording must not change what the queue sees. `aborted` is the shape a
  // timeout arrives in, so dropping `failure.message` would replace "request
  // timed out after 120000ms" with a bare "aborted" in the task row.
  const events = [
    ev('user/message', 0, { source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] }),
    ev('assistant/message', 1, { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } }),
  ]
  const modelLog = makeModelLogDouble()
  const h = makeExecuteHarness({
    events, maxInputTokens: 10_000, modelLog,
    finishKind: 'aborted', finishFailure: 'request timed out after 120000ms',
  })

  await assert.rejects(
    h.consolidator.execute({ sessionId: 's1', fromSeq: 0, toSeq: 2, project: 'demo' }),
    /consolidation model call failed: request timed out after 120000ms/,
  )
  assert.deepEqual(modelLog.attempts.map((a) => [a.purpose, ...a.done]), [
    ['memory-consolidation', 'incomplete', 'request timed out after 120000ms'],
  ])
})

test('a stop that parses into nothing is incomplete, and never quotes the reply', async () => {
  // A stream that ends cleanly is not success: if the reply yields no summary,
  // nothing is stored and the cursor is gone. `parseConsolidationOutput`'s
  // message quotes the reply, so it must not become `detail` either.
  const events = [
    ev('user/message', 0, { source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] }),
    ev('assistant/message', 1, { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } }),
  ]
  const modelLog = makeModelLogDouble()
  const h = makeExecuteHarness({ events, maxInputTokens: 10_000, modelLog, replyText: 'Here is your summary: none' })

  await assert.rejects(
    h.consolidator.execute({ sessionId: 's1', fromSeq: 0, toSeq: 2, project: 'demo' }),
    PermanentConsolidationError,
  )
  assert.deepEqual(modelLog.attempts.map((a) => [a.purpose, ...a.done]), [
    ['memory-consolidation', 'incomplete', 'unusable output'],
  ])
  assert.ok(!JSON.stringify(modelLog.attempts).includes('Here is your summary'), 'model output reached diagnostics')
  assert.deepEqual(h.written.knowledge, [])
})

/** Minimal doubles for `adjudicate`, which needs only a route, a config and a stream. */
function makeAdjudicateHarness({
  replyText, finishKind = 'stop', throwError, modelLog,
  reasoningEfforts, resolveError, streams, resolveCalls, status = silentStatus,
}) {
  const llm = {
    async *stream(request) {
      streams?.push(request)
      if (throwError !== undefined) throw throwError
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: replyText }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: replyText } }
      yield { type: 'finish', reason: { kind: finishKind } }
    },
  }
  if (reasoningEfforts !== undefined || resolveError !== undefined) {
    llm.resolveModelInfo = async () => {
      if (resolveCalls !== undefined) resolveCalls.n += 1
      if (resolveError !== undefined) throw resolveError
      return { reasoning: { efforts: reasoningEfforts.map((id) => ({ id, name: id })) } }
    }
  }
  return createConsolidator({
    queue: {}, progress: {}, sessions: {}, llm, cli: {}, writer: {},
    getConfig: () => ({
      enabled: true,
      consolidation: {
        enabled: true, adjudicate: true, models: [{ provider: 'p', model: 'm' }],
        maxInputTokens: 1000, maxOutputTokens: 200, timeoutMs: 1000,
        checkEveryTurns: 5, minNewTokens: 100, maxWorkUnitsPerRun: 2,
      },
    }),
    status,
    modelLog,
    projectFor: async () => 'demo',
  })
}

const ADJUDICATE_UNIT = { title: 'New memory', content: 'body' }
const ADJUDICATE_CANDIDATES = [{ name: 'wu-old', content: { data: 'old' } }]

test('adjudication records the attempt and its route', async () => {
  const modelLog = makeModelLogDouble()
  const c = makeAdjudicateHarness({ replyText: '{"verdict":"refines","target":"wu-old"}', modelLog })

  const decision = await c.adjudicate(ADJUDICATE_UNIT, ADJUDICATE_CANDIDATES)

  assert.deepEqual(decision, { verdict: 'refines', target: 'wu-old' })
  assert.deepEqual(modelLog.attempts.map((a) => [a.purpose, a.route, ...a.done]), [
    ['memory-adjudication', { provider: 'p', model: 'm' }, 'ok', ''],
  ])
})

test('an unparseable verdict is incomplete and never quotes the reply', async () => {
  const modelLog = makeModelLogDouble()
  const c = makeAdjudicateHarness({ replyText: 'Sure! The verdict is refines', modelLog })

  assert.equal(await c.adjudicate(ADJUDICATE_UNIT, ADJUDICATE_CANDIDATES), undefined)
  assert.deepEqual(modelLog.attempts.map((a) => [a.purpose, ...a.done]), [
    ['memory-adjudication', 'incomplete', 'unparseable reply'],
  ])
  assert.ok(!JSON.stringify(modelLog.attempts).includes('Sure! The verdict'), 'model output reached diagnostics')
})

test('an adjudication call that throws is recorded as error', async () => {
  const modelLog = makeModelLogDouble()
  const c = makeAdjudicateHarness({ throwError: new Error('socket hang up'), modelLog })

  await assert.rejects(c.adjudicate(ADJUDICATE_UNIT, ADJUDICATE_CANDIDATES), /socket hang up/)
  assert.deepEqual(modelLog.attempts.map((a) => [a.purpose, ...a.done]), [
    ['memory-adjudication', 'error', 'socket hang up'],
  ])
})

test('adjudication asks the route to skip thinking when it advertises `off`', async () => {
  // A thinking-enabled route shares ONE output budget between its reasoning and
  // its answer. `deepseek-*` resolves an omitted effort to `high` and spends
  // about half its output on reasoning, which is how a 200-token adjudication
  // ended with `max-tokens` and stored every work unit with no relationship.
  const streams = []
  const modelLog = makeModelLogDouble()
  const c = makeAdjudicateHarness({
    replyText: '{"verdict":"refines","target":"wu-old"}', modelLog, streams,
    reasoningEfforts: ['off', 'low', 'high', 'max'],
  })

  const decision = await c.adjudicate(ADJUDICATE_UNIT, ADJUDICATE_CANDIDATES)

  assert.deepEqual(decision, { verdict: 'refines', target: 'wu-old' })
  assert.equal(streams[0].reasoningEffort, ADJUDICATION_REASONING_EFFORT)
  assert.equal(streams[0].maxTokens, ADJUDICATION_MAX_TOKENS)
  assert.ok(ADJUDICATION_MAX_TOKENS > 200, 'a route that cannot honour `off` still has to fit thinking')
  assert.deepEqual(modelLog.attempts.map((a) => [a.purpose, ...a.done]), [['memory-adjudication', 'ok', '']])
})

test('adjudication does not ask for an effort the route does not advertise', async () => {
  // The core rejects that outright (`UNSUPPORTED_REASONING_EFFORT`), so the
  // control must only ever follow a positive capability answer.
  const noOff = []
  await makeAdjudicateHarness({
    replyText: '{"verdict":"unrelated","target":""}', streams: noOff,
    reasoningEfforts: ['low', 'high'],
  }).adjudicate(ADJUDICATE_UNIT, ADJUDICATE_CANDIDATES)
  assert.equal('reasoningEffort' in noOff[0], false, 'a route without `off` keeps the provider default')

  // A model that declares no reasoning at all, and an `llm` that cannot answer.
  const noReasoning = []
  await makeAdjudicateHarness({ replyText: '{"verdict":"unrelated","target":""}', streams: noReasoning })
    .adjudicate(ADJUDICATE_UNIT, ADJUDICATE_CANDIDATES)
  assert.equal('reasoningEffort' in noReasoning[0], false)
})

test('the reasoning capability is looked up once per route', async () => {
  const resolveCalls = { n: 0 }
  const c = makeAdjudicateHarness({
    replyText: '{"verdict":"unrelated","target":""}', streams: [],
    reasoningEfforts: ['off'], resolveCalls,
  })

  await c.adjudicate(ADJUDICATE_UNIT, ADJUDICATE_CANDIDATES)
  await c.adjudicate(ADJUDICATE_UNIT, ADJUDICATE_CANDIDATES)

  assert.equal(resolveCalls.n, 1, 'capability does not change while the instance lives')
})

test('a capability lookup that fails still adjudicates, without the control', async () => {
  const warnings = []
  const streams = []
  const c = makeAdjudicateHarness({
    replyText: '{"verdict":"extends","target":"wu-old"}', streams,
    resolveError: new Error('provider is not registered'),
    status: { ...silentStatus, warn: (m) => warnings.push(m) },
  })

  const decision = await c.adjudicate(ADJUDICATE_UNIT, ADJUDICATE_CANDIDATES)

  assert.deepEqual(decision, { verdict: 'extends', target: 'wu-old' })
  assert.equal('reasoningEffort' in streams[0], false)
  assert.match(warnings[0], /reasoning capability lookup failed/)
})

test('consolidationStart never begins inside a fork\'s inherited prefix', () => {
  assert.equal(consolidationStart({ lastConsolidatedSeq: 0 }, { inheritedEventCount: 62678 }), 62678)
  assert.equal(consolidationStart({ lastConsolidatedSeq: 70000 }, { inheritedEventCount: 62678 }), 70000)
  assert.equal(consolidationStart(undefined, undefined), 0)
})

test('onTurnEnd schedules a fork from the end of its prefix, immediately', async () => {
  // Observed in the wild: a fork with a 62,678-event seed consolidated
  // [0, 45712) — entirely its parent's conversation — under its own id.
  const enqueued = []
  const c = createConsolidator({
    queue: { enqueue: async (t) => { enqueued.push(t) } },
    progress: { get: () => ({ lastLoggedSeq: 65723, lastConsolidatedSeq: 0, lastCheckTurn: 0, pendingTokens: 0 }) },
    sessions: { get: () => ({ seq: 65800, inheritedEventCount: 62678 }) },
    llm: {}, cli: {}, writer: {},
    getConfig: () => ({
      enabled: true,
      consolidation: { enabled: true, checkEveryTurns: 1, minNewTokens: 1, maxWorkUnitsPerRun: 3 },
    }),
    status: { warn: () => {}, info: () => {}, count: () => {}, error: () => {} },
    projectFor: async () => 'demo',
  })
  const decision = await c.onTurnEnd('s1', 5, { lastCheckTurn: 0, pendingTokens: 9999 })
  assert.deepEqual(decision, { resetTokens: true, advanceCheckpoint: true })
  assert.deepEqual(
    [enqueued[0].fromSeq, enqueued[0].toSeq, enqueued[0].immediate],
    [62678, 65723, true],
    'starts at the prefix end, and skips the two-minute flush window',
  )
})

test('execute skips a stale task that lies wholly inside the inherited prefix', async () => {
  // A task persisted by the buggy build can still be sitting in the table.
  const events = [ev('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text: 'parent talk' }] })]
  const h = makeExecuteHarness({ events, maxInputTokens: 10_000, inherited: 10 })
  await h.consolidator.execute({ sessionId: 's1', fromSeq: 0, toSeq: 8, project: 'demo' })

  assert.equal(h.prompts.length, 0, 'no model call spent re-summarising the parent')
  assert.equal(h.written.knowledge.length, 0)
  assert.equal(h.progressMap.get('s1').lastConsolidatedSeq, 10, 'watermark jumps past the prefix')
})

test('execute on a fork summarises only its own messages and links their real names', async () => {
  const msg = (seq, text) => ev('user/message', seq, { source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const events = [
    msg(0, 'parent message zero'), msg(1, 'parent message one'), msg(2, 'parent message two'), msg(3, 'parent message three'),
    msg(4, 'child message zero'), msg(5, 'child message one'), msg(6, 'child message two'),
  ]
  const h = makeExecuteHarness({ events, maxInputTokens: 10_000, inherited: 4 })
  await h.consolidator.execute({ sessionId: 's1', fromSeq: 0, toSeq: 7, project: 'demo' })

  assert.ok(!h.prompts[0].includes('parent message'), 'the prefix never reaches the model')
  assert.ok(h.prompts[0].includes('child message two'))
  assert.equal(h.written.knowledge[0].name, 'sum-s1-4-7')
  // The child's first own message is ordinal 0 — the same name the log
  // executor gave it — so the edge lands on the message the summary describes.
  assert.deepEqual(
    h.written.statements.filter(([, rel]) => rel === 'summary').map(([, , tail]) => tail),
    ['msg-s1-0', 'msg-s1-1', 'msg-s1-2'],
  )
  const cascade = h.enqueued.find((t) => t.kind === 'cascade')
  assert.deepEqual([cascade.fromSeq, cascade.immediate], [4, true])
})

test('execute defers, rather than fails, when the session is not loaded', async () => {
  const c = createConsolidator({
    queue: { async enqueue() {} },
    progress: { get: () => undefined, put: () => {} },
    sessions: { get: () => undefined },
    llm: {}, cli: {}, writer: {},
    getConfig: () => ({ consolidation: { models: [{ provider: 'p', model: 'm' }], maxInputTokens: 1000 } }),
    status: { info: () => {}, warn: () => {}, error: () => {}, count: () => {} },
    projectFor: async () => 'demo',
  })
  await assert.rejects(
    c.execute({ sessionId: 's9', fromSeq: 0, toSeq: 5, project: 'demo' }),
    (error) => error instanceof TaskDeferredError && error.deferred === true,
  )
})
