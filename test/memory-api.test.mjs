/**
 * The Memory tab's route family: the JSE it builds, how it reads hypatia's
 * answer shapes, and the request boundary it enforces before reaching the CLI.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BODY_MAX_CHARS,
  CONTENT_BUDGET_CHARS,
  MAX_SUMMARIES,
  MEMORY_API_PREFIX,
  createMemoryApi,
  derivedFromQuery,
  fitBudget,
  isLoopbackAddress,
  isLoopbackHost,
  isSameOriginRequest,
  isTrustedRequest,
  knowledgeByNamesQuery,
  normalizeKnowledgeRows,
  normalizeStatementRows,
  summariesQuery,
  SCAN_LIMIT,
  summaryLevel,
  summaryMatcher,
  summaryPrefix,
  unitNamesNewestFirst,
} from '../src/memory-api.js'
import { buildStatus } from '../src/memory-status.js'

const SESSION = '57ffd99e-6cbe-4798-a28d-fe90c274580d'

function makeStatus() {
  const lines = []
  return {
    lines,
    info: (m) => lines.push(['info', m]),
    warn: (m) => lines.push(['warn', m]),
    error: (m) => lines.push(['error', m]),
    count: () => {},
  }
}

/** A `hypatia query` double: answers per JSE top-level operator, in call order. */
function makeCli(answers) {
  const queries = []
  return {
    queries,
    async query(jse) {
      queries.push(JSON.parse(jse))
      const doc = JSON.parse(jse)
      const key = doc.$knowledge === undefined ? 'statement' : 'knowledge'
      const queue = answers[key]
      return queue === undefined || queue.length === 0 ? [] : queue.shift()
    },
  }
}

/** A state-table double in the shape `buildStatus` reads. */
function makeRead(progress = {}, tasks = {}) {
  return (sessionId) => buildStatus({
    progressEntries: Object.entries(progress),
    taskEntries: Object.entries(tasks),
    sessionId,
  })
}

function makeReq({ url, method = 'GET', origin, site = 'same-origin', address = '127.0.0.1', host = '127.0.0.1:3080' } = {}) {
  return {
    url,
    method,
    headers: {
      host,
      ...origin === undefined ? {} : { origin },
      ...site === null ? {} : { 'sec-fetch-site': site },
    },
    socket: { remoteAddress: address },
  }
}

function makeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { res.status = status; res.headers = headers },
    end(payload) { res.body = payload ?? '' },
  }
  return res
}

async function call(api, options) {
  const res = makeRes()
  await api.route.handler(makeReq(options), res)
  return { status: res.status, body: res.body === '' ? undefined : JSON.parse(res.body) }
}

/* ---------------------------------------------------------------- queries -- */

test('summaries are selected by the session embedded in their name', () => {
  assert.equal(summaryPrefix(SESSION), `sum-${SESSION}-`)
  const doc = summariesQuery(SESSION, 7)
  assert.deepEqual(doc, {
    $knowledge: [['$like', 'name', `sum-${SESSION}-%`]],
    limit: 7,
    offset: 0,
  })
})

test('work units are reached through the derivedFrom edge, not their own names', () => {
  // Unit names are content-addressed (`wu-<slug>-<hash>`), so the name carries no
  // session; the link is the only way to find this session's units.
  assert.deepEqual(derivedFromQuery(SESSION, 5), {
    $statement: [['$and', ['$eq', 'relation', 'derivedFrom'], ['$like', 'tail', `sum-${SESSION}-%`]]],
    limit: 5,
    offset: 0,
  })
})

test('a name lookup collapses to a plain $eq and deduplicates', () => {
  assert.deepEqual(knowledgeByNamesQuery(['wu-a']).$knowledge, [['$eq', 'name', 'wu-a']])
  const many = knowledgeByNamesQuery(['wu-a', 'wu-a', '', 'wu-b'])
  assert.equal(many.limit, 2, 'duplicates and blanks are dropped before the limit')
  assert.deepEqual(many.$knowledge, [['$or', ['$eq', 'name', 'wu-a'], ['$eq', 'name', 'wu-b']]])
})

/* ----------------------------------------------------------- normalization -- */

test('knowledge rows are read across the shape hypatia answers with', () => {
  const rows = normalizeKnowledgeRows([
    { name: 'sum-s-1-2', content: { data: '# Hi', format: 'markdown', tags: ['summary', 'summary 2'] }, created_at: '2026-09-24T00:00:00Z' },
    { name: 'no-content' },
    { content: { data: 'x' } },
    null,
    'nope',
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].markdown, '# Hi')
  assert.deepEqual(rows[0].tags, ['summary', 'summary 2'])
  assert.equal(rows[0].createdAt, '2026-09-24T00:00:00Z')
  assert.deepEqual({ name: rows[1].name, markdown: rows[1].markdown, format: rows[1].format }, { name: 'no-content', markdown: '', format: '' })
})

test('a non-array answer is empty rather than a crash', () => {
  assert.deepEqual(normalizeKnowledgeRows(undefined), [])
  assert.deepEqual(normalizeKnowledgeRows({ rows: [] }), [])
  assert.deepEqual(normalizeStatementRows('nope'), [])
})

test('statement rows yield the head that names the derived entry', () => {
  assert.deepEqual(normalizeStatementRows([
    { head: 'wu-a', relation: 'derivedFrom', tail: `sum-${SESSION}-1-2` },
    { tail: `sum-${SESSION}-1-2` },
    null,
  ]), [{ head: 'wu-a', tail: `sum-${SESSION}-1-2`, createdAt: '' }])
})

test('the name pattern is only a pre-filter; the exact shape decides', () => {
  const isSummary = summaryMatcher('abc')
  assert.equal(isSummary('sum-abc-0-5'), true)
  assert.equal(isSummary('sum-abc-def-0-5'), false, 'a session whose id merely starts with abc-')
  assert.equal(isSummary('sum-aXc-0-5'), false)
  assert.equal(summaryMatcher('a_c')('sum-abc-0-5'), false, '_ is a LIKE wildcard, not a regex one')
  assert.equal(summaryMatcher('a.c')('sum-abc-0-5'), false, 'regex metacharacters are escaped')
})

test('unit names are ordered by their newest edge, and deduplicated', () => {
  assert.deepEqual(unitNamesNewestFirst([
    { head: 'wu-old', tail: 't', createdAt: '2026-09-01' },
    { head: 'wu-new', tail: 't', createdAt: '2026-09-03' },
    { head: 'wu-old', tail: 't2', createdAt: '2026-09-02' },
    { head: 'msg-x', tail: 't', createdAt: '2026-09-09' },
  ]), ['wu-new', 'wu-old'])
})

test('the archive tier comes from the tag, defaulting to the message tier', () => {
  assert.equal(summaryLevel(['summary', 'summary 3']), 3)
  assert.equal(summaryLevel(['summary']), 1)
  assert.equal(summaryLevel(['summary two']), 1)
  assert.equal(summaryLevel([]), 1)
})

test('a body is capped so one long summary cannot dominate the response', () => {
  const long = 'x'.repeat(BODY_MAX_CHARS + 10)
  const rows = normalizeKnowledgeRows([{ name: 'sum-s-1-2', content: { data: long } }])
  assert.equal(rows[0].markdown.length, BODY_MAX_CHARS + 1)
})

test('the response budget drops the oldest entries once it is spent', () => {
  const half = 'x'.repeat(CONTENT_BUDGET_CHARS / 2)
  const entries = [
    { name: 'newest', markdown: half },
    { name: 'middle', markdown: half },
    { name: 'oldest', markdown: half },
  ]
  const fit = fitBudget(entries)
  assert.deepEqual(fit.kept.map((entry) => entry.name), ['newest', 'middle'])
  assert.equal(fit.truncated, true)
  assert.equal(fit.spent, CONTENT_BUDGET_CHARS, 'the kept bodies account for the budget')
  assert.deepEqual(
    fitBudget([{ name: 'a', markdown: 'x' }]),
    { kept: [{ name: 'a', markdown: 'x' }], truncated: false, spent: 1 },
  )
})

test('one budget covers the whole response, not each section', () => {
  const fit = fitBudget([{ name: 'unit', markdown: 'xx' }], CONTENT_BUDGET_CHARS - 1)
  assert.deepEqual(fit.kept, [], 'the summaries already spent the budget')
  assert.equal(fit.truncated, true)
  assert.equal(fit.spent, CONTENT_BUDGET_CHARS - 1, 'a dropped entry does not spend anything')
})

/* ------------------------------------------------------------------ trust -- */

test('only loopback literals pass the socket check', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.5.5.5'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('10.0.0.5'), false)
  assert.equal(isLoopbackAddress('::ffff:10.0.0.5'), false)
  assert.equal(isLoopbackAddress(undefined), false)
})

test('a cross-site or markerless request is refused', () => {
  assert.equal(isSameOriginRequest(makeReq({ origin: 'http://127.0.0.1:3080' })), true)
  assert.equal(isSameOriginRequest(makeReq({ origin: 'http://evil.test' })), false)
  assert.equal(isSameOriginRequest(makeReq({ site: 'cross-site' })), false)
  assert.equal(isSameOriginRequest(makeReq({ site: null })), false, 'a bare curl carries no marker')
  assert.equal(isSameOriginRequest({ headers: {} }), false, 'no Host authority to compare against')
})

test('only a loopback name passes the Host check', () => {
  assert.equal(isLoopbackHost('127.0.0.1:3080'), true)
  assert.equal(isLoopbackHost('localhost:3080'), true)
  assert.equal(isLoopbackHost('dsh.localhost'), true)
  assert.equal(isLoopbackHost('[::1]:3080'), true)
  assert.equal(isLoopbackHost('rebind.evil.test:3080'), false)
  assert.equal(isLoopbackHost('[::2]:3080'), false)
  assert.equal(isLoopbackHost('10.0.0.5'), false)
  assert.equal(isLoopbackHost(undefined), false)
})

test('a DNS-rebound page is refused though its Origin matches its Host', () => {
  // Rebound to 127.0.0.1: loopback socket, and same-origin with its own name.
  const req = makeReq({ host: 'rebind.evil.test:3080', origin: 'http://rebind.evil.test:3080' })
  assert.equal(isSameOriginRequest(req), true)
  assert.equal(isTrustedRequest(req), false)
})

test('the gate needs both the socket and the origin', () => {
  assert.equal(isTrustedRequest(makeReq({ origin: 'http://127.0.0.1:3080' })), true)
  assert.equal(isTrustedRequest(makeReq({ origin: 'http://127.0.0.1:3080', address: '10.0.0.5' })), false)
  assert.equal(isTrustedRequest(makeReq({ origin: 'http://evil.test' })), false)
})

/* --------------------------------------------------------------- requests -- */

test('the claimed route is one prefix, so a sibling cannot collide over paths', () => {
  const api = createMemoryApi({ cli: makeCli({}), read: makeRead(), status: makeStatus() })
  assert.equal(api.route.kind, 'prefix')
  assert.equal(api.route.path, MEMORY_API_PREFIX)
  assert.ok(api.route.path.startsWith('/api/'))
})

test('an untrusted request never reaches the CLI', async () => {
  const cli = makeCli({})
  const api = createMemoryApi({ cli, read: makeRead(), status: makeStatus() })
  const answer = await call(api, { url: `${MEMORY_API_PREFIX}/session?session=x`, origin: 'http://evil.test' })
  assert.equal(answer.status, 403)
  assert.equal(cli.queries.length, 0)
})

test('a missing session, a wrong method and an unknown path are each refused', async () => {
  const cli = makeCli({})
  const api = createMemoryApi({ cli, read: makeRead(), status: makeStatus() })
  const trusted = { origin: 'http://127.0.0.1:3080' }

  assert.equal((await call(api, { url: `${MEMORY_API_PREFIX}/session`, ...trusted })).status, 400)
  assert.equal((await call(api, { url: `${MEMORY_API_PREFIX}/session?session=`, ...trusted })).status, 400)
  assert.equal((await call(api, { url: `${MEMORY_API_PREFIX}/session?session=x`, method: 'POST', ...trusted })).status, 405)
  assert.equal((await call(api, { url: `${MEMORY_API_PREFIX}/other?session=x`, ...trusted })).status, 404)
  assert.equal((await call(api, { url: `${MEMORY_API_PREFIX}/session?session=%25&content=1`, ...trusted })).status, 400, 'a LIKE wildcard is not a session id')
  assert.equal(cli.queries.length, 0, 'none of these needed the shelf')
})

test('a status-only read answers from memory and asks the shelf nothing', async () => {
  const cli = makeCli({})
  const api = createMemoryApi({
    cli,
    read: makeRead({ [SESSION]: { lastLoggedSeq: 481, lastConsolidatedSeq: 463, pendingTokens: 5, hasSessionNode: 1 } }),
    status: makeStatus(),
    now: () => 42,
  })
  const answer = await call(api, { url: `${MEMORY_API_PREFIX}/session?session=${SESSION}`, origin: 'http://127.0.0.1:3080' })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.updatedAt, 42)
  assert.equal(answer.body.session.known, true)
  assert.equal(answer.body.session.loggedSeq, 481)
  assert.equal(answer.body.session.caughtUp, false)
  assert.equal(answer.body.content, false, 'the answer says which half it carries')
  assert.equal(answer.body.summaries, undefined, 'and carries no content keys at all')
  assert.equal(cli.queries.length, 0, 'content was not asked for')
})

test('a content read returns summaries and their derived work units, newest first', async () => {
  const cli = makeCli({
    knowledge: [
      [
        { name: `sum-${SESSION}-0-5`, content: { data: 'older', tags: ['summary'] }, created_at: '2026-09-23T00:00:00Z' },
        { name: `sum-${SESSION}-6-9`, content: { data: 'newer', tags: ['summary', 'summary 2'] }, created_at: '2026-09-24T00:00:00Z' },
      ],
      [
        { name: 'wu-b-2', content: { data: 'unit body' }, created_at: '2026-09-24T01:00:00Z' },
      ],
    ],
    statement: [
      [{ head: 'wu-b-2', tail: `sum-${SESSION}-6-9` }, { head: 'msg-ignored', tail: `sum-${SESSION}-6-9` }],
    ],
  })
  const api = createMemoryApi({ cli, read: makeRead({ [SESSION]: {} }), status: makeStatus(), now: () => 7 })
  const answer = await call(api, { url: `${MEMORY_API_PREFIX}/session?session=${SESSION}&content=1`, origin: 'http://127.0.0.1:3080' })

  assert.equal(answer.status, 200)
  assert.equal(answer.body.content, true)
  assert.equal(answer.body.contentError, '')
  assert.deepEqual(answer.body.summaries.map((entry) => entry.name), [`sum-${SESSION}-6-9`, `sum-${SESSION}-0-5`])
  assert.equal(answer.body.summaries[0].level, 2, 'the tier comes from the tag')
  assert.equal(answer.body.summaryCount, 2)
  assert.deepEqual(answer.body.workUnits.map((entry) => entry.name), ['wu-b-2'])
  assert.equal(answer.body.workUnitCount, 1, 'only wu-* heads count as units')
  assert.equal(cli.queries.length, 3)
  assert.deepEqual(cli.queries[2].$knowledge, [['$eq', 'name', 'wu-b-2']], 'the unit bodies are read by name, from the derivedFrom heads')
})

test('content is asked for once, then served from cache until it is invalidated', async () => {
  let clock = 1000
  const cli = makeCli({
    knowledge: [[], [], []],
    statement: [[], [], []],
  })
  const api = createMemoryApi({
    cli, read: makeRead({ [SESSION]: {} }), status: makeStatus(), ttlMs: 100, now: () => clock,
  })
  const url = `${MEMORY_API_PREFIX}/session?session=${SESSION}&content=1`
  const trusted = { origin: 'http://127.0.0.1:3080' }

  await call(api, { url, ...trusted })
  assert.equal(cli.queries.length, 2, 'two queries: summaries, then the derivedFrom edges')

  clock += 50
  await call(api, { url, ...trusted })
  assert.equal(cli.queries.length, 2, 'inside the TTL the shelf is not asked again')

  api.invalidate(SESSION)
  await call(api, { url, ...trusted })
  assert.equal(cli.queries.length, 4, 'a settled consolidation drops that session immediately')

  clock += 1000
  await call(api, { url, ...trusted })
  assert.equal(cli.queries.length, 6, 'and the TTL expires content the Host cannot see change')
})

test('invalidate() without a session empties everything', async () => {
  const cli = makeCli({ knowledge: [[], [], []], statement: [[], [], []] })
  const api = createMemoryApi({ cli, read: makeRead({ a: {}, b: {} }), status: makeStatus() })
  const trusted = { origin: 'http://127.0.0.1:3080' }
  await call(api, { url: `${MEMORY_API_PREFIX}/session?session=a&content=1`, ...trusted })
  await call(api, { url: `${MEMORY_API_PREFIX}/session?session=b&content=1`, ...trusted })
  assert.equal(cli.queries.length, 4)
  api.invalidate()
  await call(api, { url: `${MEMORY_API_PREFIX}/session?session=a&content=1`, ...trusted })
  assert.equal(cli.queries.length, 6)
})

test('a broken shelf costs the content, never the status', async () => {
  const status = makeStatus()
  const api = createMemoryApi({
    cli: { query: async () => { throw new Error('hypatia mcp timed out') } },
    read: makeRead({ [SESSION]: { lastLoggedSeq: 12 } }),
    status,
    now: () => 3,
  })
  const answer = await call(api, { url: `${MEMORY_API_PREFIX}/session?session=${SESSION}&content=1`, origin: 'http://127.0.0.1:3080' })

  assert.equal(answer.status, 200, 'the tab has to be able to say what is wrong')
  assert.equal(answer.body.session.loggedSeq, 12)
  assert.equal(answer.body.content, true, 'the shelf was asked for, even though reading it failed')
  assert.deepEqual(answer.body.summaries, [])
  assert.match(answer.body.contentError, /timed out/)
  assert.equal(status.lines.filter(([level]) => level === 'warn').length, 1)
})

test('the newest summaries are chosen from every candidate, and counted in full', async () => {
  const rows = []
  for (let index = 0; index < MAX_SUMMARIES + 10; index += 1) {
    rows.push({ name: `sum-${SESSION}-${String(index)}-${String(index)}`, content: { data: 'b' }, created_at: `2026-09-24 00:00:${String(index).padStart(2, '0')}` })
  }
  // An over-match of the LIKE pattern: another session whose id extends this one.
  rows.push({ name: `sum-${SESSION}-other-1-2`, content: { data: 'x' }, created_at: '2026-09-25' })
  const cli = makeCli({ knowledge: [rows], statement: [[]] })
  const api = createMemoryApi({ cli, read: makeRead({ [SESSION]: {} }), status: makeStatus() })
  const answer = await call(api, { url: `${MEMORY_API_PREFIX}/session?session=${SESSION}&content=1`, origin: 'http://127.0.0.1:3080' })

  assert.equal(cli.queries[0].limit, SCAN_LIMIT, 'the scan reads every candidate, not the first page')
  assert.equal(answer.body.summaries.length, MAX_SUMMARIES)
  assert.equal(answer.body.summaries[0].name, `sum-${SESSION}-${String(MAX_SUMMARIES + 9)}-${String(MAX_SUMMARIES + 9)}`)
  assert.equal(answer.body.summaryCount, MAX_SUMMARIES + 10)
  assert.equal(answer.body.truncated, true, 'entries were left out')
})

test('a read in flight when invalidate() runs is not cached', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const cli = {
    async query() {
      calls += 1
      if (calls === 1) await gate
      return []
    },
  }
  const api = createMemoryApi({ cli, read: makeRead({ [SESSION]: {} }), status: makeStatus() })
  const url = `${MEMORY_API_PREFIX}/session?session=${SESSION}&content=1`
  const trusted = { origin: 'http://127.0.0.1:3080' }

  const pending = call(api, { url, ...trusted })
  api.invalidate(SESSION)
  release()
  await pending
  const before = calls
  await call(api, { url, ...trusted })
  assert.equal(calls, before + 2, 'the stale read was not cached, so the shelf is asked again')
})

test('cached content is not served across a consolidation watermark', async () => {
  const progress = { [SESSION]: { lastConsolidatedSeq: 5 } }
  const cli = makeCli({})
  const api = createMemoryApi({ cli, read: makeRead(progress), status: makeStatus() })
  const url = `${MEMORY_API_PREFIX}/session?session=${SESSION}&content=1`
  const trusted = { origin: 'http://127.0.0.1:3080' }

  await call(api, { url, ...trusted })
  assert.equal(cli.queries.length, 2)
  progress[SESSION].lastConsolidatedSeq = 9
  await call(api, { url, ...trusted })
  assert.equal(cli.queries.length, 4, 'the watermark moved before invalidate() ran')
})

test('updatedAt stands still while the status does not change', async () => {
  let clock = 10
  const progress = { [SESSION]: { lastLoggedSeq: 1 } }
  const api = createMemoryApi({ cli: makeCli({}), read: makeRead(progress), status: makeStatus(), now: () => clock })
  const url = `${MEMORY_API_PREFIX}/session?session=${SESSION}`
  const trusted = { origin: 'http://127.0.0.1:3080' }

  assert.equal((await call(api, { url, ...trusted })).body.updatedAt, 10)
  clock = 20
  assert.equal((await call(api, { url, ...trusted })).body.updatedAt, 10, 'nothing changed')
  progress[SESSION].lastLoggedSeq = 2
  clock = 30
  assert.equal((await call(api, { url, ...trusted })).body.updatedAt, 30)
})

test('the caps are the ones the route documents', async () => {
  // Guard against a silent change to a bound the browser relies on.
  assert.equal(MAX_SUMMARIES, 40)
  assert.ok(CONTENT_BUDGET_CHARS > BODY_MAX_CHARS)
})

/* ---------------------------------------------------------------- shelves -- */

test('the shelves route serves the listing and caches it for the TTL', async () => {
  let calls = 0
  let clock = 1000
  const cli = {
    query: async () => [],
    listShelves: async () => {
      calls += 1
      return [{ name: 'default', path: '/a', connected: true }]
    },
  }
  const api = createMemoryApi({ cli, read: makeRead(), status: makeStatus(), now: () => clock })
  const url = `${MEMORY_API_PREFIX}/shelves`
  const trusted = { origin: 'http://127.0.0.1:3080' }

  const first = await call(api, { url, ...trusted })
  assert.equal(first.status, 200)
  assert.deepEqual(first.body.shelves, [{ name: 'default', path: '/a', connected: true }])
  assert.equal(first.body.error, '')
  assert.equal(first.body.listedAt, 1000)

  clock += 1000
  await call(api, { url, ...trusted })
  assert.equal(calls, 1, 'within the TTL the CLI is not asked again')
  clock += 61_000
  await call(api, { url, ...trusted })
  assert.equal(calls, 2)
})

test('a failed listing keeps the last good shelves and says why', async () => {
  let fail = false
  const status = makeStatus()
  const cli = {
    query: async () => [],
    listShelves: async () => {
      if (fail) throw new Error('hypatia exited 1')
      return [{ name: 'default', path: '/a', connected: true }]
    },
  }
  const api = createMemoryApi({ cli, read: makeRead(), status, shelvesTtlMs: 0 })
  const url = `${MEMORY_API_PREFIX}/shelves`
  const trusted = { origin: 'http://127.0.0.1:3080' }

  await call(api, { url, ...trusted })
  fail = true
  const second = await call(api, { url, ...trusted })
  assert.equal(second.status, 200, 'a listing failure is data, not an HTTP error')
  assert.deepEqual(second.body.shelves.map((s) => s.name), ['default'])
  assert.equal(second.body.error, 'hypatia exited 1')
  assert.equal(status.lines.filter(([level]) => level === 'warn').length, 1)
})

test('a failed listing is not cached, and concurrent requests share one run', async () => {
  let calls = 0
  let fail = true
  let release
  const cli = {
    query: async () => [],
    listShelves: async () => {
      calls += 1
      await new Promise((resolve) => { release = resolve })
      if (fail) throw new Error('hypatia exited 1')
      return [{ name: 'default', path: '/a', connected: true }]
    },
  }
  const api = createMemoryApi({ cli, read: makeRead(), status: makeStatus() })
  const both = Promise.all([api.fetchShelves(), api.fetchShelves()])
  await new Promise((resolve) => setImmediate(resolve))
  release()
  const [a, b] = await both
  assert.equal(calls, 1, 'one hypatia list for two concurrent opens')
  assert.equal(a, b)
  assert.equal(a.error, 'hypatia exited 1')

  fail = false
  const retry = api.fetchShelves()
  await new Promise((resolve) => setImmediate(resolve))
  release()
  assert.deepEqual((await retry).shelves.map((s) => s.name), ['default'])
  assert.equal(calls, 2, 'the failure was not served from cache')
})

test('the shelves route never serves a cross-site request', async () => {
  let calls = 0
  const cli = {
    query: async () => [],
    listShelves: async () => { calls += 1; return [] },
  }
  const api = createMemoryApi({ cli, read: makeRead(), status: makeStatus() })
  const res = await call(api, { url: `${MEMORY_API_PREFIX}/shelves`, origin: 'https://evil.example', site: 'cross-site' })
  assert.equal(res.status, 403)
  assert.equal(calls, 0)
})
