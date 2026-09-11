import assert from 'node:assert/strict'
import test from 'node:test'
import { createConsolidationRouteSelector } from '../src/consolidator.js'

test('cycles selected consolidation routes across every attempt', () => {
  const selectRoute = createConsolidationRouteSelector()
  const routes = [
    { provider: 'alpha', model: 'fast' },
    { provider: 'beta', model: 'accurate' },
  ]

  assert.deepEqual(selectRoute(routes), routes[0])
  assert.deepEqual(selectRoute(routes), routes[1])
  assert.deepEqual(selectRoute(routes), routes[0])
})

test('does not advance the round-robin cursor when no route is selected', () => {
  const selectRoute = createConsolidationRouteSelector()
  const route = { provider: 'alpha', model: 'fast' }

  assert.equal(selectRoute([]), undefined)
  assert.deepEqual(selectRoute([route]), route)
})
