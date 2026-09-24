/**
 * The Memory tab's status fold: the two state tables flattened into per-session
 * rows, and one session's view derived from them.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ERROR_MAX, FAILED_LIMIT, buildStatus, sessionView } from '../src/memory-status.js'

/* -------------------------------------------------------------- building -- */

test('a session with a progress row carries its watermarks, not the raw names', () => {
  const built = buildStatus({
    progressEntries: [['session-a', {
      lastLoggedSeq: 481,
      lastConsolidatedSeq: 463,
      lastCheckTurn: 3,
      pendingTokens: 5,
      hasSessionNode: 1,
      lastBelongToIndex: 38,
    }]],
    taskEntries: [],
  })
  assert.deepEqual(built.sessions, [{
    id: 'session-a',
    logged: 481,
    consolidated: 463,
    checkTurn: 3,
    pendingTokens: 5,
    sessionNode: true,
    belongTo: 38,
    deferred: 0,
    failed: 0,
    error: '',
  }])
  assert.deepEqual(built.failed, [])
  assert.equal(built.total, 1)
})

test('a row missing newer fields is filled from the protocol defaults', () => {
  const built = buildStatus({ progressEntries: [['s', { lastLoggedSeq: 9 }]], taskEntries: [] })
  assert.deepEqual(built.sessions[0], {
    id: 's',
    logged: 9,
    consolidated: 0,
    checkTurn: 0,
    pendingTokens: 0,
    sessionNode: false,
    belongTo: 0,
    deferred: 0,
    failed: 0,
    error: '',
  })
})

test('a session known only from a task still appears, with a reason', () => {
  const built = buildStatus({
    progressEntries: [],
    taskEntries: [['log-message:orphan', {
      kind: 'log-message',
      sessionId: 'orphan',
      status: 'failed',
      attempts: 3,
      error: 'hypatia mcp timed out',
    }]],
  })
  assert.equal(built.sessions.length, 1)
  assert.equal(built.sessions[0].id, 'orphan')
  assert.equal(built.sessions[0].failed, 1)
  assert.equal(built.sessions[0].logged, 0, 'no progress row means no watermark, not a fake one')
  assert.equal(built.sessions[0].error, 'hypatia mcp timed out')
  assert.deepEqual(built.failed, [{
    kind: 'log-message',
    sessionId: 'orphan',
    attempts: 3,
    error: 'hypatia mcp timed out',
  }])
})

test('task counts fold onto their session and deferrals are counted, not listed', () => {
  const built = buildStatus({
    progressEntries: [['s', { lastLoggedSeq: 4 }]],
    taskEntries: [
      ['consolidate:s', { kind: 'consolidate', sessionId: 's', status: 'deferred', attempts: 0, error: 'not loaded' }],
      ['cascade:s', { kind: 'cascade', sessionId: 's', status: 'deferred', attempts: 0, error: 'not loaded' }],
      ['log-message:s', { kind: 'log-message', sessionId: 's', status: 'failed', attempts: 2, error: 'first' }],
      ['session-node:s', { kind: 'session-node', sessionId: 's', status: 'failed', attempts: 2, error: 'second' }],
      ['cascade:other', { kind: 'cascade', sessionId: 'other', status: 'pending', attempts: 0, error: null }],
    ],
  })
  const session = built.sessions.find((entry) => entry.id === 's')
  assert.equal(session.deferred, 2)
  assert.equal(session.failed, 2)
  assert.equal(session.error, 'first', 'the first failure explains the session')
  assert.equal(built.sessions.find((entry) => entry.id === 'other').error, '')
  assert.equal(built.failed.length, 2, 'every failure is listed, not just the first')
})

test('a task row with no session id is ignored rather than filed under ""', () => {
  const built = buildStatus({
    progressEntries: [],
    taskEntries: [['broken', { kind: 'log-message', status: 'failed', error: 'nope' }]],
  })
  assert.deepEqual(built, { sessions: [], failed: [], total: 0 })
})

test('task errors are bounded the way every other diagnostic path bounds them', () => {
  const long = 'x'.repeat(ERROR_MAX + 50)
  const built = buildStatus({
    progressEntries: [],
    taskEntries: [['log-message:s', { kind: 'log-message', sessionId: 's', status: 'failed', attempts: 1, error: long }]],
  })
  assert.equal(built.failed[0].error.length, ERROR_MAX + 1, 'a capped error carries one ellipsis')
  assert.ok(built.failed[0].error.endsWith('…'))
})

test('the failure list is bounded so a backlog cannot grow the response', () => {
  const taskEntries = []
  for (let index = 0; index < FAILED_LIMIT + 5; index += 1) {
    taskEntries.push([`log-message:s${String(index)}`, {
      kind: 'log-message', sessionId: `s${String(index)}`, status: 'failed', attempts: 1, error: 'e',
    }])
  }
  const built = buildStatus({ progressEntries: [], taskEntries })
  assert.equal(built.failed.length, FAILED_LIMIT)
  assert.equal(built.sessions.length, FAILED_LIMIT + 5, 'sessions are not dropped; only the failure list is capped')
})

/* ----------------------------------------------------------------- views -- */

test('an unknown session reads as caught up, not as behind', () => {
  const built = buildStatus({ progressEntries: [], taskEntries: [] })
  const view = sessionView(built, 'session-missing')
  assert.equal(view.known, false)
  assert.equal(view.caughtUp, true, 'nothing logged and nothing consolidated is not a backlog')
  assert.deepEqual(view.failedTasks, [])
  assert.equal(view.loggedSeq, 0)
})

test('caught up is consolidation reaching the logging watermark', () => {
  const built = buildStatus({
    progressEntries: [['session-a', { lastLoggedSeq: 481, lastConsolidatedSeq: 463, pendingTokens: 5, hasSessionNode: 1 }]],
    taskEntries: [],
  })
  const view = sessionView(built, 'session-a')
  assert.equal(view.known, true)
  assert.equal(view.caughtUp, false, '463 < 481')
  assert.equal(view.loggedSeq, 481)
  assert.equal(view.consolidatedSeq, 463)
  assert.equal(view.pendingTokens, 5)
  assert.equal(view.sessionNode, true)

  const even = buildStatus({
    progressEntries: [['session-a', { lastLoggedSeq: 10, lastConsolidatedSeq: 10 }]],
    taskEntries: [],
  })
  assert.equal(sessionView(even, 'session-a').caughtUp, true)
})

test('a session view carries only its own failures', () => {
  const built = buildStatus({
    progressEntries: [],
    taskEntries: [
      ['consolidate:a', { kind: 'consolidate', sessionId: 'a', status: 'failed', attempts: 1, error: 'one' }],
      ['cascade:b', { kind: 'cascade', sessionId: 'b', status: 'failed', attempts: 2, error: 'two' }],
      ['log-message:a', { kind: 'log-message', sessionId: 'a', status: 'failed', attempts: 3, error: 'three' }],
    ],
  })
  assert.deepEqual(sessionView(built, 'a').failedTasks.map((task) => task.error), ['one', 'three'])
  assert.deepEqual(sessionView(built, 'c').failedTasks, [])
})

test('a one-session fold caps only that session\'s failures', () => {
  // Other sessions' backlog fills the global cap first in table order; scoped to
  // the session, its own failures are never crowded out.
  const taskEntries = []
  for (let index = 0; index < FAILED_LIMIT + 5; index += 1) {
    taskEntries.push([`log-message:s${String(index)}`, {
      kind: 'log-message', sessionId: `s${String(index)}`, status: 'failed', attempts: 1, error: 'other',
    }])
  }
  taskEntries.push(['consolidate:mine', { kind: 'consolidate', sessionId: 'mine', status: 'failed', attempts: 3, error: 'mine' }])
  const built = buildStatus({
    progressEntries: [['mine', { lastLoggedSeq: 4 }], ['s0', { lastLoggedSeq: 9 }]],
    taskEntries,
    sessionId: 'mine',
  })
  assert.deepEqual(built.sessions.map((session) => session.id), ['mine'])
  assert.deepEqual(sessionView(built, 'mine').failedTasks.map((task) => task.error), ['mine'])
})
