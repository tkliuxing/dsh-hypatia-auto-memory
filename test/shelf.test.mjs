/**
 * The configurable shelf: per-shelf progress and task rows, the `hypatia list`
 * parser, the inventory the settings card reads, the CLI's shelf routing, the
 * setting's validation, and the recall seed's shelf line.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_SHELF, parseShelfList, publishShelfInventory, shelfTable } from '../src/shelf.js'
import { advanceProgress } from '../src/progress.js'
import { createQueue } from '../src/queue.js'
import { createHypatiaCli } from '../src/hypatia-cli.js'
import { createRecall } from '../src/recall.js'
import { DEFAULTS, INVENTORY_NAMESPACE, InventorySchema, SettingsSchema, installConfig } from '../src/config.js'

/** Map-backed storageDomain table double. */
function makeTable(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    get: (k) => map.get(k),
    put: async (k, v) => void map.set(k, v),
    update: async (k, fn) => {
      const next = fn(map.get(k))
      map.set(k, next)
      return next
    },
    delete: async (k) => map.delete(k),
    entries: () => map.entries(),
    map,
  }
}

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

/* ---------------------------------------------------------------- tables -- */

test('the default shelf reads and writes the legacy, unprefixed rows', async () => {
  const table = makeTable({ s1: { lastLoggedSeq: 7 } })
  const view = shelfTable(table, DEFAULT_SHELF)
  assert.deepEqual(view.get('s1'), { lastLoggedSeq: 7 })
  await view.put('s2', { lastLoggedSeq: 1 })
  assert.ok(table.map.has('s2'), 'no prefix for the default shelf')
})

test('each shelf sees only its own rows, under the keys callers use', async () => {
  const table = makeTable({ s1: { lastLoggedSeq: 7 } })
  const work = shelfTable(table, 'work')
  const other = shelfTable(table, 'other')
  const legacy = shelfTable(table, DEFAULT_SHELF)

  assert.equal(work.get('s1'), undefined, 'a new shelf starts from zero')
  await work.put('s1', { lastLoggedSeq: 3 })
  await other.put('s1', { lastLoggedSeq: 5 })

  assert.deepEqual(work.get('s1'), { lastLoggedSeq: 3 })
  assert.deepEqual(other.get('s1'), { lastLoggedSeq: 5 })
  assert.deepEqual(legacy.get('s1'), { lastLoggedSeq: 7 }, 'switching back resumes the old watermark')
  assert.deepEqual([...work.entries()], [['s1', { lastLoggedSeq: 3 }]])
  assert.deepEqual([...legacy.entries()], [['s1', { lastLoggedSeq: 7 }]], 'default view hides other shelves')

  await work.update('s1', (row) => ({ ...row, lastLoggedSeq: 4 }))
  assert.deepEqual(work.get('s1'), { lastLoggedSeq: 4 })
  await work.delete('s1')
  assert.equal(work.get('s1'), undefined)
  assert.deepEqual(other.get('s1'), { lastLoggedSeq: 5 })
})

test('a shelf name cannot reach into another shelf through its prefix', async () => {
  const table = makeTable()
  await shelfTable(table, 'a/b').put('s1', { v: 1 })
  assert.equal(shelfTable(table, 'a').get('b/s1'), undefined)
  assert.deepEqual([...shelfTable(table, 'a').entries()], [])
})

test('advanceProgress composes through a shelf view', async () => {
  const table = makeTable()
  const view = shelfTable(table, 'work')
  await Promise.all([
    advanceProgress(view, 's1', () => ({ lastLoggedSeq: 4 })),
    advanceProgress(view, 's1', () => ({ lastConsolidatedSeq: 2 })),
  ])
  assert.equal(view.get('s1').lastLoggedSeq, 4)
  assert.equal(view.get('s1').lastConsolidatedSeq, 2)
  assert.equal(table.get('s1'), undefined)
})

test('a queue on one shelf never runs work queued for another', async () => {
  const table = makeTable()
  const status = makeStatus()
  // A long flush window keeps the other shelf's task pending, as a profile
  // reload would leave it.
  const other = createQueue({
    tasks: shelfTable(table, 'other'),
    getConfig: () => ({ concurrency: 1, maxAttempts: 1, retryDelayMs: 5, flushWindowMs: 60_000 }),
    executors: { 'log-message': async () => { throw new Error('never runs here') } },
    status,
  })
  await other.enqueue({ kind: 'log-message', sessionId: 's1', fromSeq: 0, toSeq: 4, project: 'p' })
  await other.dispose()

  const ran = []
  const work = createQueue({
    tasks: shelfTable(table, 'work'),
    getConfig: () => ({ concurrency: 1, maxAttempts: 1, retryDelayMs: 5, flushWindowMs: 0 }),
    executors: { 'log-message': async (task) => { ran.push([task.fromSeq, task.toSeq]) } },
    status,
  })
  await work.enqueue({ kind: 'log-message', sessionId: 's1', fromSeq: 4, toSeq: 9, project: 'p' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await work.dispose()

  assert.deepEqual(ran, [[4, 9]], 'the other shelf\'s range was neither run nor absorbed')
  const pending = shelfTable(table, 'other').get('log-message:s1')
  assert.deepEqual([pending.fromSeq, pending.toSeq, pending.status], [0, 4, 'pending'])
})

/* --------------------------------------------------------------- listing -- */

test('parseShelfList reads names, paths with spaces, and connection state', () => {
  const stdout = [
    '  default  /Users/me/.hypatia/pgv  [connected]',
    '  work     /Volumes/My Drive/shelf  [disconnected]',
    '',
  ].join('\n')
  assert.deepEqual(parseShelfList(stdout), [
    { name: 'default', path: '/Users/me/.hypatia/pgv', connected: true },
    { name: 'work', path: '/Volumes/My Drive/shelf', connected: false },
  ])
  assert.deepEqual(parseShelfList('No shelves registered.\n'), [])
})

/* ------------------------------------------------------------- inventory -- */

function makeInventoryCtx() {
  const registered = []
  const disposed = []
  const effects = []
  const ctx = {
    plugin({ apply }) {
      const entry = { base: undefined }
      apply({
        settings: {
          register(ns, schema, options) {
            entry.ns = ns
            entry.base = options.base
          },
        },
      })
      registered.push(entry)
      return { dispose: async () => { disposed.push(entry) } }
    },
    effect(fn) {
      effects.push(fn())
    },
  }
  return { ctx, registered, disposed, stop: () => effects.forEach((dispose) => dispose()) }
}

test('the inventory republishes only when the listing changes', async () => {
  const { ctx, registered, disposed, stop } = makeInventoryCtx()
  let shelves = [{ name: 'default', path: '/a', connected: true }]
  const cli = { listShelves: async () => shelves }
  const inventory = publishShelfInventory({
    ctx, cli, status: makeStatus(), namespace: INVENTORY_NAMESPACE, schema: InventorySchema, label: 't', now: () => 42,
  })

  await inventory.refresh()
  assert.equal(registered.length, 1)
  assert.equal(registered[0].ns, INVENTORY_NAMESPACE)
  assert.deepEqual(registered[0].base, { shelves, error: '', listedAt: 42 })

  await inventory.refresh()
  assert.equal(registered.length, 1, 'an unchanged listing re-registers nothing')

  shelves = [...shelves, { name: 'work', path: '/b', connected: true }]
  await inventory.refresh()
  assert.equal(registered.length, 2)
  assert.deepEqual(disposed, [registered[0]], 'the old registration is released first')
  stop()
})

test('a failed listing keeps the last shelves and says why, once', async () => {
  const { ctx, registered, stop } = makeInventoryCtx()
  const status = makeStatus()
  let fail = false
  const cli = {
    listShelves: async () => {
      if (fail) throw new Error('hypatia exited 1')
      return [{ name: 'default', path: '/a', connected: true }]
    },
  }
  const inventory = publishShelfInventory({
    ctx, cli, status, namespace: INVENTORY_NAMESPACE, schema: InventorySchema, label: 't',
  })
  await inventory.refresh()
  fail = true
  const listing = await inventory.refresh()
  await inventory.refresh()
  assert.equal(listing.error, 'hypatia exited 1')
  assert.deepEqual(listing.shelves.map((s) => s.name), ['default'])
  assert.equal(registered.at(-1).base.error, 'hypatia exited 1')
  assert.equal(status.lines.filter(([level]) => level === 'warn').length, 1)
  stop()
})

test('a publish that fails is retried by the next poll, and never rejects', async () => {
  const status = makeStatus()
  let attempts = 0
  const ctx = {
    plugin({ apply }) {
      attempts += 1
      if (attempts === 1) throw new Error('INACTIVE_EFFECT')
      apply({ settings: { register() {} } })
      return { dispose: async () => {} }
    },
    effect: () => {},
  }
  const cli = { listShelves: async () => [{ name: 'default', path: '/a', connected: true }] }
  const inventory = publishShelfInventory({
    ctx, cli, status, namespace: INVENTORY_NAMESPACE, schema: InventorySchema, label: 't', intervalMs: 1e9,
  })
  const first = await inventory.refresh()
  assert.deepEqual(first.shelves.map((s) => s.name), ['default'], 'resolves with the listing')
  assert.equal(status.lines.filter(([level]) => level === 'warn').length, 1)
  await inventory.refresh()
  assert.equal(attempts, 2, 'the unchanged listing is published again after a failure')
  await inventory.refresh()
  assert.equal(attempts, 2, 'and not again once it landed')
})

test('a registration the settings service refuses is retried too', async () => {
  let registers = 0
  const ctx = {
    plugin({ apply }) {
      apply({ settings: { register() { registers += 1; if (registers === 1) throw new Error('already registered') } } })
      return { dispose: async () => {} }
    },
    effect: () => {},
  }
  const cli = { listShelves: async () => [] }
  const inventory = publishShelfInventory({
    ctx, cli, status: makeStatus(), namespace: INVENTORY_NAMESPACE, schema: InventorySchema, label: 't', intervalMs: 1e9,
  })
  await inventory.refresh()
  await inventory.refresh()
  await inventory.refresh()
  assert.equal(registers, 2)
})

test('a registration that keeps failing is logged once, not every poll', async () => {
  const status = makeStatus()
  const ctx = {
    plugin({ apply }) {
      apply({ settings: { register() { throw new Error('already registered') } } })
      return { dispose: async () => {} }
    },
    effect: () => {},
  }
  const inventory = publishShelfInventory({
    ctx, cli: { listShelves: async () => [] }, status, namespace: INVENTORY_NAMESPACE, schema: InventorySchema, label: 't', intervalMs: 1e9,
  })
  for (let i = 0; i < 4; i += 1) await inventory.refresh()
  assert.equal(status.lines.filter(([level]) => level === 'warn').length, 1)
})

/* ------------------------------------------------------------ cli + config -- */

function makeSubprocess(stdout = '') {
  const calls = []
  const ctx = {
    subprocess: {
      spawn({ argv }) {
        calls.push(argv)
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: {
            stdout: { readFrom: () => ({ text: stdout }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
        }
      },
    },
  }
  return { ctx, calls }
}

test('every CLI call goes to the configured shelf unless it names one', async () => {
  const { ctx, calls } = makeSubprocess('[]')
  const cli = createHypatiaCli(ctx, { binaries: ['hypatia'], shelf: 'work' })
  await cli.knowledgeCreate('a', { data: 'x' })
  await cli.statementCreate('a', 'is_a', 'b')
  await cli.knowledgeGet('a').catch(() => {})
  await cli.query('[]')
  await cli.search('q')
  await cli.similar('q')
  await cli.query('[]', { shelf: 'other' })
  const shelves = calls.map((argv) => argv[argv.indexOf('--shelf') + 1])
  assert.deepEqual(shelves, ['work', 'work', 'work', 'work', 'work', 'work', 'other'])
})

test('without a configured shelf the CLI keeps using default', async () => {
  const { ctx, calls } = makeSubprocess('[]')
  await createHypatiaCli(ctx, { binaries: ['hypatia'] }).query('[]')
  assert.equal(calls[0][calls[0].indexOf('--shelf') + 1], 'default')
})

test('listShelves runs hypatia list', async () => {
  const { ctx, calls } = makeSubprocess('  default  /a  [connected]\n')
  const shelves = await createHypatiaCli(ctx, { binaries: ['hypatia'] }).listShelves()
  assert.deepEqual(calls[0], ['hypatia', 'list'])
  assert.deepEqual(shelves, [{ name: 'default', path: '/a', connected: true }])
})

test('the shelf setting defaults to default and refuses blank or padded names', () => {
  assert.equal(SettingsSchema({}).shelf, 'default')
  assert.equal(DEFAULTS.shelf, 'default')
  let validate
  installConfig({
    settings: {
      installSection(owner, ns, schema, entry, hooks) {
        validate = hooks.validate
        hooks.setSource(() => entry)
      },
    },
  })
  const value = (shelf) => SettingsSchema({ shelf })
  assert.doesNotThrow(() => validate(value('work')))
  assert.throws(() => validate(value('')), /shelf/)
  assert.throws(() => validate(value(' work')), /shelf/)
  assert.throws(() => validate(value('my shelf')), /shelf/)
})

/* ---------------------------------------------------------------- recall -- */

function makeRecall({ shelf, preload = true, rows = [] }) {
  const injected = []
  let onStart
  const ctx = { on: (event, cb) => { if (event === 'agent/session-start') onStart = cb } }
  const recall = createRecall({
    ctx,
    cli: { query: async () => rows },
    shelf,
    getConfig: () => ({ enabled: true, recall: { enabled: true, preloadRulesTaboos: preload } }),
    status: makeStatus(),
    projectFor: async () => 'demo',
  })
  const agent = { session: {}, inject: (message) => injected.push(message) }
  return { recall, agent, injected, start: () => onStart({ agent }) }
}

const seedText = (message) => message.content.map((block) => block.text).join('')

test('the seed names a non-default shelf even with nothing to preload', async () => {
  const { recall, agent, injected } = makeRecall({ shelf: 'work', preload: false })
  await recall.preloadRulesAndTaboos(agent)
  assert.equal(injected.length, 1)
  assert.match(seedText(injected[0]), /--shelf work/)
})

test('the default shelf adds no line and no seed when there is nothing to load', async () => {
  const { recall, agent, injected } = makeRecall({ shelf: DEFAULT_SHELF })
  await recall.preloadRulesAndTaboos(agent)
  assert.equal(injected.length, 0)
})

test('rules still load alongside the shelf line', async () => {
  const rows = [{ name: 'no-main', content: { data: 'Never commit to main.' } }]
  const { recall, agent, injected } = makeRecall({ shelf: 'work', rows })
  await recall.preloadRulesAndTaboos(agent)
  const text = seedText(injected[0])
  assert.match(text, /--shelf work/)
  assert.match(text, /no-main/)
})
