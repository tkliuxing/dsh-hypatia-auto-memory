/**
 * The staged card form behind the browser settings card: what a draft shows
 * before it is written, which atomic mutation a save reaches, and what
 * happens to drafts the Host did not accept. Mirrors the official
 * ui-settings-plugins CardForm specs, extended for nested paths, booleans,
 * one-mutate saves, and the cross-field route rule.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CardForm, booleanField, numberField, textField, readPath, hasPath,
} from '../src/client/card-form.ts'

const BASE = {
  enabled: true,
  consolidation: { enabled: true, provider: '', model: '', checkEveryTurns: 5, minNewTokens: 3000 },
  recall: { preloadRulesTaboos: true, maxEntries: 5 },
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Host-side layering: plain objects merge recursively, everything else replaces. */
function mergeLayers(under, over) {
  if (!isPlainObject(under) || !isPlainObject(over)) return over === undefined ? under : over
  const merged = { ...under }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = key in merged ? mergeLayers(merged[key], value) : value
  }
  return merged
}

/** Host-side path op application (packages/settings applyPathOp). */
function applyPathOp(section, op) {
  const [head, ...rest] = op.path
  if (head === undefined) return op.op === 'unset' ? {} : { ...op.value }
  if (rest.length === 0) {
    if (op.op === 'set') return { ...section, [head]: op.value }
    const { [head]: _removed, ...kept } = section
    return kept
  }
  const child = section[head]
  if (!isPlainObject(child)) {
    if (op.op === 'unset') return section
    return { ...section, [head]: applyPathOp({}, { ...op, path: rest }) }
  }
  return { ...section, [head]: applyPathOp(child, { ...op, path: rest }) }
}

/**
 * A scripted settings scope. `mutations` records every mutate call; by default
 * the Host accepts writes (applies the ops to the user layer and re-resolves
 * the value over BASE). `refuse` makes it refuse silently, exactly like a
 * validator that rejects the value; `throwOnMutate` rejects the promise.
 */
function stubScope(overrides = {}) {
  let snapshot = {
    status: 'ready',
    writable: true,
    value: structuredClone(BASE),
    base: structuredClone(BASE),
    user: {},
    ...overrides,
  }
  const listeners = new Set()
  const mutations = []
  const host = { refuse: false, throwOnMutate: false }
  const scope = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async mutate(ops) {
      mutations.push(structuredClone(ops))
      if (host.throwOnMutate) throw new Error('transport down')
      if (host.refuse) return
      const user = ops.reduce(applyPathOp, snapshot.user ?? {})
      publish({ user, value: mergeLayers(structuredClone(snapshot.base), user) })
    },
  }
  function publish(patch) {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  return { scope, publish, mutations, host }
}

function form(overrides, options) {
  const stub = stubScope(overrides)
  const subject = new CardForm(stub.scope, [
    booleanField('enabled', ['enabled']),
    textField('provider', ['consolidation', 'provider']),
    textField('model', ['consolidation', 'model']),
    numberField('checkEveryTurns', ['consolidation', 'checkEveryTurns'], { integer: true, min: 1 }),
    numberField('minNewTokens', ['consolidation', 'minNewTokens'], { integer: true, min: 500 }),
    booleanField('preloadRulesTaboos', ['recall', 'preloadRulesTaboos']),
  ], options)
  return { ...stub, subject }
}

test('path helpers read own properties only', () => {
  assert.equal(readPath({ a: { b: 1 } }, ['a', 'b']), 1)
  assert.equal(readPath({ a: { b: 1 } }, ['a', 'c']), undefined)
  assert.equal(readPath({ a: 1 }, ['a', 'b']), undefined)
  assert.equal(hasPath({ a: { b: undefined } }, ['a', 'b']), true)
  assert.equal(hasPath({}, ['toString']), false)
  assert.equal(hasPath(undefined, ['a']), false)
})

test('shows the effective nested value and stays clean until something is staged', () => {
  const { subject } = form()
  assert.deepEqual(subject.field('checkEveryTurns'), { text: '5', overridden: false, invalid: false })
  assert.deepEqual(subject.field('provider'), { text: '', overridden: false, invalid: false })
  assert.deepEqual(subject.field('enabled'), { text: 'true', overridden: false, invalid: false })
  const shell = subject.shell()
  assert.equal(shell.available, true)
  assert.equal(shell.writable, true)
  assert.equal(shell.dirty, false)
  assert.equal(shell.invalid, false)
})

test('reports unavailable while the namespace is not ready', () => {
  const { subject } = form({ status: 'loading', value: undefined, base: undefined, user: undefined })
  assert.equal(subject.shell().available, false)
  assert.deepEqual(subject.field('provider'), { text: '', overridden: false, invalid: false })
})

test('marks a field the user layer carries as overridden, by presence at its path', () => {
  const { subject, publish } = form()
  // An override equal to the composition default is still an override.
  publish({ user: { consolidation: { checkEveryTurns: 5 } } })
  assert.equal(subject.field('checkEveryTurns').overridden, true)
  assert.equal(subject.field('minNewTokens').overridden, false)
})

test('writes nothing until the form is saved, then one atomic mutation', async () => {
  const { subject, mutations } = form()
  subject.actions().edit('checkEveryTurns', '9')
  subject.actions().edit('provider', 'openai')
  subject.actions().edit('model', 'gpt-4o-mini')
  assert.deepEqual(subject.field('checkEveryTurns'), { text: '9', overridden: true, invalid: false })
  assert.equal(subject.shell().dirty, true)
  assert.equal(mutations.length, 0)

  await subject.save()

  assert.equal(mutations.length, 1)
  assert.deepEqual(mutations[0], [
    { op: 'set', path: ['consolidation', 'checkEveryTurns'], value: 9 },
    { op: 'set', path: ['consolidation', 'provider'], value: 'openai' },
    { op: 'set', path: ['consolidation', 'model'], value: 'gpt-4o-mini' },
  ])
  const shell = subject.shell()
  assert.equal(shell.dirty, false)
  assert.equal(shell.failed, false)
  assert.equal(shell.saving, false)
  assert.deepEqual(subject.field('provider'), { text: 'openai', overridden: true, invalid: false })
})

test('drops a draft that settles back on the value already shown', async () => {
  const { subject, mutations } = form()
  subject.actions().edit('checkEveryTurns', '9')
  subject.actions().edit('checkEveryTurns', '5')
  assert.equal(subject.shell().dirty, false)
  await subject.save()
  assert.equal(mutations.length, 0)
})

test('refuses to save while a draft is not a value the field accepts', async () => {
  const { subject, mutations } = form()
  subject.actions().edit('checkEveryTurns', 'soon')
  assert.deepEqual(subject.field('checkEveryTurns'), { text: 'soon', overridden: false, invalid: true })
  assert.equal(subject.shell().dirty, true)
  assert.equal(subject.shell().invalid, true)
  await subject.save()
  assert.equal(mutations.length, 0)
  assert.equal(subject.field('checkEveryTurns').text, 'soon')
})

test('enforces integer and minimum bounds on number fields', () => {
  const { subject } = form()
  subject.actions().edit('checkEveryTurns', '2.5')
  assert.equal(subject.field('checkEveryTurns').invalid, true)
  subject.actions().edit('checkEveryTurns', '0')
  assert.equal(subject.field('checkEveryTurns').invalid, true)
  subject.actions().edit('minNewTokens', '499')
  assert.equal(subject.field('minNewTokens').invalid, true)
  subject.actions().edit('minNewTokens', ' 500 ')
  assert.equal(subject.field('minNewTokens').invalid, false)
})

test('stages a reset that clears the nested field only once saved', async () => {
  const { subject, publish, mutations } = form()
  publish({
    user: { consolidation: { checkEveryTurns: 9 } },
    value: mergeLayers(structuredClone(BASE), { consolidation: { checkEveryTurns: 9 } }),
  })
  subject.actions().resetField('checkEveryTurns')
  // The badge previews the save: the field will no longer be overridden.
  assert.deepEqual(subject.field('checkEveryTurns'), { text: '5', overridden: false, invalid: false })
  assert.equal(mutations.length, 0)

  await subject.save()

  assert.deepEqual(mutations, [[{ op: 'unset', path: ['consolidation', 'checkEveryTurns'] }]])
  assert.equal(subject.shell().dirty, false)
  assert.equal(subject.shell().failed, false)
  assert.equal(subject.field('checkEveryTurns').overridden, false)
})

test('treats resetting an inherited field as no change at all', async () => {
  const { subject, mutations } = form()
  subject.actions().resetField('checkEveryTurns')
  assert.equal(subject.shell().dirty, false)
  await subject.save()
  assert.equal(mutations.length, 0)
})

test('clears a number field by emptying it', async () => {
  const { subject, publish, mutations } = form()
  publish({ user: { consolidation: { checkEveryTurns: 9 } } })
  subject.actions().edit('checkEveryTurns', '')
  assert.deepEqual(subject.field('checkEveryTurns'), { text: '', overridden: false, invalid: false })
  await subject.save()
  assert.deepEqual(mutations, [[{ op: 'unset', path: ['consolidation', 'checkEveryTurns'] }]])
})

test('clears a text field by emptying it, and writes trimmed text otherwise', async () => {
  const { subject, publish, mutations } = form()
  publish({
    user: { consolidation: { provider: 'openai', model: 'x' } },
    value: mergeLayers(structuredClone(BASE), { consolidation: { provider: 'openai', model: 'x' } }),
  })
  subject.actions().edit('provider', '   ')
  subject.actions().edit('model', '  ')
  await subject.save()
  assert.deepEqual(mutations, [[
    { op: 'unset', path: ['consolidation', 'provider'] },
    { op: 'unset', path: ['consolidation', 'model'] },
  ]])
  subject.actions().edit('provider', '  openai  ')
  subject.actions().edit('model', '  gpt  ')
  await subject.save()
  assert.deepEqual(mutations[1], [
    { op: 'set', path: ['consolidation', 'provider'], value: 'openai' },
    { op: 'set', path: ['consolidation', 'model'], value: 'gpt' },
  ])
})

test('toggles a boolean field and formats it as a switch state', async () => {
  const { subject, mutations } = form()
  subject.actions().toggle('enabled')
  assert.deepEqual(subject.field('enabled'), { text: 'false', overridden: true, invalid: false })
  assert.equal(subject.effective('enabled'), false)
  subject.actions().toggle('enabled')
  assert.equal(subject.shell().dirty, false)
  subject.actions().toggle('preloadRulesTaboos')
  await subject.save()
  assert.deepEqual(mutations, [[{ op: 'set', path: ['recall', 'preloadRulesTaboos'], value: false }]])
  assert.equal(subject.field('preloadRulesTaboos').overridden, true)
})

test('a form-wide rule over effective values marks the form invalid and blocks the save', async () => {
  const violates = read => read('provider') !== undefined && ((read('provider') === '') !== (read('model') === ''))
  const { subject, mutations } = form(undefined, { violates })
  subject.actions().edit('provider', 'openai')
  assert.equal(subject.shell().dirty, true)
  assert.equal(subject.shell().invalid, true)
  await subject.save()
  assert.equal(mutations.length, 0)
  subject.actions().edit('model', 'gpt')
  assert.equal(subject.shell().invalid, false)
  await subject.save()
  assert.equal(mutations.length, 1)
})

test('keeps the drafts a save did not land, and reports the failure', async () => {
  const { subject, host, mutations } = form()
  host.refuse = true
  subject.actions().edit('checkEveryTurns', '9')
  await subject.save()
  assert.equal(mutations.length, 1)
  const shell = subject.shell()
  assert.equal(shell.dirty, true)
  assert.equal(shell.failed, true)
  assert.equal(shell.saving, false)
  assert.equal(subject.field('checkEveryTurns').text, '9')
})

test('reports a reset the Host did not apply as a failure', async () => {
  const { subject, publish, host } = form()
  publish({ user: { consolidation: { checkEveryTurns: 9 } } })
  host.refuse = true
  subject.actions().resetField('checkEveryTurns')
  await subject.save()
  assert.equal(subject.shell().failed, true)
})

test('treats a transport failure as a save that did not land', async () => {
  const { subject, host } = form()
  host.throwOnMutate = true
  subject.actions().edit('checkEveryTurns', '9')
  await subject.save()
  assert.equal(subject.shell().failed, true)
  assert.equal(subject.shell().saving, false)
  assert.equal(subject.field('checkEveryTurns').text, '9')
})

test('clears the failure as soon as the user edits again', async () => {
  const { subject, host } = form()
  host.refuse = true
  subject.actions().edit('checkEveryTurns', '9')
  await subject.save()
  assert.equal(subject.shell().failed, true)
  subject.actions().edit('checkEveryTurns', '10')
  assert.equal(subject.shell().failed, false)
})

test('discards every staged edit and the last failure', async () => {
  const { subject, host } = form()
  host.refuse = true
  subject.actions().edit('checkEveryTurns', '9')
  subject.actions().toggle('enabled')
  await subject.save()
  subject.actions().discard()
  assert.equal(subject.shell().dirty, false)
  assert.equal(subject.shell().failed, false)
  assert.equal(subject.field('checkEveryTurns').text, '5')
  assert.equal(subject.field('enabled').text, 'true')
})

test('publishes to subscribers on staged edits and scope changes', () => {
  const { subject, publish } = form()
  let calls = 0
  const off = subject.subscribe(() => { calls += 1 })
  subject.actions().edit('checkEveryTurns', '9')
  publish({ writable: false })
  off()
  publish({ writable: true })
  assert.equal(calls, 2)
})

test('ignores a save while one is already crossing the wire', async () => {
  const { subject, mutations, scope } = form()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const original = scope.mutate
  scope.mutate = async (ops) => { await gate; return original(ops) }
  subject.actions().edit('checkEveryTurns', '9')
  const first = subject.save()
  assert.equal(subject.shell().saving, true)
  await subject.save()
  release()
  await first
  assert.equal(mutations.length, 1)
  assert.equal(subject.shell().saving, false)
})

test('names an undeclared field loudly instead of rendering an inert control', () => {
  const { subject } = form()
  assert.throws(() => subject.field('nope'), /has no field nope/)
})
