import test from 'node:test'
import assert from 'node:assert/strict'

import { archiveName, createCascade, levelTag, notSummarisedQuery } from '../src/cascade.js'

const ROUTE = { provider: 'p', model: 'm' }

function makeConfig({ batchSize = 3, enabled = true } = {}) {
  return () => ({
    consolidation: {
      models: [ROUTE],
      maxOutputTokens: 2000,
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
    async statementCreate(head, relation, tail) {
      statements.push([head, relation, tail])
      if (relation === 'summary') summarised.add(tail)
    },
  }
}

function makeLlm(titles = []) {
  let call = 0
  return {
    prompts: [],
    async *stream(request) {
      const title = titles[call] ?? `Tier archive ${call}`
      call += 1
      this.prompts.push(request.messages[0].content[0].text)
      const payload = JSON.stringify({ title, summary: '- archived' })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: payload }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

const silentStatus = { info: () => {}, warn: () => {}, error: () => {}, count: () => {} }

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
