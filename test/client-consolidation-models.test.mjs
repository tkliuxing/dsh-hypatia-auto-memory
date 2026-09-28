/**
 * The card-side projections behind the consolidation model picker.
 *
 * Two orders must not be confused: the CATALOG order is how providers advertise
 * their models and is what a picker lists, while the STORED order is the
 * priority order the Host actually reads. `orderedConsolidationModels` is the
 * latter — the card used to render the former, so a user's chosen order was
 * invisible.
 *
 * The thinking-level picker follows the same rule in a different dimension: its
 * VOCABULARY comes from the route's own catalog metadata, never from a list
 * hard-coded here, because the ids are adapter-owned and opaque.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  consolidationModelCandidates,
  consolidationModelKey,
  moveConsolidationModel,
  orderedConsolidationModels,
  reasoningEffortChoices,
} from '../src/client/consolidation-models.ts'

const LUNA_REASONING = {
  efforts: [
    { id: 'off', name: 'Off', description: 'simple tasks' },
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
  ],
  defaultEffort: 'high',
}

const GROUPS = [
  {
    id: 'openai',
    name: 'OpenAI',
    models: [{ id: 'luna', name: 'Luna', reasoning: LUNA_REASONING }, { id: 'solar', name: 'Solar' }],
  },
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    // A route with no reasoning control at all, which the card must not invent
    // one for.
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
    reasoningEffort: undefined,
  })
})

/* -------------------------------------------------------------------------- */
/* reasoningEffortChoices                                                     */
/* -------------------------------------------------------------------------- */

test('always offers "follow the purpose policy" first', () => {
  // It is not the adapter's default: an absent field is what lets the plugin's
  // own per-purpose policy apply, so it must stay distinguishable and reachable.
  const choices = reasoningEffortChoices(LUNA_REASONING, undefined)

  assert.deepEqual(choices[0], { key: 'purpose', effort: undefined })
  assert.equal(choices[0].effort !== undefined, false)
})

test('lists exactly what the route declares, with the adapter names, in its order', () => {
  const choices = reasoningEffortChoices(LUNA_REASONING, undefined)

  assert.deepEqual(choices.slice(1), [
    { key: 'effort:off', effort: 'off', name: 'Off' },
    { key: 'effort:low', effort: 'low', name: 'Low' },
    { key: 'effort:high', effort: 'high', name: 'High' },
  ])
})

test('offers nothing to choose when the route declares no reasoning control', () => {
  // Inventing a vocabulary here is how a call gets a guaranteed
  // `UNSUPPORTED_REASONING_EFFORT` instead of a result.
  assert.deepEqual(reasoningEffortChoices(undefined, undefined), [{ key: 'purpose', effort: undefined }])
  assert.deepEqual(reasoningEffortChoices({ efforts: [] }, undefined), [{ key: 'purpose', effort: undefined }])
})

test('keeps a stored level the route no longer declares, flagged', () => {
  const choices = reasoningEffortChoices(LUNA_REASONING, 'max')

  assert.deepEqual(choices.at(-1), { key: 'stale:max', effort: 'max', stale: true })
})

test('a stored level the route does declare is not duplicated', () => {
  const choices = reasoningEffortChoices(LUNA_REASONING, 'low')

  assert.deepEqual(choices.map(choice => choice.key), ['purpose', 'effort:off', 'effort:low', 'effort:high'])
})

test('a route that vanished still shows its stored level', () => {
  // The catalog no longer advertises the route, so there is no vocabulary to
  // offer — but silently rewriting the user's configuration is worse than
  // showing the value that is actually stored.
  assert.deepEqual(reasoningEffortChoices(undefined, 'low'), [
    { key: 'purpose', effort: undefined },
    { key: 'stale:low', effort: 'low', stale: true },
  ])
})

test('blank and unusable stored values add no option', () => {
  for (const stored of [undefined, '', '   ', 7]) {
    assert.equal(reasoningEffortChoices(LUNA_REASONING, stored).length, 4, String(stored))
  }
})

test('a malformed catalog entry is skipped rather than offered', () => {
  const choices = reasoningEffortChoices({ efforts: [{ id: '', name: 'Blank' }, { name: 'Nameless' }, { id: 'low' }] }, undefined)

  assert.deepEqual(choices, [
    { key: 'purpose', effort: undefined },
    { key: 'effort:low', effort: 'low', name: 'low' },
  ])
})

/* -------------------------------------------------------------------------- */
/* reasoningEffort on the projections                                         */
/* -------------------------------------------------------------------------- */

test('candidates carry the route reasoning metadata the picker needs', () => {
  const candidates = consolidationModelCandidates(GROUPS, [], new Set())

  assert.equal(candidates.find(c => c.key === consolidationModelKey(LUNA)).reasoning, LUNA_REASONING)
  assert.equal(candidates.find(c => c.key === consolidationModelKey(FLASH)).reasoning, undefined,
    'a model that declares no reasoning control must not be given one')
})

test('the ordered list carries the STORED level and the CATALOG vocabulary', () => {
  // Two different sources on purpose: what the user chose (stored) and what the
  // model accepts (catalog) — the card needs both to render one row.
  const stored = [{ ...LUNA, reasoningEffort: 'low' }, FLASH]
  const candidates = consolidationModelCandidates(GROUPS, stored, new Set(stored.map(consolidationModelKey)))

  const ordered = orderedConsolidationModels(stored, candidates)

  assert.equal(ordered[0].reasoningEffort, 'low')
  assert.equal(ordered[0].reasoning, LUNA_REASONING)
  assert.equal(ordered[1].reasoningEffort, undefined)
  assert.equal(ordered[1].reasoning, undefined)
})

test('a route with no catalog entry keeps its stored level but gets no vocabulary', () => {
  const stored = [{ provider: 'gone', model: 'retired', reasoningEffort: 'high' }]
  const candidates = consolidationModelCandidates(GROUPS, stored, new Set(stored.map(consolidationModelKey)))

  const ordered = orderedConsolidationModels(stored, candidates)

  assert.equal(ordered[0].reasoningEffort, 'high')
  assert.equal(ordered[0].reasoning, undefined)
  assert.deepEqual(reasoningEffortChoices(ordered[0].reasoning, ordered[0].reasoningEffort), [
    { key: 'purpose', effort: undefined },
    { key: 'stale:high', effort: 'high', stale: true },
  ])
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
