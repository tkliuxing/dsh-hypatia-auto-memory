import test from 'node:test'
import assert from 'node:assert/strict'

import { archiveName, createCascade, levelTag, notSummarisedQuery } from '../src/cascade.js'
import { THINKING_OUTPUT_ALLOWANCE } from '../src/consolidator.js'
import { makeModelLogDouble } from './model-log-double.mjs'

const ROUTE = { provider: 'p', model: 'm' }

function makeConfig({ batchSize = 3, enabled = true, models = [ROUTE], maxOutputTokens = 2000 } = {}) {
  return () => ({
    consolidation: {
      models,
      maxOutputTokens,
      timeoutMs: 30_000,
      cascade: { enabled, batchSize },
    },
  })
}

/**
 * A hypatia double whose `$not-summaried` answers are driven by the edges the
 * cascade itself writes — the property the real operator provides, and the one
 * that makes the loop terminate.
 */
function makeCli(entriesByTag) {
  const created = []
  const statements = []
  const summarised = new Set()
  return {
    created,
    statements,
    async query(jse) {
      const parsed = JSON.parse(jse)
      const [tag] = parsed['$not-summaried']
      const rows = (entriesByTag[tag] ?? []).filter((row) => !summarised.has(row.name))
      return rows.slice(0, parsed.limit)
    },
    async knowledgeGet(name) {
      return created.some((entry) => entry.name === name) ? { found: true, name, content: {} } : { found: false }
    },
    async knowledgeCreate(name, entry) {
      created.push({ name, ...entry })
      const tag = entry.tags.find((t) => t.startsWith('summary '))
      ;(entriesByTag[tag] ??= []).push({ name, content: { data: entry.data, tags: entry.tags } })
    },
    async statementCreate(head, relation, tail, entry = {}) {
      statements.push([head, relation, tail, entry.embed])
      if (relation === 'summary') summarised.add(tail)
    },
  }
}

function makeLlm(titles = [], { reasoningEfforts, usage } = {}) {
  let call = 0
  return {
    prompts: [],
    requests: [],
    // Absent unless a test declares it, so the purpose policy's silent path is
    // the one most tests exercise.
    ...reasoningEfforts === undefined ? {} : {
      async resolveModelInfo() {
        return { reasoning: { efforts: reasoningEfforts.map((id) => ({ id })) } }
      },
    },
    async *stream(request) {
      const title = titles[call] ?? `Tier archive ${call}`
      call += 1
      this.prompts.push(request.messages[0].content[0].text)
      this.requests.push(request)
      const payload = JSON.stringify({ title, summary: '- archived' })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: payload }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
      if (usage !== undefined) yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

const silentStatus = { info: () => {}, warn: () => {}, error: () => {}, count: () => {} }

/**
 * An llm double that hands back exactly the text (or failure) a test wants, so
 * the unusable-reply paths can be driven without inventing a provider.
 */
function makeRawLlm({ text = '', finishKind = 'stop', throwError } = {}) {
  return {
    async *stream() {
      if (throwError !== undefined) throw throwError
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: finishKind } }
    },
  }
}

function tierEntries(tag, count, prefix) {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}-${i}`,
    content: { data: `body ${i}`, tags: ['summary', tag] },
  }))
}

test('notSummarisedQuery uses the object form, the only one that carries limit', () => {
  // The array form with a trailing metadata object is rejected outright by the
  // evaluator (asserted against the real CLI in test/integration).
  const parsed = JSON.parse(notSummarisedQuery('summary 1', 'demo', 16))
  assert.deepEqual(parsed, {
    '$not-summaried': ['summary 1', ['$contains', 'scopes', 'demo']],
    limit: 16,
  })
})

test('archiveName is derived from members, so a replay reproduces it', () => {
  const members = ['sum-a-0-1', 'sum-a-1-2', 'sum-a-2-3']
  assert.equal(archiveName(2, members), archiveName(2, [...members].reverse()), 'order-independent')
  assert.notEqual(archiveName(2, members), archiveName(3, members), 'tier is part of the identity')
  assert.notEqual(archiveName(2, members), archiveName(2, [...members, 'sum-a-3-4']))
  assert.match(archiveName(2, members), /^sum2-[0-9a-f]{12}$/)
})

test('the cascade degrades down the priority list with its own attempt count', async () => {
  // The archive is a separate queue task with its own retries, so it has to
  // carry its own attempt index: a retry must reach the fallback route, and a
  // first attempt must not be handed one.
  const entriesByTag = { [levelTag(1)]: tierEntries(levelTag(1), 3, 'sum-s1') }
  const seen = []
  const routeFor = (routes, attempt) => {
    seen.push(attempt)
    return ROUTE
  }
  const cascade = createCascade({
    cli: makeCli(entriesByTag), llm: makeLlm(['Storage rewrite']), selectRoute: routeFor,
    getConfig: makeConfig({ batchSize: 3 }), status: silentStatus,
  })

  await cascade.execute({ project: 'demo', attempts: 1 })

  assert.deepEqual(seen, [1])
})

test('a cascading run picks one route and archives every tier with it', async () => {
  const entriesByTag = { [levelTag(1)]: tierEntries(levelTag(1), 9, 'sum-s1') }
  const seen = []
  const cascade = createCascade({
    cli: makeCli(entriesByTag), llm: makeLlm(['Storage rewrite']),
    selectRoute: (routes, attempt) => {
      seen.push(attempt)
      return ROUTE
    },
    getConfig: makeConfig({ batchSize: 3 }), status: silentStatus,
  })

  await cascade.execute({ project: 'demo', attempts: 0 })

  assert.deepEqual(seen, [0], 'one selection for the whole climb')
})

test('the cascade sends the configured thinking level, with the cap to pay for it', async () => {
  // The archive is the one purpose whose default is to think, so this is where a
  // per-route level earns its keep — and where the level must reach every tier
  // of one climb, not just the first.
  const entriesByTag = { [levelTag(1)]: tierEntries(levelTag(1), 9, 'sum-s1') }
  const llm = makeLlm(['Storage rewrite'], { reasoningEfforts: ['off', 'low', 'high'] })
  const modelLog = makeModelLogDouble()
  const cascade = createCascade({
    cli: makeCli(entriesByTag), llm,
    selectRoute: () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' }),
    getConfig: makeConfig({ batchSize: 3, models: [{ provider: 'p', model: 'm', reasoningEffort: 'high' }] }),
    status: silentStatus, modelLog,
  })

  // Three runs: 9 tier-1 entries at 3:1 fill tier 2 over three archive calls, and
  // the third run also climbs to tier 3 — four calls, every one of them carrying
  // the same level, because a run resolves it once and keeps it for the climb.
  await cascade.execute({ project: 'demo', attempts: 0 })
  await cascade.execute({ project: 'demo', attempts: 0 })
  await cascade.execute({ project: 'demo', attempts: 0 })

  assert.equal(llm.requests.length, 4, 'the oldest unfinished batch, plus the tier the third run completes')
  assert.deepEqual([...new Set(llm.requests.map((r) => r.reasoningEffort))], ['high'])
  assert.deepEqual([...new Set(llm.requests.map((r) => r.maxTokens))], [2000 + THINKING_OUTPUT_ALLOWANCE],
    'thinking and the archive share the cap, so the allowance must be there')
  assert.deepEqual(modelLog.attempts.map((a) => a.effort), ['high', 'high', 'high', 'high'])
})

test('the cascade sends no effort by default, leaving the adapter default alone', async () => {
  // The purpose policy has no opinion here: an omitted effort is what lets
  // `llm-deepseek` resolve its own default (`high`) instead of the plugin
  // second-guessing it.
  const entriesByTag = { [levelTag(1)]: tierEntries(levelTag(1), 3, 'sum-s1') }
  const llm = makeLlm(['Storage rewrite'], { reasoningEfforts: ['off', 'high'] })
  const modelLog = makeModelLogDouble()
  const cascade = createCascade({
    cli: makeCli(entriesByTag), llm, selectRoute: () => ROUTE,
    getConfig: makeConfig({ batchSize: 3 }), status: silentStatus, modelLog,
  })

  await cascade.execute({ project: 'demo', attempts: 0 })

  assert.equal(llm.requests[0].reasoningEffort, undefined, '`off` is extraction policy, not archive policy')
  assert.equal(llm.requests[0].maxTokens, 2000 + THINKING_OUTPUT_ALLOWANCE)
  assert.deepEqual(modelLog.attempts.map((a) => a.effort), [undefined])
})

test('the cascade records the token split of its archive call', async () => {
  const entriesByTag = { [levelTag(1)]: tierEntries(levelTag(1), 3, 'sum-s1') }
  const modelLog = makeModelLogDouble()
  const cascade = createCascade({
    cli: makeCli(entriesByTag),
    llm: makeLlm(['Storage rewrite'], { usage: { inputTokens: 900, outputTokens: 700, reasoningTokens: 250 } }),
    selectRoute: () => ROUTE,
    getConfig: makeConfig({ batchSize: 3 }), status: silentStatus, modelLog,
  })

  await cascade.execute({ project: 'demo', attempts: 0 })

  assert.deepEqual(modelLog.attempts.map((a) => a.usage), [
    { inputTokens: 900, outputTokens: 700, reasoningTokens: 250 },
  ])
})

test('a full batch archives one tier up and links every member', async () => {
  const entriesByTag = { [levelTag(1)]: tierEntries(levelTag(1), 3, 'sum-s1') }
  const cli = makeCli(entriesByTag)
  const cascade = createCascade({
    cli, llm: makeLlm(['Storage rewrite']), selectRoute: () => ROUTE,
    getConfig: makeConfig({ batchSize: 3 }), status: silentStatus,
  })

  await cascade.execute({ project: 'demo' })

  assert.equal(cli.created.length, 1)
  const archive = cli.created[0]
  assert.deepEqual(archive.tags, ['summary', 'summary 2'])
  assert.deepEqual(archive.scopes, ['demo'])
  // The model's descriptive title lives in the body, not the key: on a retry it
  // could be worded differently and would silently fork the entry.
  assert.match(archive.data, /^# Storage rewrite\n/)
  assert.deepEqual(
    cli.statements.map(([, relation, tail]) => [relation, tail]),
    [['summary', 'sum-s1-0'], ['summary', 'sum-s1-1'], ['summary', 'sum-s1-2']],
  )
  // The archive is distilled knowledge and is embedded; its edges are for the
  // traversal and `$not-summaried` only, so they opt out of the vector index.
  assert.notEqual(archive.embed, false)
  assert.deepEqual(cli.statements.map(([, , , embed]) => embed), [false, false, false])
})

test('a short tier archives nothing and stops the climb', async () => {
  const entriesByTag = { [levelTag(1)]: tierEntries(levelTag(1), 2, 'sum-s1') }
  const cli = makeCli(entriesByTag)
  const cascade = createCascade({
    cli, llm: makeLlm(), selectRoute: () => ROUTE,
    getConfig: makeConfig({ batchSize: 3 }), status: silentStatus,
  })
  await cascade.execute({ project: 'demo' })
  assert.deepEqual(cli.created, [])
  assert.deepEqual(cli.statements, [])
})

test('the climb continues while each tier keeps filling a batch', async () => {
  // Nine tier-1 entries at 3:1 make three tier-2 entries, which themselves make
  // one tier-3 entry — the log₁₆(n) shape, with a smaller constant.
  const entriesByTag = { [levelTag(1)]: tierEntries(levelTag(1), 9, 'sum-s1') }
  const cli = makeCli(entriesByTag)
  const cascade = createCascade({
    cli, llm: makeLlm(), selectRoute: () => ROUTE,
    getConfig: makeConfig({ batchSize: 3 }), status: silentStatus,
  })

  // Tier 2 archives the oldest three per run, so three runs fill the tier.
  await cascade.execute({ project: 'demo' })
  await cascade.execute({ project: 'demo' })
  await cascade.execute({ project: 'demo' })

  const tiers = cli.created.map((entry) => entry.tags[1])
  assert.equal(tiers.filter((t) => t === 'summary 2').length, 3)
  assert.equal(tiers.filter((t) => t === 'summary 3').length, 1, 'the third run climbs a tier')
  // Every tier-2 entry is itself archived, so nothing is left dangling.
  const archivedTails = new Set(cli.statements.map(([, , tail]) => tail))
  for (const entry of cli.created.filter((e) => e.tags[1] === 'summary 2')) {
    assert.ok(archivedTails.has(entry.name), `${entry.name} was archived upward`)
  }
})

test('an existing archive entry still gets its edges asserted', async () => {
  // The entry and its edges are separate CLI calls; a crash between them must be
  // repairable by a replay rather than leaving an archive with no members.
  const entriesByTag = { [levelTag(1)]: tierEntries(levelTag(1), 3, 'sum-s1') }
  const cli = makeCli(entriesByTag)
  const members = ['sum-s1-0', 'sum-s1-1', 'sum-s1-2']
  cli.created.push({ name: archiveName(2, members), tags: ['summary', 'summary 2'], data: '# prior' })
  const llm = makeLlm()
  const cascade = createCascade({
    cli, llm, selectRoute: () => ROUTE,
    getConfig: makeConfig({ batchSize: 3 }), status: silentStatus,
  })

  await cascade.execute({ project: 'demo' })

  assert.equal(llm.prompts.length, 0, 'no second model call for an entry that exists')
  assert.equal(cli.statements.length, 3, 'edges asserted anyway')
})

test('cascade is a no-op when disabled or when no route is selected', async () => {
  const entries = () => ({ [levelTag(1)]: tierEntries(levelTag(1), 3, 'sum-s1') })

  const offCli = makeCli(entries())
  await createCascade({
    cli: offCli, llm: makeLlm(), selectRoute: () => ROUTE,
    getConfig: makeConfig({ batchSize: 3, enabled: false }), status: silentStatus,
  }).execute({ project: 'demo' })
  assert.deepEqual(offCli.created, [])

  const routelessCli = makeCli(entries())
  await createCascade({
    cli: routelessCli, llm: makeLlm(), selectRoute: () => undefined,
    getConfig: makeConfig({ batchSize: 3 }), status: silentStatus,
  }).execute({ project: 'demo' })
  assert.deepEqual(routelessCli.created, [])
})

test('a failing tier query stops the climb without throwing', async () => {
  const cli = makeCli({ [levelTag(1)]: tierEntries(levelTag(1), 3, 'sum-s1') })
  cli.query = async () => { throw new Error('shelf not connected') }
  const warnings = []
  const cascade = createCascade({
    cli, llm: makeLlm(), selectRoute: () => ROUTE,
    getConfig: makeConfig({ batchSize: 3 }),
    status: { ...silentStatus, warn: (m) => warnings.push(m) },
  })
  await cascade.execute({ project: 'demo' })
  assert.equal(cli.created.length, 0)
  assert.match(warnings[0], /cascade query failed/)
})

test('the archive call records which route actually ran it', async () => {
  // The route comes from a process-local cursor, so without this record "which
  // model archived that tier" is unanswerable from outside the process.
  const cli = makeCli({ [levelTag(1)]: tierEntries(levelTag(1), 3, 'sum-s1') })
  const modelLog = makeModelLogDouble()
  const cascade = createCascade({
    cli, llm: makeLlm(['Storage rewrite']), selectRoute: () => ROUTE,
    getConfig: makeConfig({ batchSize: 3 }), status: silentStatus, modelLog,
  })

  await cascade.execute({ project: 'demo' })

  assert.deepEqual(modelLog.attempts.map((a) => [a.purpose, a.route, ...a.done]), [
    ['memory-cascade', ROUTE, 'ok', ''],
  ])
})

test('an archive call that ends on the output cap is incomplete, not ok', async () => {
  const cli = makeCli({ [levelTag(1)]: tierEntries(levelTag(1), 3, 'sum-s1') })
  const modelLog = makeModelLogDouble()
  const warnings = []
  const cascade = createCascade({
    cli, llm: makeRawLlm({ text: '{"title":"x","summary":"- y"', finishKind: 'max-tokens' }),
    selectRoute: () => ROUTE,
    getConfig: makeConfig({ batchSize: 3 }),
    status: { ...silentStatus, warn: (m) => warnings.push(m) },
    modelLog,
  })

  await cascade.execute({ project: 'demo' })

  assert.deepEqual(modelLog.attempts.map((a) => [a.purpose, ...a.done]), [
    ['memory-cascade', 'incomplete', 'max-tokens'],
  ])
  assert.deepEqual(cli.created, [])
  assert.match(warnings[0], /produced nothing usable/)
})

test('an unparseable reply is incomplete and never quotes the reply', async () => {
  // Node's JSON.parse error carries the offending input, so recording the
  // thrown message would put model output in the diagnostics table and the log.
  const cli = makeCli({ [levelTag(1)]: tierEntries(levelTag(1), 3, 'sum-s1') })
  const modelLog = makeModelLogDouble()
  const cascade = createCascade({
    cli, llm: makeRawLlm({ text: 'Here is the archive you asked for' }), selectRoute: () => ROUTE,
    getConfig: makeConfig({ batchSize: 3 }), status: silentStatus, modelLog,
  })

  await cascade.execute({ project: 'demo' })

  assert.deepEqual(modelLog.attempts.map((a) => [a.purpose, ...a.done]), [
    ['memory-cascade', 'incomplete', 'unparseable reply'],
  ])
  assert.ok(!JSON.stringify(modelLog.attempts).includes('Here is the archive'), 'model output reached diagnostics')
})

test('an archive call that throws is recorded as error with its message', async () => {
  const cli = makeCli({ [levelTag(1)]: tierEntries(levelTag(1), 3, 'sum-s1') })
  const modelLog = makeModelLogDouble()
  const cascade = createCascade({
    cli, llm: makeRawLlm({ throwError: new Error('socket hang up') }), selectRoute: () => ROUTE,
    getConfig: makeConfig({ batchSize: 3 }), status: silentStatus, modelLog,
  })

  await assert.rejects(cascade.execute({ project: 'demo' }), /socket hang up/)
  assert.deepEqual(modelLog.attempts.map((a) => [a.purpose, ...a.done]), [
    ['memory-cascade', 'error', 'socket hang up'],
  ])
  assert.deepEqual(cli.created, [])
})
