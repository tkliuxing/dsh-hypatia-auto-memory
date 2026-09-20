/**
 * Contract tests of the MCP transport against a REAL `hypatia mcp`, on shelves
 * created and destroyed per run.
 *
 * hypatia-mcp.js maps tool results onto the CLI client's interface. These
 * tests check that mapping against the installed binary: the error texts it
 * keys on, and that an entry or a result set is the same whichever transport
 * produced it.
 *
 * Skipped when `hypatia` is not on PATH or has no `mcp` subcommand. Run with
 * `npm run test:integration`.
 *
 * SAFETY: every client is built with `shelf` pinned to a throwaway shelf, and
 * every CLI call goes through `hyp()`, which pins `--shelf` the same way. The
 * developer's `default` shelf holds real memories.
 *
 * The integration files run one at a time (`--test-concurrency=1`): each
 * connects and disconnects shelves, and hypatia rewrites its registry whole,
 * so two files doing it at once lose each other's shelves.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHypatiaClient } from '../../src/hypatia-client.js'
import { createWriter } from '../../src/writer.js'

const hasMcp = spawnSync('hypatia', ['mcp', '--help'], { encoding: 'utf8' }).status === 0
const options = hasMcp ? {} : { skip: 'hypatia with an `mcp` subcommand not on PATH' }

/**
 * The part of DSH's subprocess service the clients use, on node:child_process:
 * `pipe`, `ignore` and collect-mode streams, `done`, `terminate`.
 */
function nodeSubprocess() {
  return {
    spawn(spec) {
      const mode = (value) => (value === 'ignore' ? 'ignore' : 'pipe')
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        stdio: [mode(spec.stdio.stdin), mode(spec.stdio.stdout), mode(spec.stdio.stderr)],
      })
      const collected = {}
      for (const name of ['stdout', 'stderr']) {
        if (typeof spec.stdio[name] !== 'object') continue
        let text = ''
        child[name].setEncoding('utf8').on('data', (chunk) => { text += chunk })
        collected[name] = { readFrom: () => ({ text }) }
      }
      const done = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
      })
      spec.signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
      return {
        pid: child.pid ?? -1,
        stdin: spec.stdio.stdin === 'pipe' ? child.stdin : undefined,
        stdout: spec.stdio.stdout === 'pipe' ? child.stdout : undefined,
        stderr: spec.stdio.stderr === 'pipe' ? child.stderr : undefined,
        collected,
        done,
        terminate: () => child.kill('SIGTERM'),
        waitForExit: () => done.then(() => true),
      }
    },
  }
}

function connectThrowaway(t, label) {
  const dir = mkdtempSync(join(tmpdir(), 'hypatia-mcp-it-'))
  const name = `dsh-auto-memory-mcp-${label}-${process.pid}`
  execFileSync('hypatia', ['connect', dir, '-n', name], { stdio: 'ignore' })
  t.after(() => {
    spawnSync('hypatia', ['disconnect', name], { stdio: 'ignore' })
    rmSync(dir, { recursive: true, force: true })
  })
  return name
}

function clientFor(t, shelf, transport = 'mcp') {
  const warnings = []
  const client = createHypatiaClient({ subprocess: nodeSubprocess() }, { binaries: ['hypatia'], transport, shelf }, {
    status: { warn: (message) => warnings.push(message), info: () => {} },
  })
  t.after(() => client.dispose())
  return { client, warnings }
}

test('hypatia mcp contracts the MCP transport relies on', options, async (t) => {
  const shelf = connectThrowaway(t, 'main')
  const { client: mcp, warnings } = clientFor(t, shelf)
  const { client: cli } = clientFor(t, shelf, 'cli')
  /** One CLI call, always pinned to the throwaway shelf. */
  const hyp = (argv) => spawnSync('hypatia', [...argv, '--shelf', shelf], { encoding: 'utf8' })
  const stored = (name) => JSON.parse(hyp(['knowledge-get', name]).stdout).content

  await t.test('the handshake succeeds and every required tool is served', async () => {
    assert.deepEqual(await mcp.knowledgeGet('definitely-absent'), { found: false })
    assert.equal(mcp.transport(), 'mcp')
    assert.deepEqual(warnings, [])
  })

  await t.test('creates are replayable: a repeat is false, never an error', async () => {
    assert.equal(await mcp.knowledgeCreate('m-plain', { data: '- a bullet', tags: ['message'], scopes: ['proj'] }), true)
    assert.equal(await mcp.knowledgeCreate('m-plain', { data: 'other' }), false)
    assert.equal(stored('m-plain').data, '- a bullet', 'the repeat left the entry alone')
    assert.equal(await mcp.statementCreate('m-plain', 'belongTo', 'session-x', { scopes: ['proj'] }), true)
    assert.equal(await mcp.statementCreate('m-plain', 'belongTo', 'session-x', { scopes: ['proj'] }), false)
  })

  await t.test('an entry is stored the same whichever transport wrote it', async () => {
    const entry = { data: '- s1', tags: ['summary', 'summary 1'], scopes: ['proj', ''] }
    await mcp.knowledgeCreate('via-mcp', entry)
    await cli.knowledgeCreate('via-cli', entry)
    const a = stored('via-mcp')
    const b = stored('via-cli')
    for (const field of ['data', 'tags', 'scopes', 'synonyms', 'figures']) {
      assert.deepEqual(a[field], b[field], field)
    }
    assert.deepEqual(a.scopes, ['proj', ''])
    // The lists the two transports would otherwise disagree on: one scope, an
    // empty one (`--scopes ""`), one with a comma.
    const cases = { one: ['proj'], empty: [''], comma: ['a,b'] }
    for (const [label, scopes] of Object.entries(cases)) {
      await mcp.knowledgeCreate(`scope-${label}-mcp`, { data: 'x', scopes })
      await cli.knowledgeCreate(`scope-${label}-cli`, { data: 'x', scopes })
      assert.deepEqual(stored(`scope-${label}-mcp`).scopes, stored(`scope-${label}-cli`).scopes, label)
    }
  })

  await t.test('a lone surrogate is stored as the CLI stores it', async () => {
    const cut = `- ${'😀😀'.slice(0, 3)}`
    assert.equal(await mcp.knowledgeCreate('lone-mcp', { data: cut }), true)
    await cli.knowledgeCreate('lone-cli', { data: cut })
    assert.equal(stored('lone-mcp').data, stored('lone-cli').data)
    assert.equal(stored('lone-mcp').data, '- 😀�')
  })

  await t.test('knowledgeGet returns what the CLI returns', async () => {
    assert.deepEqual(await mcp.knowledgeGet('via-mcp'), await cli.knowledgeGet('via-mcp'))
  })

  await t.test('query and search rows match the CLI row for row', async () => {
    const jse = JSON.stringify({ '$not-summaried': ['message', ['$contains', 'scopes', 'proj']], limit: 16 })
    const viaMcp = await mcp.query(jse)
    assert.ok(viaMcp.length > 0)
    assert.deepEqual(viaMcp, await cli.query(jse))
    const search = await mcp.search('bullet', { catalog: 'knowledge', limit: 5 })
    assert.ok(search.length > 0)
    assert.deepEqual(search, await cli.search('bullet', { catalog: 'knowledge', limit: 5 }))
    assert.deepEqual(await mcp.search('zzzznomatchzzzz'), [])
  })

  await t.test('content past the CLI argv ceiling is stored whole', async () => {
    const big = `- ${'长'.repeat(60_000)}` // 180 KB of UTF-8
    await mcp.knowledgeCreate('big', { data: big })
    assert.equal(stored('big').data, big)
  })

  await t.test('similar without an embedding model fails the call cleanly', async () => {
    await assert.rejects(mcp.similar('bullet'), { code: 'TOOL_ERROR' })
    // The process survives a tool error.
    assert.deepEqual(await mcp.knowledgeGet('definitely-absent'), { found: false })
  })

  await t.test('the writer runs end to end over MCP', async () => {
    const writer = createWriter(mcp, { status: { warn: () => {}, info: () => {}, count: () => {} } })
    await writer.writeMessage({ sessionId: 'it', index: 1, markdown: '**User**: hi', project: 'proj' })
    await writer.writeMessage({ sessionId: 'it', index: 1, markdown: '**User**: hi', project: 'proj' })
    const entry = await mcp.knowledgeGet('msg-it-1')
    assert.equal(entry.found, true)
    assert.deepEqual(entry.content.tags, ['message'])
  })
})

test('a shelf connected after the server started is reached on the retry', options, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hypatia-mcp-it-'))
  const late = `dsh-auto-memory-mcp-late-${process.pid}`
  t.after(() => {
    spawnSync('hypatia', ['disconnect', late], { stdio: 'ignore' })
    rmSync(dir, { recursive: true, force: true })
  })
  const { client } = clientFor(t, late)
  await assert.rejects(client.knowledgeGet('x'), { code: 'TOOL_ERROR', message: /is not connected/ })
  execFileSync('hypatia', ['connect', dir, '-n', late], { stdio: 'ignore' })
  assert.deepEqual(await client.knowledgeGet('x'), { found: false })
})
