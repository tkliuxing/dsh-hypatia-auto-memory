import test from 'node:test'
import assert from 'node:assert/strict'

import { createWriter } from '../src/writer.js'

/**
 * In-memory hypatia CLI stub with scripted behaviors. `features` is what the
 * binary would report; the default is one that embeds on request but cannot
 * filter `similar`, so the over-fetch path is the one most tests exercise.
 */
function makeStub({
  existing = new Set(),
  searchRows = [],
  similarRows = [],
  failCreate = false,
  features = { noEmbed: true, similarFilters: false },
} = {}) {
  const calls = { get: [], create: [], statements: [], similar: [] }
  const stub = {
    calls,
    async features() {
      return features
    },
    async knowledgeGet(name) {
      calls.get.push(name)
      return existing.has(name)
        ? { found: true, name, content: {} }
        : { found: false }
    },
    async knowledgeCreate(name, entry) {
      calls.create.push({ name, entry })
      if (failCreate) throw new Error('create failed')
      existing.add(name)
    },
    async statementCreate(head, relation, tail, entry) {
      calls.statements.push({ head, relation, tail, entry })
    },
    async search() {
      return searchRows
    },
    async similar(query, options) {
      calls.similar.push({ query, options })
      return similarRows
    },
  }
  return stub
}

/** A work unit with the fields `writeWorkUnit` requires. */
function unitFixture(overrides = {}) {
  return {
    title: 'Use Arc<Mutex<T>> for shared state',
    content: '## Context\nshared counter\n## Solution\nArc<Mutex<T>>',
    tags: ['rust'],
    project: 'demo',
    date: '2025-09-09',
    ...overrides,
  }
}

function makeStatus() {
  const counts = new Map()
  return { count: (n, by = 1) => counts.set(n, (counts.get(n) ?? 0) + by), warn: () => {}, counts }
}

test('writeMessage creates missing entries', async () => {
  const stub = makeStub()
  const status = makeStatus()
  const writer = createWriter(stub, { status })
  const result = await writer.writeMessage({
    sessionId: 's1', index: 7, markdown: '## Role\nuser', project: 'demo',
  })
  assert.equal(result.written, true)
  assert.equal(stub.calls.create.length, 1)
  assert.deepEqual(stub.calls.create[0].entry.tags, ['message'])
  assert.deepEqual(stub.calls.create[0].entry.scopes, ['demo'])
  // The log layer is not on the retrieval hot path, and embedded it outranks
  // the knowledge distilled from it. Stored and full-text indexed; no vector.
  assert.equal(stub.calls.create[0].entry.embed, false)
})

test('writeMessage skips existing entries (idempotent replay)', async () => {
  const stub = makeStub({ existing: new Set(['msg-s1-7']) })
  const status = makeStatus()
  const writer = createWriter(stub, { status })
  const result = await writer.writeMessage({
    sessionId: 's1', index: 7, markdown: 'x', project: 'demo',
  })
  assert.equal(result.written, false)
  assert.equal(stub.calls.create.length, 0)
  assert.equal(status.counts.get('duplicate'), 1)
})

test('writeSummary links the entries it is given, without probing the seq space', async () => {
  const stub = makeStub()
  const status = makeStatus()
  const writer = createWriter(stub, { status })
  const result = await writer.writeSummary({
    sessionId: 's1', fromSeq: 5, toSeq: 9, markdown: 'summary text', project: 'demo',
    items: ['msg-s1-5', 'msg-s1-7'],
  })
  assert.equal(result.written, true)
  assert.equal(result.links, 2)
  assert.deepEqual(
    stub.calls.statements.map((s) => [s.head, s.relation, s.tail]),
    [['sum-s1-5-9', 'summary', 'msg-s1-5'], ['sum-s1-5-9', 'summary', 'msg-s1-7']],
  )
  // The span is [5, 9) but only the two named entries are touched: DSH gives
  // every streamed token its own seq, so walking the range would mean thousands
  // of CLI spawns looking up keys that cannot exist.
  assert.equal(stub.calls.get.filter((n) => n.startsWith('msg-')).length, 0)
  // The level tag is what `$not-summaried` cascades on. A space inside a tag is
  // safe: tags travel as one argv element that hypatia splits on commas, with no
  // shell in between (asserted end-to-end in test/integration).
  assert.deepEqual(stub.calls.create[0].entry.tags, ['summary', 'summary 1'])
  // The summary is distilled knowledge and IS embedded; its edges are for the
  // traversal and `$not-summaried`, and a shelf's `skip_tags` cannot reach a
  // statement, so they say so themselves.
  assert.notEqual(stub.calls.create[0].entry.embed, false)
  assert.deepEqual(stub.calls.statements.map((s) => s.entry.embed), [false, false])
})

test('writeSummary replay re-asserts edges a crash left unwritten', async () => {
  // The entry and its edges are separate CLI calls. Returning early on `found`
  // made a crash between them permanent: the summary existed with no links, and
  // `$not-summaried` would keep handing the same messages back forever.
  const stub = makeStub({ existing: new Set(['sum-s1-5-9']) })
  const status = makeStatus()
  const writer = createWriter(stub, { status })
  const replay = await writer.writeSummary({
    sessionId: 's1', fromSeq: 5, toSeq: 9, markdown: 'summary text', project: 'demo',
    items: ['msg-s1-5', 'msg-s1-7'],
  })
  assert.equal(replay.written, false, 'entry not re-created')
  assert.equal(stub.calls.create.length, 0)
  assert.equal(stub.calls.statements.length, 2, 'edges asserted anyway')
})

test('writeWorkUnit stores with is_a/derivedFrom and no relationship when nothing is near', async () => {
  const stub = makeStub()
  const writer = createWriter(stub, { status: makeStatus() })
  const result = await writer.writeWorkUnit(unitFixture({ derivedFrom: 'sum-s1-5-9' }))

  assert.equal(result.written, true)
  assert.equal(result.verdict, 'unrelated')
  const relations = stub.calls.statements.map((s) => s.relation)
  assert.deepEqual(relations, ['is_a', 'derivedFrom'])
})

test('writeWorkUnit names entries by content, not by date', async () => {
  // `wu-<date>-<slug>` failed both ways: same-day slug collisions silently
  // dropped the second unit, and the same lesson re-extracted on a later day
  // produced a duplicate. A content digest fixes both.
  const stub = makeStub()
  const writer = createWriter(stub, { status: makeStatus() })
  const monday = await writer.writeWorkUnit(unitFixture({ date: '2025-09-08' }))
  const tuesday = await writer.writeWorkUnit(unitFixture({ date: '2025-09-09' }))
  assert.equal(monday.name, tuesday.name, 'same content, same name on any day')
  assert.match(monday.name, /^wu-use-arc-mutex-t-for-shared-state-[0-9a-f]{8}$/)

  const other = await writer.writeWorkUnit(unitFixture({ content: 'completely different lesson' }))
  assert.notEqual(other.name, monday.name, 'different content, different name')
})

test('writeWorkUnit ignores operational rows when looking for relatives', async () => {
  // `msg-*` entries outnumber knowledge by orders of magnitude, so an unfiltered
  // nearest-neighbour lookup almost always returned a raw chat log.
  const stub = makeStub({
    similarRows: [
      { name: 'msg-s1-42', content: { tags: ['message'] }, distance: 0.01 },
      { name: 'sum-s1-0-9', content: { tags: ['summary', 'summary 1'] }, distance: 0.02 },
      { name: 'session-s1', content: { tags: ['session'] }, distance: 0.03 },
      { name: 'hypatia-dream-run-20250101', content: { tags: ['system', 'hypatia-dream-run'] }, distance: 0.04 },
      { name: 'wu-real-memory-aabbccdd', content: { tags: ['memory', 'work-unit'] }, distance: 0.2 },
    ],
  })
  const seen = []
  const writer = createWriter(stub, {
    status: makeStatus(),
    adjudicate: async (_unit, candidates) => {
      seen.push(candidates.map((row) => row.name))
      return { verdict: 'extends', target: 'wu-real-memory-aabbccdd' }
    },
  })
  const result = await writer.writeWorkUnit(unitFixture())

  assert.deepEqual(seen, [['wu-real-memory-aabbccdd']])
  assert.equal(result.verdict, 'extends')
  assert.deepEqual(
    stub.calls.statements.map((s) => [s.relation, s.tail]),
    [['is_a', 'work-unit'], ['extends', 'wu-real-memory-aabbccdd']],
  )
})

test('the candidate fetch excludes the operational layer in the query where the binary can', async () => {
  // hypatia #35 gave `similar` `--exclude-tags`: the layer is left out BEFORE
  // ranking, so the rows asked for are the rows wanted and nothing is fetched
  // to be thrown away. The name-prefix filter stays for an entry that lost its
  // tags.
  const stub = makeStub({
    features: { noEmbed: true, similarFilters: true },
    similarRows: [
      { name: 'sum-untagged-0-9', content: { tags: [] }, distance: 0.01 },
      { name: 'wu-real-memory-aabbccdd', content: { tags: ['memory', 'work-unit'] }, distance: 0.2 },
    ],
  })
  const seen = []
  const writer = createWriter(stub, {
    status: makeStatus(),
    adjudicate: async (_unit, candidates) => {
      seen.push(candidates.map((row) => row.name))
      return { verdict: 'extends', target: 'wu-real-memory-aabbccdd' }
    },
  })
  await writer.writeWorkUnit(unitFixture())

  assert.equal(stub.calls.similar[0].options.limit, 5, 'five wanted, five fetched')
  assert.deepEqual(
    [...stub.calls.similar[0].options.excludeTags].sort(),
    ['hypatia-dream-run', 'message', 'session', 'summary'],
  )
  assert.deepEqual(seen, [['wu-real-memory-aabbccdd']])
})

test('the candidate fetch oversamples on a binary whose similar cannot exclude tags', async () => {
  // Before hypatia #35, `hypatia similar` took only target/limit/shelf — no tag
  // or scope filter — and the operational layer both outnumbers knowledge and
  // scores NEARER: a raw `msg-*` holds the very words the unit was extracted
  // from. Measured on a live shelf: 7 of the nearest 10 rows were operational.
  // Asking for exactly the number wanted therefore left one candidate, often
  // none, and every write silently degraded to "no relationship".
  const operational = Array.from({ length: 7 }, (_, index) => ({
    name: `msg-s1-${index}`,
    content: { tags: ['message'] },
    distance: 0.01 * (index + 1),
  }))
  const stub = makeStub({
    similarRows: [...operational, { name: 'wu-real-memory-aabbccdd', content: { tags: ['memory', 'work-unit'] }, distance: 0.2 }],
  })
  const seen = []
  const writer = createWriter(stub, {
    status: makeStatus(),
    adjudicate: async (_unit, candidates) => {
      seen.push(candidates.map((row) => row.name))
      return { verdict: 'extends', target: 'wu-real-memory-aabbccdd' }
    },
  })
  await writer.writeWorkUnit(unitFixture())

  assert.equal(stub.calls.similar[0].options.limit, 20, 'five wanted, twenty fetched')
  assert.deepEqual(seen, [['wu-real-memory-aabbccdd']], 'the real relative survived seven nearer log rows')
})

test('the oversampled fetch has a ceiling', async () => {
  // Rows travel back through the CLI in full, so the multiplier cannot run away.
  const stub = makeStub()
  const writer = createWriter(stub, { status: makeStatus(), adjudicate: async () => undefined })
  await writer.writeWorkUnit(unitFixture({ candidateLimit: 20 }))

  assert.equal(stub.calls.similar[0].options.limit, 40)
})

test('writeWorkUnit drops candidates beyond the distance floor', async () => {
  const stub = makeStub({
    similarRows: [{ name: 'wu-far-away-11223344', content: { tags: ['memory'] }, distance: 0.9 }],
  })
  let asked = false
  const writer = createWriter(stub, {
    status: makeStatus(),
    adjudicate: async () => { asked = true; return { verdict: 'extends' } },
  })
  const result = await writer.writeWorkUnit(unitFixture())
  assert.equal(asked, false, 'nothing near enough to be worth a model call')
  assert.equal(result.verdict, 'unrelated')
})

test('a contradiction keeps both entries and records supersedes', async () => {
  // docs/memory-nolinear.md: a correction must leave a trace rather than
  // quietly overwriting what the system used to believe.
  const stub = makeStub({
    similarRows: [{ name: 'wu-old-belief-deadbeef', content: { tags: ['memory'] }, distance: 0.1 }],
  })
  const writer = createWriter(stub, {
    status: makeStatus(),
    adjudicate: async () => ({ verdict: 'contradicts', target: 'wu-old-belief-deadbeef' }),
  })
  const result = await writer.writeWorkUnit(unitFixture())

  assert.equal(result.written, true, 'the new belief is stored')
  assert.equal(result.verdict, 'contradicts')
  assert.deepEqual(
    stub.calls.statements.map((s) => [s.relation, s.tail]),
    [['is_a', 'work-unit'], ['supersedes', 'wu-old-belief-deadbeef']],
  )
})

test('a duplicate verdict stores nothing at all', async () => {
  const stub = makeStub({
    similarRows: [{ name: 'wu-same-thing-cafebabe', content: { tags: ['memory'] }, distance: 0.02 }],
  })
  const writer = createWriter(stub, {
    status: makeStatus(),
    adjudicate: async () => ({ verdict: 'duplicate', target: 'wu-same-thing-cafebabe' }),
  })
  const result = await writer.writeWorkUnit(unitFixture())
  assert.equal(result.written, false)
  assert.equal(stub.calls.create.length, 0)
  assert.equal(stub.calls.statements.length, 0)
})

test('writeWorkUnit still stores when similarity search is unavailable', async () => {
  // A shelf with no embedding model fails every `similar` call. That must cost
  // the relationship edge, never the memory.
  const stub = makeStub()
  stub.similar = async () => { throw new Error('model unavailable: no embedding provider configured') }
  const writer = createWriter(stub, {
    status: makeStatus(),
    adjudicate: async () => ({ verdict: 'extends', target: 'x' }),
  })
  const result = await writer.writeWorkUnit(unitFixture())
  assert.equal(result.written, true)
  assert.equal(result.verdict, 'unrelated')
})

test('an adjudication failure degrades to storing without a relationship', async () => {
  const stub = makeStub({
    similarRows: [{ name: 'wu-nearby-0badf00d', content: { tags: ['memory'] }, distance: 0.1 }],
  })
  const writer = createWriter(stub, {
    status: makeStatus(),
    adjudicate: async () => { throw new Error('route down') },
  })
  const result = await writer.writeWorkUnit(unitFixture())
  assert.equal(result.written, true)
  assert.equal(result.verdict, 'unrelated')
  assert.deepEqual(stub.calls.statements.map((s) => s.relation), ['is_a'])
})

test('writeSessionNode creates the node and links the message range it is given', async () => {
  const stub = makeStub()
  const writer = createWriter(stub, { status: makeStatus() })
  const result = await writer.writeSessionNode({
    sessionId: 's1', markdown: 'Storage rewrite session', project: 'demo',
    linkFrom: 0, linkTo: 3,
  })

  assert.equal(result.written, true)
  assert.equal(result.links, 3)
  assert.deepEqual(stub.calls.create[0].entry.tags, ['session'])
  // Bookkeeping for the traversal, like the messages it groups: no vectors.
  assert.equal(stub.calls.create[0].entry.embed, false)
  assert.deepEqual(stub.calls.statements.map((s) => s.entry.embed), [false, false, false])
  // Direction is message -> session, the protocol's `belongTo` orientation.
  assert.deepEqual(
    stub.calls.statements.map((s) => [s.head, s.relation, s.tail]),
    [
      ['msg-s1-0', 'belongTo', 'session-s1'],
      ['msg-s1-1', 'belongTo', 'session-s1'],
      ['msg-s1-2', 'belongTo', 'session-s1'],
    ],
  )
})

test('writeSessionNode links only the range still owed, never re-linking', async () => {
  const stub = makeStub({ existing: new Set(['session-s1']) })
  const writer = createWriter(stub, { status: makeStatus() })
  const result = await writer.writeSessionNode({
    sessionId: 's1', markdown: 'ignored, the entry already exists', project: 'demo',
    linkFrom: 3, linkTo: 5,
  })

  // hypatia has no `knowledge-update`, so a later title cannot replace the
  // first — the original stands and only the owed edges are added.
  assert.equal(result.written, false)
  assert.equal(stub.calls.create.length, 0)
  assert.deepEqual(stub.calls.statements.map((s) => s.head), ['msg-s1-3', 'msg-s1-4'])
})

test('writeSessionNode refuses to fabricate a node from empty text', async () => {
  // The log path calls in with no text, purely to settle owed `belongTo` edges.
  // If the node has been deleted since, recreating it empty would invent the
  // session summary the protocol says never to invent.
  const stub = makeStub()
  const writer = createWriter(stub, { status: makeStatus() })
  const result = await writer.writeSessionNode({
    sessionId: 's1', markdown: '   ', project: 'demo', linkFrom: 0, linkTo: 3,
  })
  assert.equal(result.written, false)
  assert.equal(result.links, 0)
  assert.equal(stub.calls.create.length, 0)
  assert.equal(stub.calls.statements.length, 0, 'no edges to an absent node')
})
