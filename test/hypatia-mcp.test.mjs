import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'

import { REQUIRED_TOOLS, createHypatiaMcp, createMcpConnection } from '../src/hypatia-mcp.js'
import { createHypatiaClient } from '../src/hypatia-client.js'

const ok = (structured) => ({
  content: [{ type: 'text', text: JSON.stringify(structured) }],
  structuredContent: structured,
  isError: false,
})
const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true })

/**
 * A subprocess service whose `hypatia mcp` is an in-process fake speaking
 * line-delimited JSON-RPC, and whose other argv are CLI calls printing
 * `cliStdout`.
 *
 * `onCall(name, args, proc)` returns a tool result, or a word for how to
 * misbehave: `'hang'` never answers, `'exit'` dies mid-call, `'parse-error'`
 * answers as hypatia does a line it cannot parse (id null), `'stdout-error'`
 * breaks the stdout stream. `proc.writeStderr(text)` adds to stderr. Replies
 * arrive `replyDelayMs` after the request.
 *
 * `mode` shapes the process as a whole: `'old-binary'` exits 2 with clap's
 * usage error, `'crash-on-start'` exits 1, `'slow-start'` answers `initialize`
 * after `handshakeDelayMs`, `'spawn-fails'` rejects `done`.
 */
function fakeSubprocess({
  onCall = () => ok({}),
  tools = REQUIRED_TOOLS,
  mode = 'ok',
  cliStdout = '',
  replyDelayMs = 0,
  handshakeDelayMs = 0,
} = {}) {
  const servers = []
  const cliCalls = []
  const ctx = {
    subprocess: {
      spawn(spec) {
        if (spec.argv[1] !== 'mcp') {
          cliCalls.push(spec.argv)
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }),
            collected: {
              stdout: { readFrom: () => ({ text: cliStdout }) },
              stderr: { readFrom: () => ({ text: '' }) },
            },
          }
        }
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        let stderr = ''
        let settle
        const done = new Promise((resolve, reject) => { settle = { resolve, reject } })
        const proc = {
          spec,
          calls: [],
          /** Requests received and not yet answered, and the most there ever were. */
          outstanding: 0,
          maxOutstanding: 0,
          exited: false,
          terminated: false,
          /** The client ended our stdin — what a graceful close does. */
          get stdinEnded() { return stdin.writableEnded },
          writeStderr(text) { stderr += text },
        }
        const exit = (exitCode, signal = null) => {
          if (proc.exited) return
          proc.exited = true
          stdout.end()
          settle.resolve({ exitCode, signal })
        }
        const reply = (message, delayMs = replyDelayMs) => {
          proc.outstanding += 1
          proc.maxOutstanding = Math.max(proc.maxOutstanding, proc.outstanding)
          setTimeout(() => {
            proc.outstanding -= 1
            if (!proc.exited) stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
          }, delayMs)
        }
        stdin.on('end', () => exit(0))
        if (mode === 'old-binary' || mode === 'crash-on-start') {
          stderr = mode === 'old-binary'
            ? "error: unrecognized subcommand 'mcp'\n\nUsage: hypatia [COMMAND]"
            : 'Error: registry file is corrupt'
          setImmediate(() => exit(mode === 'old-binary' ? 2 : 1))
        } else if (mode === 'spawn-fails') {
          setImmediate(() => {
            proc.exited = true
            settle.reject(Object.assign(new Error('spawn hypatia ENOENT'), { code: 'ENOENT' }))
          })
        } else {
          createInterface({ input: stdin }).on('line', (line) => {
            proc.lastLine = line
            const message = JSON.parse(line)
            if (message.id === undefined) return
            if (message.method === 'initialize') {
              if (mode === 'hang-on-start') return
              const delay = mode === 'slow-start' ? handshakeDelayMs : replyDelayMs
              reply({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: {} } }, delay)
            } else if (message.method === 'tools/list') {
              reply({ id: message.id, result: { tools: tools.map((name) => ({ name })) } })
            } else if (message.method === 'tools/call') {
              const { name, arguments: args } = message.params
              proc.calls.push({ name, args })
              const outcome = onCall(name, args, proc)
              if (outcome === 'hang') return
              if (outcome === 'exit') {
                proc.writeStderr('thread main panicked')
                exit(101)
              } else if (outcome === 'parse-error') {
                reply({ id: null, error: { code: -32700, message: 'parse error: unexpected end of hex escape' } })
              } else if (outcome === 'stdout-error') {
                stdout.destroy(new Error('stream broke'))
              } else {
                reply({ id: message.id, result: outcome })
              }
            } else {
              reply({ id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
            }
          })
        }
        servers.push(proc)
        return {
          pid: 4242,
          stdin,
          stdout,
          stderr: undefined,
          collected: {
            stderr: { readFrom: (from = 0) => ({ text: stderr.slice(from), nextOffset: stderr.length }) },
          },
          done,
          terminate() {
            proc.terminated = true
            exit(null, 'SIGTERM')
          },
          waitForExit: async () => true,
        }
      },
    },
  }
  return { ctx, servers, cliCalls }
}

/** An MCP-backed client over the fake, with the connection options a test needs. */
function mcpClient(fake, { shelf, ...options } = {}) {
  const connection = createMcpConnection(fake.ctx, { binary: () => 'hypatia', ...options })
  return { connection, client: createHypatiaMcp(connection, { shelf }) }
}

test('one process serves consecutive calls, and the shelf is always named', async (t) => {
  const fake = fakeSubprocess({
    onCall: (name) => (name === 'knowledge_get'
      ? ok({ name: 'msg-s-1', content: { data: 'hi' }, created_at: 'x' })
      : ok({ rows: [], total_count: 0 })),
  })
  const { connection, client } = mcpClient(fake, { shelf: 'work' })
  t.after(() => connection.dispose())

  assert.deepEqual(await client.knowledgeGet('msg-s-1'), { found: true, name: 'msg-s-1', content: { data: 'hi' } })
  await client.query('["$knowledge"]')
  await client.search('x', { shelf: 'other' })
  assert.equal(fake.servers.length, 1)
  assert.deepEqual(fake.servers[0].spec.argv, ['hypatia', 'mcp'])
  assert.deepEqual(fake.servers[0].calls.map((c) => c.args.shelf), ['work', 'work', 'other'])
})

test('a missing entry is {found: false}, as on the CLI', async (t) => {
  const fake = fakeSubprocess({ onCall: (_, args) => toolError(`not found: knowledge '${args.name}'`) })
  const { connection, client } = mcpClient(fake)
  t.after(() => connection.dispose())
  assert.deepEqual(await client.knowledgeGet('nope'), { found: false })
})

test('knowledgeCreate sends lists as lists and content whole; a collision is false', async (t) => {
  const big = '- '.padEnd(200_000, 'x') // far past the CLI's argv ceiling
  let exists = false
  const fake = fakeSubprocess({
    onCall: (_, args) => {
      if (exists) return toolError(`knowledge '${args.name}' already exists; use knowledge_update to change it`)
      exists = true
      return ok({ name: args.name, created: true })
    },
  })
  const { connection, client } = mcpClient(fake)
  t.after(() => connection.dispose())

  assert.equal(await client.knowledgeCreate('sum-1', { data: big, tags: ['summary'], scopes: ['proj', ''] }), true)
  assert.equal(await client.knowledgeCreate('sum-1', { data: 'again' }), false)
  const [first, second] = fake.servers[0].calls
  assert.deepEqual(first.args, { name: 'sum-1', shelf: 'default', data: big, tags: ['summary'], scopes: ['proj', ''] })
  assert.deepEqual(second.args, { name: 'sum-1', shelf: 'default', data: 'again' })
})

test('a storage-level collision also counts as a replay', async (t) => {
  const fake = fakeSubprocess({ onCall: () => toolError('storage error: UNIQUE constraint failed: knowledge.name') })
  const { connection, client } = mcpClient(fake)
  t.after(() => connection.dispose())
  assert.equal(await client.knowledgeCreate('k', { data: 'd' }), false)
})

test('statementCreate reports what the server created', async (t) => {
  const seen = new Set()
  const fake = fakeSubprocess({
    onCall: (_, args) => {
      const key = `${args.head}|${args.relation}|${args.tail}`
      const created = !seen.has(key)
      seen.add(key)
      return ok({ ...args, created })
    },
  })
  const { connection, client } = mcpClient(fake)
  t.after(() => connection.dispose())
  assert.equal(await client.statementCreate('a', 'summary', 'b', { scopes: ['p'] }), true)
  assert.equal(await client.statementCreate('a', 'summary', 'b', { scopes: ['p'] }), false)
  assert.deepEqual(fake.servers[0].calls[0].args, { head: 'a', relation: 'summary', tail: 'b', shelf: 'default', scopes: ['p'] })
})

test('search, similar and query return the rows', async (t) => {
  const row = { name: 'msg-s-1', content: { data: 'No results found.' }, distance: 0.1 }
  const fake = fakeSubprocess({ onCall: () => ok({ rows: [row], total_count: 1, embedding: null }) })
  const { connection, client } = mcpClient(fake)
  t.after(() => connection.dispose())
  assert.deepEqual(await client.search('grep', { catalog: 'knowledge', limit: 3 }), [row])
  assert.deepEqual(await client.similar('grep', { target: 'knowledge', limit: 2 }), [row])
  assert.deepEqual(await client.query('["$knowledge"]'), [row])
  assert.deepEqual(fake.servers[0].calls.map((c) => c.args), [
    { query: 'grep', catalog: 'knowledge', limit: 3, shelf: 'default' },
    { query: 'grep', target: 'knowledge', limit: 2, shelf: 'default' },
    { jse: '["$knowledge"]', shelf: 'default' },
  ])
})

test('any other tool error fails the call with the server\'s text', async (t) => {
  const fake = fakeSubprocess({ onCall: () => toolError('invalid JSE JSON: expected value') })
  const { connection, client } = mcpClient(fake)
  t.after(() => connection.dispose())
  await assert.rejects(client.query('{'), { code: 'TOOL_ERROR', message: /invalid JSE JSON/ })
})

test('an unknown shelf restarts the process, which re-reads the registry', async (t) => {
  let connected = false
  const fake = fakeSubprocess({
    onCall: (_, args) => (connected ? ok({ rows: [], total_count: 0 }) : toolError(`shelf error: shelf '${args.shelf}' is not connected`)),
  })
  const { connection, client } = mcpClient(fake)
  t.after(() => connection.dispose())
  await assert.rejects(client.query('[]'), { code: 'TOOL_ERROR', message: /is not connected/ })
  connected = true
  assert.deepEqual(await client.query('[]'), [])
  assert.equal(fake.servers.length, 2)
  assert.equal(fake.servers[0].stdinEnded, true, 'the stale process got EOF')
})

test('calls are serialized: the next one is sent only after the previous reply', async (t) => {
  const fake = fakeSubprocess({ onCall: () => ok({ rows: [], total_count: 0 }), replyDelayMs: 15 })
  const { connection, client } = mcpClient(fake)
  t.after(() => connection.dispose())
  await Promise.all([client.query('[1]'), client.query('[2]'), client.query('[3]')])
  assert.equal(fake.servers[0].maxOutstanding, 1, 'no request was sent while another awaited its reply')
  assert.deepEqual(fake.servers[0].calls.map((c) => c.args.jse), ['[1]', '[2]', '[3]'])
})

test('a call that overruns kills the process; the next call starts another', async (t) => {
  let hang = true
  const fake = fakeSubprocess({ onCall: () => (hang ? 'hang' : ok({ rows: [], total_count: 0 })) })
  const { connection, client } = mcpClient(fake, { timeoutMs: 50 })
  t.after(() => connection.dispose())
  await assert.rejects(client.query('[]'), { code: 'TIMEOUT' })
  assert.equal(fake.servers[0].terminated, true)
  hang = false
  assert.deepEqual(await client.query('[]'), [])
  assert.equal(fake.servers.length, 2)
})

test('a process that dies mid-call fails that call with its stderr, and is replaced', async (t) => {
  let die = true
  const fake = fakeSubprocess({ onCall: () => (die ? 'exit' : ok({ rows: [], total_count: 0 })) })
  const { connection, client } = mcpClient(fake)
  t.after(() => connection.dispose())
  await assert.rejects(client.query('[]'), { code: 'MCP_EXITED', message: /exited 101: thread main panicked/ })
  die = false
  assert.deepEqual(await client.query('[]'), [])
  assert.equal(fake.servers.length, 2)
})

test('an idle process is closed with EOF, and the next call starts a new one', async (t) => {
  const fake = fakeSubprocess({ onCall: () => ok({ rows: [], total_count: 0 }) })
  const { connection, client } = mcpClient(fake, { idleMs: 30 })
  t.after(() => connection.dispose())
  await client.query('[]')
  await sleep(80)
  assert.equal(fake.servers[0].stdinEnded, true)
  assert.equal(fake.servers[0].terminated, false, 'closed, not killed')
  await client.query('[]')
  assert.equal(fake.servers.length, 2)
})

test('dispose closes the process and refuses later calls', async () => {
  const fake = fakeSubprocess({ onCall: () => ok({ rows: [], total_count: 0 }) })
  const { connection, client } = mcpClient(fake)
  await client.query('[]')
  connection.dispose()
  assert.equal(fake.servers[0].stdinEnded, true)
  await assert.rejects(client.query('[]'), { code: 'MCP_CLOSED' })
})

test('a lone surrogate is sent as U+FFFD, as argv would carry it, not as a request hypatia cannot parse', async (t) => {
  const fake = fakeSubprocess({ onCall: (_, args) => ok({ name: args.name, created: true }) })
  const { connection, client } = mcpClient(fake)
  t.after(() => connection.dispose())
  const cut = '😀😀'.slice(0, 3) // what `.slice()` through an emoji leaves
  await client.knowledgeCreate('m', { data: `- ${cut}` })
  assert.doesNotMatch(fake.servers[0].lastLine, /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i, 'no unpaired high surrogate escape on the wire')
  assert.equal(fake.servers[0].calls[0].args.data, '- 😀�')
})

test('a request the server could not parse fails at once, not at its deadline', async (t) => {
  let garbled = true
  const fake = fakeSubprocess({ onCall: () => (garbled ? 'parse-error' : ok({ rows: [], total_count: 0 })) })
  const { connection, client } = mcpClient(fake, { timeoutMs: 5000 })
  t.after(() => connection.dispose())
  const started = Date.now()
  await assert.rejects(client.query('[]'), { code: 'MCP_ERROR', message: /parse error/ })
  assert.ok(Date.now() - started < 1000, 'answered by the id-null error, not by the timeout')
  garbled = false
  assert.deepEqual(await client.query('[]'), [])
  assert.equal(fake.servers.length, 1, 'the process was not killed')
})

test('a broken stdout stream fails the call instead of the host', async (t) => {
  let broken = true
  const fake = fakeSubprocess({ onCall: () => (broken ? 'stdout-error' : ok({ rows: [], total_count: 0 })) })
  const { connection, client } = mcpClient(fake)
  t.after(() => connection.dispose())
  await assert.rejects(client.query('[]'), { code: 'MCP_EXITED', message: /stream broke/ })
  broken = false
  assert.deepEqual(await client.query('[]'), [])
  assert.equal(fake.servers.length, 2)
})

test('an error quotes the stderr of its own call, not of earlier ones', async (t) => {
  let call = 0
  const fake = fakeSubprocess({
    onCall: (_, __, proc) => {
      call += 1
      if (call === 1) {
        proc.writeStderr('warning: old noise\n')
        return ok({ rows: [], total_count: 0 })
      }
      return 'exit'
    },
  })
  const { connection, client } = mcpClient(fake)
  t.after(() => connection.dispose())
  await client.query('[]')
  const error = await client.query('[]').catch((e) => e)
  assert.equal(error.code, 'MCP_EXITED')
  assert.match(error.message, /thread main panicked/)
  assert.doesNotMatch(error.message, /old noise/)
})

test('disposing during the handshake closes the process it was starting', async () => {
  const fake = fakeSubprocess({ mode: 'slow-start', handshakeDelayMs: 40, onCall: () => ok({ rows: [], total_count: 0 }) })
  const { connection, client } = mcpClient(fake)
  const pending = client.query('[]')
  await sleep(10)
  connection.dispose()
  await assert.rejects(pending, { code: 'MCP_CLOSED' })
  assert.equal(fake.servers[0].calls.length, 0, 'no tool call went out after dispose')
  assert.ok(fake.servers[0].stdinEnded || fake.servers[0].terminated, 'the process was closed')
})

test('a tool error that merely mentions "already exists" is not a replay', async (t) => {
  const fake = fakeSubprocess({ onCall: () => toolError('invalid arguments: a field that already exists was repeated') })
  const { connection, client } = mcpClient(fake)
  t.after(() => connection.dispose())
  await assert.rejects(client.knowledgeCreate('k', { data: 'd' }), { code: 'TOOL_ERROR' })
})

test('tags and scopes are split as the CLI splits them', async (t) => {
  const fake = fakeSubprocess({ onCall: (_, args) => ok({ ...args, created: true }) })
  const { connection, client } = mcpClient(fake)
  t.after(() => connection.dispose())
  // What hypatia-cli.js sends is `--scopes <items joined with ",">`, parsed by
  // hypatia's parse_scopes: blanks dropped, a trailing comma adds "".
  await client.knowledgeCreate('a', { data: 'd', tags: ['x, y'], scopes: ['a,b'] })
  await client.knowledgeCreate('b', { data: 'd', scopes: [''] }) // how the CLI stores `--scopes ""`
  await client.knowledgeCreate('c', { data: 'd', scopes: ['proj', ''] })
  await client.statementCreate('h', 'r', 't', { scopes: [' proj '] })
  // Trimmed as hypatia (Rust) trims: NEL goes, a BOM stays.
  const nel = String.fromCharCode(0x85)
  const bom = String.fromCharCode(0xfeff)
  await client.knowledgeCreate('e', { data: 'd', scopes: [`nel${nel}`, `${bom}bom`] })
  const args = fake.servers[0].calls.map((c) => c.args)
  assert.deepEqual([args[0].tags, args[0].scopes], [['x', 'y'], ['a', 'b']])
  assert.equal('scopes' in args[1], false, 'no scope at all, as `--scopes ""` stores')
  assert.deepEqual(args[2].scopes, ['proj', ''])
  assert.deepEqual(args[3].scopes, ['proj'])
  assert.deepEqual(args[4].scopes, ['nel', `${bom}bom`])
})

/* ---------------------------------------------------------------------------- */
/* Transport switch                                                             */
/* ---------------------------------------------------------------------------- */

function statusLog() {
  const warnings = []
  return { warnings, status: { warn: (message) => warnings.push(message), info: () => {} } }
}

test('a binary without `mcp` sends every call to the CLI, with one warning', async (t) => {
  const fake = fakeSubprocess({ mode: 'old-binary', cliStdout: "Knowledge 'k' not found.\n" })
  const { warnings, status } = statusLog()
  const client = createHypatiaClient(fake.ctx, { binaries: ['hypatia'] }, { status })
  t.after(() => client.dispose())

  // Two calls race the failing handshake: the one queued behind it must go to
  // the CLI too, not fail with a closed connection.
  const results = await Promise.all([client.knowledgeGet('k'), client.knowledgeGet('k')])
  assert.deepEqual(results, [{ found: false }, { found: false }])
  await client.knowledgeGet('k')
  assert.equal(fake.servers.length, 1, 'MCP is not retried within the run')
  assert.equal(fake.cliCalls.length, 3)
  assert.deepEqual(fake.cliCalls[0], ['hypatia', 'knowledge-get', 'k', '--shelf', 'default'])
  assert.equal(client.transport(), 'cli')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /unrecognized subcommand 'mcp'.*using the hypatia CLI/s)
})

test('a start that crashes fails the call but does not give MCP up', async (t) => {
  const fake = fakeSubprocess({ mode: 'crash-on-start' })
  const { warnings, status } = statusLog()
  const client = createHypatiaClient(fake.ctx, { binaries: ['hypatia'] }, { status })
  t.after(() => client.dispose())
  await assert.rejects(client.query('[]'), { code: 'MCP_EXITED', message: /registry file is corrupt/ })
  await assert.rejects(client.query('[]'), { code: 'MCP_EXITED' })
  assert.equal(fake.servers.length, 2, 'the next call tried MCP again')
  assert.equal(fake.cliCalls.length, 0)
  assert.equal(client.transport(), 'mcp')
  assert.deepEqual(warnings, [])
})

test('a handshake that times out fails the call but does not give MCP up', async (t) => {
  const fake = fakeSubprocess({ mode: 'hang-on-start' })
  const { warnings, status } = statusLog()
  const connection = createMcpConnection(fake.ctx, { binary: () => 'hypatia', handshakeTimeoutMs: 30 })
  const client = createHypatiaClient(fake.ctx, { binaries: ['hypatia'] }, { status, connection })
  t.after(() => client.dispose())
  await assert.rejects(client.query('[]'), { code: 'TIMEOUT', message: /initialize/ })
  assert.equal(fake.servers[0].terminated, true)
  assert.equal(client.transport(), 'mcp')
  assert.deepEqual(warnings, [])
})

test('a server lacking a required tool is not used', async (t) => {
  const fake = fakeSubprocess({ tools: REQUIRED_TOOLS.filter((name) => name !== 'similar'), cliStdout: '[]' })
  const { warnings, status } = statusLog()
  const client = createHypatiaClient(fake.ctx, { binaries: ['hypatia'] }, { status })
  t.after(() => client.dispose())
  assert.deepEqual(await client.query('[]'), [])
  assert.equal(fake.cliCalls.length, 1)
  assert.match(warnings[0], /lacks similar/)
})

test('a binary that cannot start fails the call and keeps MCP selected', async (t) => {
  const fake = fakeSubprocess({ mode: 'spawn-fails' })
  const { warnings, status } = statusLog()
  const client = createHypatiaClient(fake.ctx, { binaries: ['hypatia'] }, { status })
  t.after(() => client.dispose())
  await assert.rejects(client.query('[]'), { code: 'SPAWN_FAILED', message: /ENOENT/ })
  assert.equal(fake.cliCalls.length, 0)
  assert.equal(client.transport(), 'mcp')
  assert.deepEqual(warnings, [])
})

test('transport: cli never starts `hypatia mcp`, and is read on every call', async (t) => {
  const fake = fakeSubprocess({ onCall: () => ok({ rows: [], total_count: 0 }), cliStdout: 'No results found.\n' })
  const config = { binaries: ['hypatia'], transport: 'cli' }
  const client = createHypatiaClient(fake.ctx, config, statusLog())
  t.after(() => client.dispose())
  assert.deepEqual(await client.query('[]'), [])
  assert.equal(fake.servers.length, 0)
  assert.equal(client.transport(), 'cli')
  config.transport = 'mcp'
  assert.deepEqual(await client.query('[]'), [])
  assert.equal(fake.servers.length, 1)
  assert.equal(fake.cliCalls.length, 1)
})

test('the shelf listing always comes from the CLI', async (t) => {
  const fake = fakeSubprocess({ cliStdout: '  default  /home/u/.hypatia/default  [connected]\n' })
  const client = createHypatiaClient(fake.ctx, { binaries: ['hypatia'] }, statusLog())
  t.after(() => client.dispose())
  assert.deepEqual(await client.listShelves(), [{ name: 'default', path: '/home/u/.hypatia/default', connected: true }])
  assert.deepEqual(fake.cliCalls, [['hypatia', 'list']])
  assert.equal(fake.servers.length, 0)
})
