/**
 * The Memory tab's read side: the URL one refresh reads, how the Host's answer
 * is read into the tab's shape, and how a new answer folds onto the one on
 * screen.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MEMORY_API_PREFIX,
  consolidationGap,
  memoryUrl,
  mergeMemory,
  parseMemoryPayload,
} from '../src/client/memory-client.ts'

const SESSION = 'session-83f81e10-4e4b-4eaa-8ff1-9af30e5e1caa'

const SESSION_VIEW = {
  sessionId: SESSION,
  known: true,
  loggedSeq: 481,
  consolidatedSeq: 463,
  caughtUp: false,
  pendingTokens: 5,
  sessionNode: true,
  belongTo: 38,
  deferred: 1,
  failed: 1,
  failedTasks: [{ kind: 'consolidate', sessionId: SESSION, attempts: 3, error: 'hypatia mcp timed out' }],
  error: 'hypatia mcp timed out',
}

const CONTENT = {
  summaries: [{ name: `sum-${SESSION}-0-5`, markdown: '# Hi', level: 2, createdAt: '2026-09-24 00:00:00.1' }],
  workUnits: [{ name: 'wu-a-1', markdown: 'lesson', level: 1, createdAt: '2026-09-24 01:00:00.2' }],
  summaryCount: 3,
  workUnitCount: 2,
  truncated: false,
  contentError: '',
}

/** A content-bearing answer, in the wire shape. */
const CONTENT_ANSWER = { session: SESSION_VIEW, updatedAt: 100, content: true, ...CONTENT }
/** A status-only answer: the cheap poll. */
const STATUS_ANSWER = { session: SESSION_VIEW, updatedAt: 200, content: false }

function parse(answer) {
  const parsed = parseMemoryPayload(answer, SESSION)
  assert.ok(parsed !== undefined)
  return parsed
}

test('one refresh reads one same-origin path, parameterized by session', () => {
  const url = memoryUrl(SESSION, false)
  assert.ok(url.startsWith(`${MEMORY_API_PREFIX}/session?`))
  const parsed = new URL(url, 'http://127.0.0.1:3080')
  assert.equal(parsed.searchParams.get('session'), SESSION)
  assert.equal(parsed.searchParams.get('content'), null, 'status alone does not ask for the shelf')
  assert.equal(new URL(memoryUrl(SESSION, true), 'http://x').searchParams.get('content'), '1')
})

test('a content answer parses into the session and the shelf halves', () => {
  const parsed = parse(CONTENT_ANSWER)
  assert.equal(parsed.session.known, true)
  assert.equal(parsed.session.loggedSeq, 481)
  assert.deepEqual(parsed.content, {
    summaries: CONTENT.summaries,
    workUnits: CONTENT.workUnits,
    summaryCount: 3,
    workUnitCount: 2,
    truncated: false,
    error: '',
  })
})

test('a status-only answer carries NO content, not empty content', () => {
  // The distinction is the whole point: `[]` here is what erased the panel.
  assert.equal(parse(STATUS_ANSWER).content, undefined)
})

test('a Host that predates the flag is still read correctly', () => {
  // The deployed Host answers status-only with no content keys and no flag; a
  // bundle that needed the flag would keep the bug until the next restart.
  const legacyStatus = { session: SESSION_VIEW, updatedAt: 200 }
  assert.equal(parse(legacyStatus).content, undefined)
  const legacyContent = { session: SESSION_VIEW, updatedAt: 100, ...CONTENT }
  assert.deepEqual(parse(legacyContent).content?.summaries, CONTENT.summaries)
  // And the whole regression, against that Host: a poll must not blank the panel.
  const merged = mergeMemory(parse(legacyContent), parse(legacyStatus))
  assert.deepEqual(merged.content?.summaries, CONTENT.summaries)
  assert.deepEqual(merged.content?.workUnits, CONTENT.workUnits)
})

/* ---------------------------------------------------------------- merging -- */

test('a status-only poll keeps the content already on screen', () => {
  // The regression: the five-second poll asks for status only, so assigning its
  // answer wholesale blanked the summaries and work units the reader was
  // looking at.
  const first = parse(CONTENT_ANSWER)
  const merged = mergeMemory(first, parse(STATUS_ANSWER))

  assert.deepEqual(merged.content?.summaries, CONTENT.summaries)
  assert.deepEqual(merged.content?.workUnits, CONTENT.workUnits)
  assert.equal(merged.content?.summaryCount, 3)
  assert.equal(merged.session.loggedSeq, 481, 'status is always the newest')
  assert.equal(merged.updatedAt, 200)
})

test('a later content answer replaces the content', () => {
  const first = parse(CONTENT_ANSWER)
  const next = parse({
    ...CONTENT_ANSWER,
    updatedAt: 300,
    summaries: [{ name: `sum-${SESSION}-6-9`, markdown: 'newer', level: 1, createdAt: 't' }],
    summaryCount: 1,
  })
  const merged = mergeMemory(first, next)
  assert.deepEqual(merged.content?.summaries.map((entry) => entry.name), [`sum-${SESSION}-6-9`])
  assert.equal(merged.content?.summaryCount, 1)
})

test('a failed shelf read keeps what was shown and records the error', () => {
  const first = parse(CONTENT_ANSWER)
  const failed = parse({ ...CONTENT_ANSWER, updatedAt: 400, contentError: 'hypatia mcp timed out' })
  const merged = mergeMemory(first, failed)

  assert.equal(merged.content?.error, 'hypatia mcp timed out')
  assert.deepEqual(merged.content?.summaries, CONTENT.summaries, 'a transient failure does not blank the panel')
  assert.deepEqual(merged.content?.workUnits, CONTENT.workUnits)
})

test('a failed shelf read keeps the counts that describe the kept entries', () => {
  // The Host answers a broken shelf with zeroed counts; carrying those onto the
  // kept list would read "showing 1 of 0".
  const first = parse({ ...CONTENT_ANSWER, truncated: true })
  const failed = parse({
    ...CONTENT_ANSWER,
    summaries: [], workUnits: [], summaryCount: 0, workUnitCount: 0, truncated: false, contentError: 'boom',
  })
  const merged = mergeMemory(first, failed)
  assert.equal(merged.content?.summaryCount, 3)
  assert.equal(merged.content?.workUnitCount, 2)
  assert.equal(merged.content?.truncated, true)
  assert.equal(merged.content?.error, 'boom')
})

test('a second consecutive failure still keeps what was shown', () => {
  // The regression that the first failure's guard introduced: once the kept
  // content carried an error, the next failure stopped being merged and the
  // panel fell back to the Host's zeroed answer.
  const first = parse(CONTENT_ANSWER)
  const failed = parse({
    ...CONTENT_ANSWER,
    summaries: [], workUnits: [], summaryCount: 0, workUnitCount: 0, truncated: false, contentError: 'boom',
  })
  const once = mergeMemory(first, failed)
  const twice = mergeMemory(once, failed)
  const thrice = mergeMemory(twice, failed)

  for (const [label, merged] of [['once', once], ['twice', twice], ['thrice', thrice]]) {
    assert.deepEqual(merged.content?.summaries, CONTENT.summaries, label)
    assert.deepEqual(merged.content?.workUnits, CONTENT.workUnits, label)
    assert.equal(merged.content?.summaryCount, 3, label)
    assert.equal(merged.content?.workUnitCount, 2, label)
    assert.equal(merged.content?.error, 'boom', label)
  }
})

test('a failure with nothing shown yet stays a failure', () => {
  // The shape the Host actually answers a broken shelf with: empty lists plus
  // the reason.
  const failed = parse({
    ...CONTENT_ANSWER,
    summaries: [], workUnits: [], summaryCount: 0, workUnitCount: 0, contentError: 'hypatia mcp timed out',
  })
  const merged = mergeMemory(undefined, failed)
  assert.equal(merged.content?.error, 'hypatia mcp timed out')
  assert.deepEqual(merged.content?.summaries, [])
  assert.deepEqual(merged.content?.workUnits, [])
})

test('a poll before any content answer leaves content absent', () => {
  assert.equal(mergeMemory(undefined, parse(STATUS_ANSWER)).content, undefined)
})

/* --------------------------------------------------------------- parsing -- */

test('a payload without a usable session is rejected, not rendered as zeros', () => {
  assert.equal(parseMemoryPayload(undefined, SESSION), undefined)
  assert.equal(parseMemoryPayload({}, SESSION), undefined)
  assert.equal(parseMemoryPayload({ session: 'nope' }, SESSION), undefined)
  assert.equal(parseMemoryPayload([CONTENT_ANSWER], SESSION), undefined)
})

test('a malformed field falls back to its zero value instead of reaching the DOM', () => {
  const parsed = parseMemoryPayload({
    session: { known: 'yes', loggedSeq: 'many', pendingTokens: Number.NaN, sessionNode: 'yes', failedTasks: 'nope' },
    content: true,
    summaries: [{}, { name: '' }, 'nope', { name: 'sum-s-1-2' }],
    workUnits: 'nope',
    updatedAt: 'later',
  }, SESSION)
  assert.equal(parsed.session.sessionId, SESSION, 'the asked-for session is the fallback identity')
  assert.deepEqual(
    { known: parsed.session.known, loggedSeq: parsed.session.loggedSeq, sessionNode: parsed.session.sessionNode },
    { known: false, loggedSeq: 0, sessionNode: false },
  )
  assert.deepEqual(parsed.session.failedTasks, [])
  assert.deepEqual(parsed.content?.summaries.map((entry) => entry.name), ['sum-s-1-2'])
  assert.equal(parsed.content?.summaries[0].level, 1, 'a missing tier reads as the message tier')
  assert.deepEqual(parsed.content?.workUnits, [])
  assert.equal(parsed.updatedAt, 0)
})

test('the gap between the two watermarks is what is left to summarise', () => {
  const withGap = { ...SESSION_VIEW, loggedSeq: 1778, consolidatedSeq: 1131 }
  assert.equal(consolidationGap(withGap), 647)
  assert.equal(consolidationGap({ ...withGap, consolidatedSeq: 1778 }), 0)
  // A run may cover a range logging has not reached yet; that is not a backlog.
  assert.equal(consolidationGap({ ...withGap, loggedSeq: 100, consolidatedSeq: 300 }), 0)
})
