/**
 * Recall seed: source kind, content rendering, and enablement guards.
 *
 * The seed is the only persistent user message this plugin injects, so its
 * `source.kind` must be a producer-owned value (`plugin:<name>`) rather than
 * the retired bare `plugin` kind that dsh v4 session format rejects.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createRecall } from '../src/recall.js'
import { PLUGIN_NAME } from '../src/consolidator.js'
import { DEFAULT_SHELF } from '../src/shelf.js'

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

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    recall: { enabled: true, preloadRulesTaboos: true, ...overrides.recall },
    ...overrides,
  }
}

function makeAgent(overrides = {}) {
  const injected = []
  return {
    injected,
    session: { id: 'session-test', cwd: '/w', ...overrides.session },
    inject: (message) => injected.push(message),
  }
}

function makeCli(answers = { knowledge: [] }) {
  const queries = []
  return {
    queries,
    async query(jse) {
      queries.push(jse)
      const doc = JSON.parse(jse)
      const key = doc[0] === '$knowledge' ? 'knowledge' : 'statement'
      const queue = answers[key]
      return queue === undefined || queue.length === 0 ? [] : queue.shift()
    },
  }
}

function makeCtx(overrides = {}) {
  const registered = []
  return {
    registered,
    on: (event, handler) => registered.push([event, handler]),
    agents: { list: () => [] },
    ...overrides,
  }
}

function makeDeps(overrides = {}) {
  return {
    ctx: makeCtx(overrides.ctx),
    cli: makeCli(overrides.answers),
    shelf: overrides.shelf ?? DEFAULT_SHELF,
    getConfig: () => makeConfig(overrides.config),
    status: makeStatus(),
    projectFor: async () => 'proj',
    ...overrides.deps,
  }
}

test('recall injects a producer-owned source kind that dsh v4 admits', async () => {
  const deps = makeDeps({
    answers: {
      knowledge: [
        [{ key: 'rule-1', content: { data: 'Always write tests.' } }],
      ],
    },
  })
  const agent = makeAgent()
  const { preloadRulesAndTaboos } = createRecall({ ...deps, shelf: deps.shelf })

  await preloadRulesAndTaboos(agent)

  assert.equal(agent.injected.length, 1, 'one seed message is injected')
  const message = agent.injected[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, `plugin:${PLUGIN_NAME}`, 'must use producer-owned kind')
  assert.equal(message.source.plugin, PLUGIN_NAME)
  assert.equal(message.source.form, 'recall')
  assert.ok(message.content[0].text.includes('### Rules'))
  assert.ok(message.content[0].text.includes('Always write tests.'))
  assert.equal(deps.status.lines.length, 0, 'no warnings on happy path')
})

test('recall seed is skipped by the collector', async () => {
  const deps = makeDeps({
    answers: {
      knowledge: [
        [{ key: 'rule-1', content: { data: 'No secrets in logs.' } }],
      ],
    },
  })
  const agent = makeAgent()
  const { preloadRulesAndTaboos } = createRecall({ ...deps, shelf: deps.shelf })

  await preloadRulesAndTaboos(agent)
  const [message] = agent.injected

  // `isLoggableMessage` is the gatekeeper that decides what gets stored back
  // into hypatia. The seed must not be re-logged, regardless of its kind.
  const { isLoggableMessage } = await import('../src/collector.js')
  assert.equal(isLoggableMessage({
    type: 'user/message',
    data: { source: message.source, content: message.content },
  }), false)
})

test('recall names the shelf when it is not default', async () => {
  const deps = makeDeps({ shelf: 'work' })
  const agent = makeAgent()
  const { preloadRulesAndTaboos } = createRecall({ ...deps, shelf: deps.shelf })

  await preloadRulesAndTaboos(agent)

  assert.equal(agent.injected.length, 1)
  assert.ok(agent.injected[0].content[0].text.includes('Memory lives on the hypatia shelf `work`'))
})

test('recall skips injection when disabled and shelf is default', async () => {
  const deps = makeDeps({ config: { recall: { enabled: false } } })
  const agent = makeAgent()
  const { preloadRulesAndTaboos } = createRecall({ ...deps, shelf: deps.shelf })

  await preloadRulesAndTaboos(agent)

  assert.equal(agent.injected.length, 0)
})

test('recall skips injection when preloading is off and shelf is default', async () => {
  const deps = makeDeps({ config: { recall: { preloadRulesTaboos: false } } })
  const agent = makeAgent()
  const { preloadRulesAndTaboos } = createRecall({ ...deps, shelf: deps.shelf })

  await preloadRulesAndTaboos(agent)

  assert.equal(agent.injected.length, 0)
})

test('recall still names the shelf even when preloading is off', async () => {
  const deps = makeDeps({ shelf: 'work', config: { recall: { preloadRulesTaboos: false } } })
  const agent = makeAgent()
  const { preloadRulesAndTaboos } = createRecall({ ...deps, shelf: deps.shelf })

  await preloadRulesAndTaboos(agent)

  assert.equal(agent.injected.length, 1)
  assert.ok(agent.injected[0].content[0].text.includes('Memory lives on the hypatia shelf `work`'))
})

test('recall renders taboos and keeps rules and taboos in separate sections', async () => {
  const deps = makeDeps({
    answers: {
      knowledge: [
        [{ key: 'rule-1', content: { data: 'Rule one.' } }],
        [{ key: 'taboo-1', content: { data: 'Taboo one.' } }],
      ],
    },
  })
  const agent = makeAgent()
  const { preloadRulesAndTaboos } = createRecall({ ...deps, shelf: deps.shelf })

  await preloadRulesAndTaboos(agent)

  const text = agent.injected[0].content[0].text
  assert.ok(text.includes('### Rules'))
  assert.ok(text.includes('Rule one.'))
  assert.ok(text.includes('### Taboos'))
  assert.ok(text.includes('Taboo one.'))
  assert.ok(text.indexOf('### Rules') < text.indexOf('### Taboos'))
})

test('recall logs query failures as warnings instead of throwing', async () => {
  const deps = {
    ctx: makeCtx(),
    cli: {
      async query() { throw new Error('hypatia is unreachable') },
    },
    shelf: DEFAULT_SHELF,
    getConfig: () => makeConfig(),
    status: makeStatus(),
    projectFor: async () => 'proj',
  }
  const agent = makeAgent()
  const { preloadRulesAndTaboos } = createRecall(deps)

  await preloadRulesAndTaboos(agent)

  assert.equal(agent.injected.length, 0)
  assert.equal(deps.status.lines.length, 2)
  assert.match(deps.status.lines[0][1], /rules preload query failed/)
  assert.match(deps.status.lines[1][1], /taboos preload query failed/)
})

test('recall registers an agent/created listener and seeds existing agents', async () => {
  const existing = makeAgent()
  const deps = makeDeps({
    ctx: {
      on: (event, handler) => {},
      agents: { list: () => [existing] },
    },
    answers: {
      knowledge: [[{ key: 'rule-1', content: { data: 'x' } }]],
    },
  })

  createRecall({ ...deps, shelf: deps.shelf })

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(existing.injected.length, 1)
})
