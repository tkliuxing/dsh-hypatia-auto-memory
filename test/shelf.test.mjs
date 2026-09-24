/**
 * The configurable shelf: per-shelf progress and task rows, the `hypatia list`
 * parser, the inventory the settings card reads, the CLI's shelf routing, the
 * setting's validation, and the recall seed's shelf line.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_SHELF, parseShelfList, shelfTable } from '../src/shelf.js'
import { advanceProgress } from '../src/progress.js'
import { createQueue } from '../src/queue.js'
import { createHypatiaCli } from '../src/hypatia-cli.js'
import { createRecall } from '../src/recall.js'
import { Config, DEFAULTS, STARTUP_FIELDS, installConfig, sanitizeConfig, snapshotConfig } from '../src/config.js'
import { apply } from '../src/index.js'

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

/* ---------------------------------------------------------- live config -- */

/** A volatile reference double implementing the shared cosmokit protocol. */
function volatileOf(initial) {
  let current = initial
  return Object.freeze({
    get: () => current,
    [Symbol.for('cosmokit.volatile.write')]: (value) => { current = value },
    /** Test-only commit: what the Loader's volatile update would do. */
    commit: (value) => { current = value },
  })
}

function makeConfigCtx() {
  const listeners = new Map()
  return {
    ctx: { on: (event, cb) => listeners.set(event, cb) },
    emit: (event) => listeners.get(event)?.(),
  }
}

test('installConfig reads live and fires onChange on loader/volatile-update', () => {
  const { ctx, emit } = makeConfigCtx()
  const shelf = volatileOf('default')
  const handle = installConfig(ctx, { shelf, enabled: volatileOf(true) })
  assert.equal(handle.get().shelf, 'default')

  const seen = []
  handle.onChange((value) => seen.push(value.shelf))
  assert.deepEqual(seen, [], 'no replay on subscribe')
  shelf.commit('work')
  emit('loader/volatile-update')
  assert.deepEqual(seen, ['work'])
  assert.equal(handle.get().shelf, 'work')
})

test('installConfig hands onChange the same sanitized value get() returns, warning once per commit', () => {
  const { ctx, emit } = makeConfigCtx()
  const route = { provider: 'deepseek', model: 'deepseek-chat' }
  const consolidation = volatileOf({ models: [route, route] })
  const warnings = []
  const handle = installConfig(ctx, { consolidation }, (m) => warnings.push(m))
  assert.deepEqual(handle.get().consolidation.models, [route])
  assert.equal(handle.get(), handle.get(), 'cached between commits')
  handle.get()
  assert.equal(warnings.length, 1, 'reads do not repeat the warning')

  const seen = []
  handle.onChange((value) => seen.push(value))
  consolidation.commit({ models: [route, route, route] })
  emit('loader/volatile-update')
  assert.deepEqual(seen[0].consolidation.models, [route], 'listeners see the sanitized value')
  assert.equal(seen[0], handle.get())
  assert.equal(warnings.length, 2, 'a new commit reports again')
})

/** An entry-context double for `apply`: records mounted and disposed collectors. */
function makeEntryCtx() {
  const listeners = new Map()
  const effects = []
  const mounted = []
  const disposed = []
  const ctx = {
    on: (event, cb) => listeners.set(event, cb),
    effect: (fn) => { effects.push(fn()) },
    plugin: (options) => {
      const fiber = { options, dispose: async () => { disposed.push(fiber) } }
      mounted.push(fiber)
      return fiber
    },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  }
  return {
    ctx, mounted, disposed,
    emit: (event) => listeners.get(event)?.(),
    stop: () => effects.forEach((dispose) => dispose?.()),
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('a change to a startup field restarts the collector; other changes do not', async () => {
  assert.deepEqual(STARTUP_FIELDS, ['enabled', 'shelf', 'autoApprove'])
  const { ctx, mounted, disposed, emit, stop } = makeEntryCtx()
  const config = Config({})
  apply(ctx, config)
  await settle()
  assert.equal(mounted.length, 1, 'mounted once the Loader has settled')

  config.queue[Symbol.for('cosmokit.volatile.write')]({ ...config.queue.get(), concurrency: 2 })
  emit('loader/volatile-update')
  await settle()
  assert.equal(mounted.length, 1, 'a live field applies in place')

  config.shelf[Symbol.for('cosmokit.volatile.write')]('work')
  emit('loader/volatile-update')
  await settle()
  assert.equal(mounted.length, 2)
  assert.deepEqual(disposed, [mounted[0]], 'the old collector is disposed first')

  stop()
  config.enabled[Symbol.for('cosmokit.volatile.write')](false)
  emit('loader/volatile-update')
  await settle()
  assert.equal(mounted.length, 2, 'nothing is mounted once the entry is gone')
})

test('the collector waits for the Loader to settle before it mounts', async () => {
  const { ctx, mounted } = makeEntryCtx()
  let release
  ctx.root = { loader: { await: () => new Promise((resolve) => { release = resolve }) } }
  apply(ctx, Config({}))
  await settle()
  assert.equal(mounted.length, 0)
  release()
  await settle()
  assert.equal(mounted.length, 1)
})

test('sanitizeConfig drops blank and duplicate consolidation routes and says why', () => {
  const warnings = []
  const warn = (m) => warnings.push(m)
  const value = {
    consolidation: {
      models: [
        { provider: 'deepseek', model: 'deepseek-chat' },
        { provider: ' ', model: 'x' },
        { provider: 'deepseek', model: 'deepseek-chat' },
      ],
    },
  }
  const cleaned = sanitizeConfig(value, warn)
  assert.deepEqual(cleaned.consolidation.models, [{ provider: 'deepseek', model: 'deepseek-chat' }])
  assert.equal(warnings.length, 2)
  assert.equal(sanitizeConfig({ consolidation: { models: [] } }, warn).consolidation.models.length, 0)
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

test('the Config schema fills the documented defaults', () => {
  const value = snapshotConfig(Config({}))
  assert.equal(value.shelf, 'default')
  assert.equal(value.enabled, true)
  assert.equal(value.transport, 'mcp')
  assert.deepEqual(value.binaries, ['hypatia'])
  assert.equal(value.consolidation.cascade.batchSize, 16)
  assert.equal(DEFAULTS.shelf, 'default')
})

test('volatile fields parse to live references; snapshotConfig reads through them', () => {
  const parsed = Config({ shelf: 'work' })
  assert.equal(typeof parsed.shelf.get, 'function', 'a volatile field is a reference, not a value')
  assert.equal(snapshotConfig(parsed).shelf, 'work')
  // A Loader-style update commits into the same reference.
  parsed.shelf[Symbol.for('cosmokit.volatile.write')]('other')
  assert.equal(snapshotConfig(parsed).shelf, 'other')
})

test('a blank consolidation route is refused at parse time', () => {
  assert.doesNotThrow(() => Config({ consolidation: { models: [{ provider: 'deepseek', model: 'deepseek-chat' }] } }))
  assert.throws(() => Config({ consolidation: { models: [{ provider: ' ', model: 'x' }] } }))
  assert.throws(() => Config({ consolidation: { models: [{ provider: 'deepseek', model: '' }] } }))
})

test('the shelf setting refuses blank or padded names at parse time', () => {
  assert.doesNotThrow(() => Config({ shelf: 'work' }))
  assert.throws(() => Config({ shelf: '' }))
  assert.throws(() => Config({ shelf: ' work' }))
  assert.throws(() => Config({ shelf: 'my shelf' }))
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
