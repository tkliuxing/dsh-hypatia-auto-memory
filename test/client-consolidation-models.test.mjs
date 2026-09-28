/**
 * The card-side projections behind the consolidation model picker.
 *
 * Two orders must not be confused: the CATALOG order is how providers advertise
 * their models and is what a picker lists, while the STORED order is the
 * priority order the Host actually reads. `orderedConsolidationModels` is the
 * latter — the card used to render the former, so a user's chosen order was
 * invisible.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  consolidationModelCandidates,
  consolidationModelKey,
  moveConsolidationModel,
  orderedConsolidationModels,
} from '../src/client/consolidation-models.ts'

const GROUPS = [
  {
    id: 'openai',
    name: 'OpenAI',
    models: [{ id: 'luna', name: 'Luna' }, { id: 'solar', name: 'Solar' }],
  },
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [{ id: 'flash', name: 'Flash' }],
  },
]

const LUNA = { provider: 'openai', model: 'luna' }
const SOLAR = { provider: 'openai', model: 'solar' }
const FLASH = { provider: 'deepseek-official', model: 'flash' }

/* -------------------------------------------------------------------------- */
/* moveConsolidationModel                                                     */
/* -------------------------------------------------------------------------- */

test('moves one entry down and back up', () => {
  const models = [LUNA, SOLAR, FLASH]

  assert.deepEqual(moveConsolidationModel(models, 0, 1), [SOLAR, LUNA, FLASH])
  assert.deepEqual(moveConsolidationModel(models, 2, 0), [FLASH, LUNA, SOLAR])
})

test('clamps the target instead of rejecting it', () => {
  const models = [LUNA, SOLAR, FLASH]

  assert.deepEqual(moveConsolidationModel(models, 0, 99), [SOLAR, FLASH, LUNA])
  assert.deepEqual(moveConsolidationModel(models, 2, -99), [FLASH, LUNA, SOLAR])
})

test('a move that changes nothing returns the original array', () => {
  const models = [LUNA, SOLAR, FLASH]

  assert.equal(moveConsolidationModel(models, 1, 1), models, 'same index')
  assert.equal(moveConsolidationModel(models, -1, 0), models, 'from before the start')
  assert.equal(moveConsolidationModel(models, 3, 0), models, 'from past the end')
  assert.equal(moveConsolidationModel(models, 0, Number.NaN), models, 'unusable target')
  assert.equal(moveConsolidationModel(models, 0.5, 1), models, 'fractional source')
})

test('never mutates the array it is given', () => {
  const models = [LUNA, SOLAR, FLASH]
  const moved = moveConsolidationModel(models, 0, 2)

  assert.deepEqual(models, [LUNA, SOLAR, FLASH])
  assert.notEqual(moved, models)
})

/* -------------------------------------------------------------------------- */
/* orderedConsolidationModels                                                 */
/* -------------------------------------------------------------------------- */

test('follows the stored priority order, not the catalog order', () => {
  // Catalog order is luna, solar, flash; the stored order is the reverse.
  const stored = [FLASH, SOLAR, LUNA]
  const candidates = consolidationModelCandidates(GROUPS, stored, new Set(stored.map(consolidationModelKey)))

  assert.deepEqual(
    orderedConsolidationModels(stored, candidates).map(route => route.key),
    stored.map(consolidationModelKey),
  )
})

test('resolves display names and availability from the catalog', () => {
  const stored = [FLASH, LUNA]
  const candidates = consolidationModelCandidates(GROUPS, stored, new Set(stored.map(consolidationModelKey)))

  const ordered = orderedConsolidationModels(stored, candidates)

  assert.deepEqual(ordered.map(route => [route.modelName, route.providerName, route.available]), [
    ['Flash', 'DeepSeek', true],
    ['Luna', 'OpenAI', true],
  ])
})

test('keeps a stored route the catalog no longer advertises', () => {
  const retired = { provider: 'gone', model: 'retired' }
  const stored = [retired, LUNA]
  const candidates = consolidationModelCandidates(GROUPS, stored, new Set(stored.map(consolidationModelKey)))

  const ordered = orderedConsolidationModels(stored, candidates)

  assert.deepEqual(ordered[0], {
    provider: 'gone',
    model: 'retired',
    key: consolidationModelKey(retired),
    providerName: 'gone',
    modelName: 'retired',
    available: false,
    selected: true,
  })
})

test('shows a stored route even when it is missing from the candidate list', () => {
  // Defence in depth: dropping it would hide a configured route from the only
  // UI that can remove it.
  const ordered = orderedConsolidationModels([LUNA], [])

  assert.equal(ordered.length, 1)
  assert.equal(ordered[0].available, false)
  assert.equal(ordered[0].key, consolidationModelKey(LUNA))
})

test('an empty selection has no ordered entries', () => {
  assert.deepEqual(orderedConsolidationModels([], consolidationModelCandidates(GROUPS, [], new Set())), [])
})
