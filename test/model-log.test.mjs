import test from 'node:test'
import assert from 'node:assert/strict'

import { createModelLog, modelCallTable, openModelLog } from '../src/model-log.js'

/**
 * A table double that validates on the way in, the way the storage service
 * validates on the way out at the next startup (mirrors state-schema.test.mjs).
 * A record written here that would not load back is a startup failure deferred
 * to tomorrow.
 */
function strictTable(spec) {
  const map = new Map()
  const violations = []
  const check = (key, value) => {
    const result = spec.valueSchema.safeParse(value)
    if (!result.success) violations.push({ key, issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
  }
  return {
    violations,
    map,
    get size() { return map.size },
    get: (key) => map.get(key),
    entries: () => map.entries(),
    put: (key, value) => { check(key, value); map.set(key, value); return Promise.resolve() },
    delete: (key) => Promise.resolve(map.delete(key)),
  }
}

function recorder() {
  const lines = []
  return {
    lines,
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
    count: () => {},
  }
}

const LUNA = { provider: 'openai', model: 'gpt-5.6-luna' }
const FLASH = { provider: 'deepseek-official', model: 'deepseek-flash' }

test('an attempt is recorded at selection and settled when it finishes', async () => {
  const table = strictTable(modelCallTable)
  let clock = 1000
  const log = createModelLog({ table, status: recorder(), now: () => clock })

  const attempt = log.begin('memory-consolidation', LUNA)
  assert.equal(attempt.seq, 1)
  // Durable before the call runs, so an attempt that never settles — a killed
  // process — still leaves evidence of which model it was on.
  assert.equal(table.get('000000000001').outcome, 'pending')

  clock = 4210
  await attempt.finish('ok')
  const stored = table.get('000000000001')
  assert.equal(stored.outcome, 'ok')
  assert.equal(stored.ms, 3210)
  assert.equal(stored.provider, 'openai')
  assert.equal(stored.model, 'gpt-5.6-luna')
  assert.equal(stored.purpose, 'memory-consolidation')
  assert.deepEqual(table.violations, [])
})

test('recent() answers newest-first, which is the question asked of it', async () => {
  const table = strictTable(modelCallTable)
  const log = createModelLog({ table, status: recorder(), now: () => 0 })

  await log.begin('memory-consolidation', LUNA).finish('ok')
  await log.begin('memory-adjudication', FLASH).finish('error', 'model route down')
  await log.begin('memory-cascade', LUNA).finish('incomplete', 'max-tokens')

  assert.deepEqual(log.recent().map((row) => [row.seq, row.purpose, row.model, row.outcome]), [
    [3, 'memory-cascade', 'gpt-5.6-luna', 'incomplete'],
    [2, 'memory-adjudication', 'deepseek-flash', 'error'],
    [1, 'memory-consolidation', 'gpt-5.6-luna', 'ok'],
  ])
  assert.equal(log.recent(1).length, 1)
  assert.deepEqual(table.violations, [])
})

test('the ring stays bounded, dropping the oldest attempt', async () => {
  const table = strictTable(modelCallTable)
  const log = createModelLog({ table, status: recorder(), limit: 3, now: () => 0 })

  for (let i = 1; i <= 5; i += 1) {
    await log.begin('memory-consolidation', i % 2 === 0 ? FLASH : LUNA).finish('ok')
  }

  assert.equal(table.size, 3)
  assert.deepEqual(log.recent().map((row) => row.seq), [5, 4, 3])
})

test('the sequence resumes from the stored rows after a restart', async () => {
  const table = strictTable(modelCallTable)
  const first = createModelLog({ table, status: recorder(), now: () => 0 })
  await first.begin('memory-consolidation', LUNA).finish('ok')
  await first.begin('memory-consolidation', FLASH).finish('ok')

  const restarted = createModelLog({ table, status: recorder(), now: () => 0 })
  const next = restarted.begin('memory-consolidation', LUNA)
  assert.equal(next.seq, 3)
  await next.finish('ok')
})

test('a settle logs one line naming the purpose, route and outcome', async () => {
  const status = recorder()
  const log = createModelLog({ table: strictTable(modelCallTable), status, now: () => 0 })

  await log.begin('memory-consolidation', LUNA).finish('ok')
  await log.begin('memory-cascade', FLASH).finish('error', 'socket hang up')

  assert.deepEqual(status.lines, [
    'model call: memory-consolidation openai/gpt-5.6-luna ok 0ms',
    'model call: memory-cascade deepseek-official/deepseek-flash error 0ms (socket hang up)',
  ])
})

test('a storage domain that will not open costs the history, not the pipeline', async () => {
  const status = recorder()
  const { modelLog, domain } = await openModelLog({
    storageDomain: { open: () => Promise.reject(new Error('version-mismatch')) },
  }, { status })

  // The call sites keep the same shape: an attempt is still taken and closed,
  // and the failure is said out loud rather than swallowed.
  await modelLog.begin('memory-consolidation', LUNA).finish('ok')
  assert.deepEqual(modelLog.recent(), [])
  assert.equal(domain, undefined)
  assert.equal(status.lines.length, 2)
  assert.match(status.lines[0], /model-call log unavailable/)
  assert.match(status.lines[1], /openai\/gpt-5\.6-luna ok/)
})

test('a successful open hands back the log and the handle to close', async () => {
  const status = recorder()
  const table = strictTable(modelCallTable)
  let disposer
  const { modelLog, domain } = await openModelLog({
    storageDomain: { open: async () => ({ table: () => table, close: async () => {} }) },
    effect: (fn) => { disposer = fn() },
  }, { status, now: () => 0 })

  assert.notEqual(domain, undefined)
  assert.equal(typeof disposer, 'function', 'teardown closes the domain')
  await modelLog.begin('memory-consolidation', LUNA).finish('ok')
  assert.equal(modelLog.recent().length, 1)
  assert.deepEqual(status.lines, ['model call: memory-consolidation openai/gpt-5.6-luna ok 0ms'])
})

test('a domain whose disposer cannot be registered is closed, not leaked', async () => {
  // The fiber went away while the domain was opening, so nothing will ever run
  // its disposer; this is the one path that can leak the handle.
  let closed = false
  const status = recorder()
  const { modelLog, domain } = await openModelLog({
    storageDomain: { open: async () => ({ table: () => strictTable(modelCallTable), close: async () => { closed = true } }) },
    effect: () => { throw new Error('fiber is disposed') },
  }, { status })

  assert.equal(closed, true)
  assert.equal(domain, undefined)
  assert.deepEqual(modelLog.recent(), [])
  assert.deepEqual(status.lines, [], 'a teardown race is not a failure to report')
})

test('detail is capped, so a provider body cannot reach the table whole', async () => {
  const table = strictTable(modelCallTable)
  const status = recorder()
  const log = createModelLog({ table, status, now: () => 0 })

  await log.begin('memory-cascade', FLASH).finish('error', `HTTP 500: ${'x'.repeat(5000)}`)

  const stored = table.get('000000000001')
  assert.equal(stored.detail.length, 200)
  assert.ok(status.lines[0].length < 400, status.lines[0])
  assert.deepEqual(table.violations, [])
})

test('a log built without a table still records nothing and says nothing false', async () => {
  const status = recorder()
  const log = createModelLog({ status, now: () => 0 })

  const attempt = log.begin('memory-consolidation', LUNA)
  await attempt.finish('ok')
  assert.deepEqual(log.recent(), [])
  assert.deepEqual(status.lines, ['model call: memory-consolidation openai/gpt-5.6-luna ok 0ms'])
})
