/**
 * Reasoning-effort resolution.
 *
 * Two layers, tested separately because they fail differently: the pure policy
 * (`resolveReasoningEffort`) decides what a call sends, and the resolver decides
 * whether the route can be believed — and reports the one case the pure half
 * cannot, that a CONFIGURED effort was dropped. Dropping it silently is what
 * would make a wrong setting look like a working one.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, sanitizeConfig, snapshotConfig } from '../src/config.js'
import {
  THINKING_OFF_EFFORT,
  createReasoningResolver,
  resolveReasoningEffort,
} from '../src/reasoning.js'

/** Adapter metadata as `llm.resolveModelInfo` returns it. */
function reasoning(...ids) {
  return { efforts: ids.map((id) => ({ id, name: id })) }
}

/* -------------------------------------------------------------------------- */
/* The pure policy                                                            */
/* -------------------------------------------------------------------------- */

test('an unconfigured extraction or adjudication asks for `off` where it exists', () => {
  for (const purpose of ['memory-consolidation', 'memory-adjudication']) {
    assert.deepEqual(
      resolveReasoningEffort({ purpose, configured: undefined, reasoning: reasoning('off', 'high') }),
      { effort: THINKING_OFF_EFFORT },
      purpose,
    )
  }
})

test('an unconfigured cascade sends nothing, leaving the adapter default in place', () => {
  // The archive is semantic compression, not a mechanical transform, so the
  // purpose has no opinion — and a route resolving an omitted effort to `high`
  // is the intended outcome, not an accident.
  assert.deepEqual(
    resolveReasoningEffort({ purpose: 'memory-cascade', configured: undefined, reasoning: reasoning('off', 'high') }),
    {},
  )
})

test('a route without `off` is not asked for it, and not warned about it', () => {
  // This is the plugin's own preference, not a user instruction: refusing it
  // quietly is what the call did before this field existed.
  assert.deepEqual(
    resolveReasoningEffort({ purpose: 'memory-adjudication', configured: undefined, reasoning: reasoning('high') }),
    {},
  )
  assert.deepEqual(
    resolveReasoningEffort({ purpose: 'memory-consolidation', configured: undefined, reasoning: undefined }),
    {},
  )
})

test('a configured effort wins over the purpose policy', () => {
  assert.deepEqual(
    resolveReasoningEffort({ purpose: 'memory-adjudication', configured: 'high', reasoning: reasoning('off', 'high') }),
    { effort: 'high' },
  )
})

test('a configured effort the route does not declare is refused, not sent', () => {
  // Sending it would be a guaranteed `UNSUPPORTED_REASONING_EFFORT` before any
  // provider I/O, which turns a profile typo into a failed queue task.
  assert.deepEqual(
    resolveReasoningEffort({ purpose: 'memory-consolidation', configured: 'max', reasoning: reasoning('off', 'low') }),
    { refused: 'max' },
  )
})

test('a configured effort is refused when the route declares no reasoning at all', () => {
  assert.deepEqual(
    resolveReasoningEffort({ purpose: 'memory-consolidation', configured: 'low', reasoning: undefined }),
    { refused: 'low' },
  )
  assert.deepEqual(
    resolveReasoningEffort({ purpose: 'memory-consolidation', configured: 'low', reasoning: { efforts: [] } }),
    { refused: 'low' },
  )
})

test('the configured value is trimmed before it is matched or sent', () => {
  // The schema only refuses a BLANK, so `" low "` reaches here intact; an exact
  // match against adapter ids would otherwise refuse a value that is spelled
  // correctly apart from the padding.
  assert.deepEqual(
    resolveReasoningEffort({ purpose: 'memory-consolidation', configured: ' low ', reasoning: reasoning('off', 'low') }),
    { effort: 'low' },
  )
})

test('a blank or non-string configured value reads as unconfigured', () => {
  for (const configured of ['', '   ', undefined, null, 42]) {
    assert.deepEqual(
      resolveReasoningEffort({ purpose: 'memory-adjudication', configured, reasoning: reasoning('off') }),
      { effort: THINKING_OFF_EFFORT },
      String(configured),
    )
  }
})

/* -------------------------------------------------------------------------- */
/* The adapter-facing resolver                                                */
/* -------------------------------------------------------------------------- */

/** Records warnings so a test can assert on them. */
function makeStatus() {
  const warnings = []
  return { warnings, warn: (message) => warnings.push(message), info: () => {}, error: () => {}, count: () => {} }
}

test('the capability lookup happens once per route, however many calls ask', async () => {
  const status = makeStatus()
  let calls = 0
  const llm = {
    async resolveModelInfo() {
      calls += 1
      return { reasoning: reasoning('off', 'low') }
    },
  }
  const resolver = createReasoningResolver({ llm, status })

  assert.equal(await resolver.effort({ provider: 'p', model: 'm' }, 'memory-consolidation'), 'off')
  assert.equal(await resolver.effort({ provider: 'p', model: 'm' }, 'memory-adjudication'), 'off')
  assert.equal(calls, 1, 'the second call must be served from the cache')
})

test('the cache is per route, so two models do not share an answer', async () => {
  const status = makeStatus()
  const seen = []
  const llm = {
    async resolveModelInfo(provider, model) {
      seen.push(`${provider}/${model}`)
      return { reasoning: reasoning(model === 'a' ? 'off' : 'low') }
    },
  }
  const resolver = createReasoningResolver({ llm, status })

  assert.equal(await resolver.effort({ provider: 'p', model: 'a' }, 'memory-consolidation'), 'off')
  assert.equal(await resolver.effort({ provider: 'p', model: 'b' }, 'memory-consolidation'), undefined)
  assert.deepEqual(seen, ['p/a', 'p/b'])
})

test('a configured effort the route refuses is dropped and reported once', async () => {
  const status = makeStatus()
  const llm = { async resolveModelInfo() { return { reasoning: reasoning('off', 'low') } } }
  const resolver = createReasoningResolver({ llm, status })
  const route = { provider: 'p', model: 'm', reasoningEffort: 'max' }

  assert.equal(await resolver.effort(route, 'memory-consolidation'), undefined)
  assert.equal(await resolver.effort(route, 'memory-consolidation'), undefined)
  assert.equal(await resolver.effort(route, 'memory-cascade'), undefined)

  assert.equal(status.warnings.length, 1, 'once per route and value, not once per call')
  assert.match(status.warnings[0], /ignoring reasoningEffort "max"/)
  assert.match(status.warnings[0], /declares off, low/)
})

test('an unrefused configuration warns about nothing', async () => {
  const status = makeStatus()
  const llm = { async resolveModelInfo() { return { reasoning: reasoning('off', 'low') } } }
  const resolver = createReasoningResolver({ llm, status })

  assert.equal(await resolver.effort({ provider: 'p', model: 'm', reasoningEffort: 'low' }, 'memory-consolidation'), 'low')
  assert.equal(await resolver.effort({ provider: 'p', model: 'm' }, 'memory-consolidation'), 'off')
  assert.deepEqual(status.warnings, [])
})

test('a route whose capability cannot be read drops the setting with ONE message naming it', async () => {
  // Two warnings for one event would be noise; and the message that matters is
  // the one naming the value the user set, not the adapter's failure alone.
  const status = makeStatus()
  const llm = { async resolveModelInfo() { throw new Error('adapter down') } }
  const resolver = createReasoningResolver({ llm, status })
  const route = { provider: 'p', model: 'm', reasoningEffort: 'low' }

  assert.equal(await resolver.effort(route, 'memory-consolidation'), undefined)
  assert.equal(await resolver.effort(route, 'memory-consolidation'), undefined)
  assert.equal(await resolver.effort(route, 'memory-cascade'), undefined)

  assert.equal(status.warnings.length, 1)
  assert.match(status.warnings[0], /ignoring reasoningEffort "low" for p\/m/)
  assert.match(status.warnings[0], /capability could not be read \(Error: adapter down\)/)
})

test('an unconfigured route still reports a failed capability lookup', async () => {
  // The purpose policy silently stops applying when the lookup fails, so this is
  // the only line that explains why a route that used to skip thinking no longer
  // does.
  const status = makeStatus()
  const llm = { async resolveModelInfo() { throw new Error('socket hang up') } }
  const resolver = createReasoningResolver({ llm, status })

  assert.equal(await resolver.effort({ provider: 'p', model: 'm' }, 'memory-consolidation'), undefined)
  assert.equal(await resolver.effort({ provider: 'p', model: 'm' }, 'memory-adjudication'), undefined)

  assert.deepEqual(status.warnings, ['reasoning capability lookup failed for p/m: Error: socket hang up'])
})

test('an `llm` that cannot be asked about reasoning still runs the policy', async () => {
  // A composition (or a double) without `resolveModelInfo` is not an error: the
  // purpose policy simply finds nothing advertised and sends no effort, which is
  // what every call did before the lookup existed.
  const status = makeStatus()
  const resolver = createReasoningResolver({ llm: {}, status })

  assert.equal(await resolver.effort({ provider: 'p', model: 'm' }, 'memory-consolidation'), undefined)
  assert.deepEqual(status.warnings, [])
})

/* -------------------------------------------------------------------------- */
/* The config surface                                                         */
/* -------------------------------------------------------------------------- */

/** One route as the settings document stores it. */
function readModels(input) {
  // `consolidation` is volatile, so the parsed value is behind a reference.
  return snapshotConfig(Config(input)).consolidation.models
}

test('the field is optional and survives the schema and the sanitizer', () => {
  assert.deepEqual(readModels({ consolidation: { models: [{ provider: 'p', model: 'm' }] } }), [
    { provider: 'p', model: 'm' },
  ], 'absent stays absent, which is what keeps the purpose policy in play')
  assert.deepEqual(readModels({ consolidation: { models: [{ provider: 'p', model: 'm', reasoningEffort: 'low' }] } }), [
    { provider: 'p', model: 'm', reasoningEffort: 'low' },
  ])

  const kept = sanitizeConfig({ consolidation: { models: [{ provider: 'p', model: 'm', reasoningEffort: 'low' }] } }, () => {})
  assert.equal(kept.consolidation.models[0].reasoningEffort, 'low',
    'the sanitizer rebuilds the list and must not drop the field with it')
})

test('a blank level is refused at save time rather than silently ignored', () => {
  // The vocabulary cannot be checked here (it is adapter-owned and opaque), but
  // "set to nothing" is never a meaningful instruction.
  assert.throws(() => readModels({ consolidation: { models: [{ provider: 'p', model: 'm', reasoningEffort: '   ' }] } }))
})

test('a duplicate route is still dropped when one of the pair carries a level', () => {
  const warnings = []
  const value = {
    consolidation: {
      models: [
        { provider: 'p', model: 'm', reasoningEffort: 'low' },
        { provider: 'p', model: 'm', reasoningEffort: 'high' },
      ],
    },
  }
  const kept = sanitizeConfig(value, (message) => warnings.push(message))

  assert.deepEqual(kept.consolidation.models, [{ provider: 'p', model: 'm', reasoningEffort: 'low' }])
  assert.equal(warnings.length, 1)
})
