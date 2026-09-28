/**
 * The consolidation route selector. `consolidation.models` is a PRIORITY order,
 * not a rotation: a task's first attempt takes the head, each queue retry steps
 * one route down, and past the end the lowest-priority route is reused rather
 * than wrapping back to the head (which would re-ask the route that just
 * failed).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { selectConsolidationRoute } from '../src/consolidator.js'

const ROUTES = [
  { provider: 'alpha', model: 'fast' },
  { provider: 'beta', model: 'accurate' },
  { provider: 'gamma', model: 'cheap' },
]

test('the first attempt takes the highest-priority route', () => {
  assert.deepEqual(selectConsolidationRoute(ROUTES, 0), ROUTES[0])
  assert.deepEqual(selectConsolidationRoute(ROUTES), ROUTES[0], 'an absent attempt is the first attempt')
})

test('each failed attempt degrades one route down the list', () => {
  assert.deepEqual(selectConsolidationRoute(ROUTES, 0), ROUTES[0])
  assert.deepEqual(selectConsolidationRoute(ROUTES, 1), ROUTES[1])
  assert.deepEqual(selectConsolidationRoute(ROUTES, 2), ROUTES[2])
})

test('past the end the lowest-priority route is reused, never the head', () => {
  assert.deepEqual(selectConsolidationRoute(ROUTES, 3), ROUTES[2])
  assert.deepEqual(selectConsolidationRoute(ROUTES, 99), ROUTES[2])
})

test('a one-model configuration serves every attempt the same route', () => {
  const only = [ROUTES[0]]
  for (const attempt of [0, 1, 2, 5]) {
    assert.deepEqual(selectConsolidationRoute(only, attempt), ROUTES[0])
  }
})

test('an empty or absent list answers undefined', () => {
  assert.equal(selectConsolidationRoute([]), undefined)
  assert.equal(selectConsolidationRoute([], 2), undefined)
  assert.equal(selectConsolidationRoute(undefined), undefined)
})

test('an unusable attempt index reads as the first attempt', () => {
  // The conservative reading: a corrupt counter must not silently demote the
  // preferred route.
  for (const attempt of [Number.NaN, -1, -99, Number.POSITIVE_INFINITY, '1']) {
    assert.deepEqual(selectConsolidationRoute(ROUTES, attempt), ROUTES[0], `attempt=${String(attempt)}`)
  }
})

test('a fractional attempt index is truncated, not rounded up', () => {
  assert.deepEqual(selectConsolidationRoute(ROUTES, 1.9), ROUTES[1])
})
