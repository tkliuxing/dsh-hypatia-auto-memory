/**
 * hypatia over MCP: one private `hypatia mcp` process on the subprocess
 * service, spoken to over stdio.
 *
 * The connection is the plugin's own. It is not registered with
 * `dsh-mcp-client`, so the model never sees these tools and the plugin's calls
 * pass through no tool policy, hook or approval — the same property the argv
 * CLI path has.
 *
 * `hypatia mcp` answers one request at a time, in order (hypatia
 * docs/agent-interfaces.md §3), so requests are serialized here as well: a
 * request's deadline then measures that request and not the queue in front of
 * it. The process starts on the first call and is closed after a quiet spell,
 * for two reasons from the same document. It keeps the embedding model's
 * allocations after a semantic call (hundreds of MB resident), and it reads the
 * shelf registry once, at start — a fresh process is what sees a shelf
 * connected since.
 *
 * Results are mapped onto the CLI client's interface (hypatia-cli.js), so the
 * writer, cascade, recall and housekeeping do not know which transport ran.
 *
 * @module dsh-hypatia-auto-memory/hypatia-mcp
 */

import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

import { trimLikeHypatia } from './content-policy.js'
import { HypatiaCliError } from './hypatia-cli.js'
import { DEFAULT_SHELF } from './shelf.js'

/** Handshake-era revision `hypatia mcp` speaks (it accepts four; this one is enough). */
const PROTOCOL_VERSION = '2025-06-18'
/** Per-call ceiling, as for one CLI invocation. */
const DEFAULT_TIMEOUT_MS = 30_000
/** Starting the process and listing its tools; opening a shelf is not part of it. */
const HANDSHAKE_TIMEOUT_MS = 10_000
/** Quiet time after which the process is closed. A consolidation's calls fall well inside it. */
const DEFAULT_IDLE_MS = 60_000
const GRACE_MS = 3000
const STDERR_MAX_BYTES = 64 * 1024

/** Tools the client calls. A server lacking any of them counts as unavailable. */
export const REQUIRED_TOOLS = Object.freeze([
  'knowledge_get',
  'knowledge_create',
  'statement_create',
  'search',
  'similar',
  'query',
])

/**
 * What a server can do beyond REQUIRED_TOOLS, read off the schemas in its
 * `tools/list`. Every tool declares `additionalProperties: false`, so an
 * argument a server does not list fails the call as a validation error rather
 * than being ignored — which is why the plugin asks first instead of trying.
 * The names mirror hypatia-cli.js's `features()`.
 *
 * @param {Array<{name?: string, inputSchema?: {properties?: object}}>} tools
 * @returns {{noEmbed: boolean, similarFilters: boolean}}
 */
export function featuresOf(tools) {
  const accepts = (name, argument) => Object.hasOwn(
    tools.find((tool) => tool?.name === name)?.inputSchema?.properties ?? {},
    argument,
  )
  return {
    noEmbed: accepts('knowledge_create', 'embed') && accepts('statement_create', 'embed'),
    similarFilters: accepts('similar', 'exclude_tags'),
  }
}

/**
 * One request line. A lone UTF-16 surrogate — what a `.slice()` through an
 * emoji leaves behind — is written by `JSON.stringify` as a bare `\ud83d`
 * escape, which hypatia's JSON parser rejects, failing the whole request. The
 * CLI path never met this: Node encodes argv as UTF-8, where it becomes U+FFFD.
 * `toWellFormed()` makes the same substitution here.
 */
function encode(message) {
  return `${JSON.stringify(message, (_, value) => (typeof value === 'string' ? value.toWellFormed() : value))}\n`
}

/**
 * Whether a failed handshake shows the binary serves no usable MCP, as opposed
 * to one start that went wrong. Only the former is worth giving MCP up for.
 */
function isUnavailable(error) {
  if (!(error instanceof HypatiaCliError)) return false
  // A required tool missing from `tools/list`.
  if (error.code === 'MCP_UNAVAILABLE') return true
  // A server that answers, but not `initialize` or `tools/list`.
  if (error.code === 'MCP_ERROR') return true
  // clap's usage error: a binary from before the `mcp` subcommand.
  return error.code === 'MCP_EXITED' && error.exitCode === 2 && /unrecognized subcommand/.test(error.stderr ?? '')
}

/**
 * One `hypatia mcp` process at a time, started on demand.
 *
 * Every failure is a `HypatiaCliError`. `MCP_UNAVAILABLE` means the binary
 * ran but serves no usable MCP — no `mcp` subcommand, a required tool missing,
 * or a server that answers `initialize` or `tools/list` with an error — and is the only
 * code the transport switch in hypatia-client.js falls back on. Anything else
 * fails the one call it happened to: a binary that cannot be started at all
 * (`SPAWN_FAILED`, `NO_BINARY`, as on the CLI path), a start that timed out or
 * died, or a process that dies or overruns during a call (`MCP_EXITED`,
 * `TIMEOUT`). The next call starts a new process.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - context injecting `subprocess`.
 * @param {{
 *   binary: () => string | undefined,
 *   timeoutMs?: number,
 *   handshakeTimeoutMs?: number,
 *   idleMs?: number,
 * }} options
 */
export function createMcpConnection(ctx, options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS

  /** The live, handshaken process, if any. */
  let current
  let nextId = 1
  let chain = Promise.resolve()
  let idleTimer
  let disposed = false
  /** Set once a binary has shown it serves no usable MCP; it will not start to. */
  let unavailable

  /** Stderr written since `conn`'s current call was sent, trimmed to its tail. */
  function stderrOf(conn) {
    return (conn.handle.collected.stderr?.readFrom(conn.stderrMark).text ?? '').trim().slice(-500)
  }

  /** Reject whatever is waiting on `conn` and forget it. */
  function fail(conn, error) {
    conn.closed = true
    if (current === conn) current = undefined
    for (const waiter of conn.pending.values()) waiter.reject(error)
    conn.pending.clear()
  }

  /** Close `conn`: EOF ends `hypatia mcp`'s read loop; terminate is the backstop. */
  function close(conn) {
    if (conn.closed) return
    fail(conn, new HypatiaCliError('hypatia mcp connection closed', { code: 'MCP_CLOSED' }))
    conn.handle.stdin.end()
    const backstop = setTimeout(() => conn.handle.terminate(), GRACE_MS)
    backstop.unref?.()
    void conn.handle.done.finally(() => clearTimeout(backstop)).catch(() => {})
  }

  function kill(conn, error) {
    fail(conn, error)
    conn.handle.terminate()
  }

  function spawn() {
    const binary = options.binary()
    if (binary === undefined || binary === '') {
      throw new HypatiaCliError('no hypatia binary configured', { code: 'NO_BINARY' })
    }
    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv: [binary, 'mcp'],
        cwd: homedir(),
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: { maxBytes: STDERR_MAX_BYTES },
        },
        graceMs: GRACE_MS,
      })
    } catch (error) {
      throw new HypatiaCliError(`failed to spawn hypatia mcp: ${String(error)}`, { code: 'SPAWN_FAILED' })
    }
    if (handle.stdin === undefined || handle.stdout === undefined) {
      handle.terminate()
      throw new HypatiaCliError('hypatia mcp spawned without piped stdio', { code: 'SPAWN_FAILED' })
    }
    const conn = { handle, pending: new Map(), closed: false, stderrMark: 0 }
    // The exit path below reports a dead process; a write racing it must not
    // surface as an unhandled stream error.
    handle.stdin.on('error', () => {})
    const lines = createInterface({ input: handle.stdout, crlfDelay: Infinity })
    // readline re-emits a stdout stream error here; unheard, it would take the
    // host down with it.
    lines.on('error', (error) => {
      kill(conn, new HypatiaCliError(`hypatia mcp stdout failed: ${String(error)}`, { code: 'MCP_EXITED' }))
    })
    lines.on('line', (line) => {
      if (line.trim() === '') return
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      // Replies only: this client offers no capabilities, so the server sends
      // no requests or notifications worth answering.
      let id = message?.id
      // A request the server could not read is answered with id null. One
      // request is outstanding at most, so it is that one; left unmatched, it
      // would wait out its deadline and cost the process.
      if (id === null && message.error !== undefined && conn.pending.size === 1) {
        id = conn.pending.keys().next().value
      }
      const waiter = conn.pending.get(id)
      if (waiter === undefined) return
      conn.pending.delete(id)
      if (message.error !== undefined) {
        waiter.reject(new HypatiaCliError(`hypatia mcp: ${message.error?.message ?? 'error'}`, { code: 'MCP_ERROR' }))
      } else {
        waiter.resolve(message.result)
      }
    })
    handle.done.then(
      (outcome) => {
        const how = outcome.exitCode !== null ? `exited ${outcome.exitCode}` : `killed by ${outcome.signal}`
        const stderr = stderrOf(conn)
        fail(conn, new HypatiaCliError(`hypatia mcp ${how}${stderr === '' ? '' : `: ${stderr}`}`, {
          code: 'MCP_EXITED',
          stderr,
          exitCode: outcome.exitCode,
        }))
      },
      (error) => {
        fail(conn, new HypatiaCliError(`hypatia mcp failed to start: ${String(error)}`, { code: 'SPAWN_FAILED' }))
      },
    )
    return conn
  }

  function request(conn, method, params, deadlineMs) {
    return new Promise((resolve, reject) => {
      if (conn.closed) {
        reject(new HypatiaCliError('hypatia mcp connection closed', { code: 'MCP_CLOSED' }))
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        // `hypatia mcp` cannot cancel a request, and everything after this one
        // would wait behind it: kill the process, as the CLI path kills a
        // command that overruns.
        kill(conn, new HypatiaCliError(`hypatia mcp timed out after ${deadlineMs}ms: ${method}`, {
          code: 'TIMEOUT',
          stderr: stderrOf(conn),
        }))
      }, deadlineMs)
      conn.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      conn.handle.stdin.write(encode({ jsonrpc: '2.0', id, method, params }))
    })
  }

  /** Start a process and check it serves what the client calls. */
  async function open() {
    const conn = spawn()
    try {
      await request(conn, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-hypatia-auto-memory', version: '0' },
      }, handshakeTimeoutMs)
      conn.handle.stdin.write(encode({ jsonrpc: '2.0', method: 'notifications/initialized' }))
      const listed = await request(conn, 'tools/list', {}, handshakeTimeoutMs)
      const tools = listed?.tools ?? []
      const names = new Set(tools.map((tool) => tool?.name))
      const missing = REQUIRED_TOOLS.filter((name) => !names.has(name))
      if (missing.length > 0) {
        throw new HypatiaCliError(`hypatia mcp lacks ${missing.join(', ')}`, { code: 'MCP_UNAVAILABLE' })
      }
      conn.features = featuresOf(tools)
    } catch (error) {
      kill(conn, error)
      if (!isUnavailable(error)) throw error
      // Calls already queued get this answer instead of starting the binary
      // again. The message carries clap's own words for an old binary.
      unavailable = new HypatiaCliError(`hypatia mcp unavailable: ${error.message}`, {
        code: 'MCP_UNAVAILABLE',
        stderr: error.stderr,
      })
      throw unavailable
    }
    return conn
  }

  function armIdle() {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (current !== undefined) close(current)
    }, idleMs)
    idleTimer.unref?.()
  }

  /**
   * Run `step` against a live, handshaken process, after the steps before it.
   * @template T
   * @param {(conn: object) => Promise<T>} step
   * @returns {Promise<T>}
   */
  function withProcess(step) {
    const run = async () => {
      if (disposed) throw new HypatiaCliError('hypatia mcp connection disposed', { code: 'MCP_CLOSED' })
      if (unavailable !== undefined) throw unavailable
      clearTimeout(idleTimer)
      try {
        if (current === undefined || current.closed) {
          const conn = await open()
          // Disposed during the handshake: nothing else would close it.
          if (disposed) {
            close(conn)
            throw new HypatiaCliError('hypatia mcp connection disposed', { code: 'MCP_CLOSED' })
          }
          current = conn
        }
        return await step(current)
      } finally {
        if (!disposed) armIdle()
      }
    }
    const result = chain.then(run, run)
    chain = result.catch(() => {})
    return result
  }

  return {
    /**
     * One `tools/call`, after the calls before it.
     * @param {string} name
     * @param {Record<string, unknown>} args
     * @returns {Promise<any>} the MCP `CallToolResult`, `isError` included.
     */
    call(name, args) {
      return withProcess((conn) => {
        // An error quotes what this call made the process write, not what
        // earlier calls did. The handshake's errors quote everything.
        conn.stderrMark = conn.handle.collected.stderr?.readFrom(0).nextOffset ?? 0
        return request(conn, 'tools/call', { name, arguments: args }, timeoutMs)
      })
    },

    /**
     * What the server can do beyond REQUIRED_TOOLS (see `featuresOf`), from
     * the handshake — starting the process if none is running.
     * @returns {Promise<{noEmbed: boolean, similarFilters: boolean}>}
     */
    features() {
      return withProcess((conn) => Promise.resolve(conn.features))
    },

    /** Drop the process; the next call starts a fresh one. */
    reset() {
      if (current !== undefined) close(current)
    },

    dispose() {
      disposed = true
      clearTimeout(idleTimer)
      if (current !== undefined) close(current)
    },
  }
}

/** The text blocks of a tool result, joined. */
function toolText(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n')
}

/**
 * A list as the CLI stores it when hypatia-cli.js passes `items.join(',')`:
 * split on commas, trimmed, blanks dropped, and — for scopes — a trailing comma
 * adding the global scope `""`. (The CLI keeps a blank tag where the server
 * drops it; no caller sends one.) `hypatia mcp` trims each item the same way
 * but never splits one or reads a trailing comma, so without this a list
 * holding `a,b`, `""` or `foo,` would be stored differently depending on which
 * transport wrote it, and scope queries would stop matching across the two.
 * `projectScope` keeps the plugin's own project names clear of all three.
 *
 * @param {string[]} items
 * @param {{scopes?: boolean}} [kind]
 */
function asCliList(items, { scopes = false } = {}) {
  const joined = items.join(',')
  const list = joined.split(',').map(trimLikeHypatia).filter((item) => item !== '')
  if (scopes && joined.endsWith(',') && !list.includes('')) list.push('')
  return list
}

/**
 * The CLI client's interface (hypatia-cli.js), served by `hypatia mcp`.
 *
 * Differences from the CLI, all at the transport level:
 * - Content is a JSON string on stdin, not an argv element, so nothing is
 *   truncated to fit a command line.
 * - Absence and collisions arrive as tool errors (`not found: knowledge …`,
 *   `knowledge '…' already exists`) and map onto the CLI client's results:
 *   `{found: false}` and a `false` create.
 * - `statement_create` reports whether it created the triple.
 *
 * `listShelves` is not here: the shelf listing stays on the CLI (see
 * hypatia-client.js).
 *
 * @param {ReturnType<typeof createMcpConnection>} connection
 * @param {{shelf?: string}} config
 */
export function createHypatiaMcp(connection, config) {
  const shelfOf = () => config.shelf ?? DEFAULT_SHELF

  /**
   * Call a tool; a tool error becomes a `HypatiaCliError` whose code says what
   * the CLI client would have made of it.
   */
  async function invoke(name, args) {
    const result = await connection.call(name, args)
    if (result?.isError === true) {
      const message = toolText(result).trim()
      // The server loaded the registry when it started. A shelf connected since
      // is only visible to a new process, and the queue's retry will be one.
      if (/is not connected/.test(message)) connection.reset()
      let code = 'TOOL_ERROR'
      if (/^not found:/.test(message)) code = 'NOT_FOUND'
      // `knowledge_create` checks first and says so; the storage layer's own
      // text — the same the CLI client keys on — covers a row that appeared
      // between that check and the insert.
      else if (/^knowledge '[\s\S]*' already exists;|UNIQUE constraint failed:|duplicate key/i.test(message)) code = 'DUPLICATE'
      throw new HypatiaCliError(`hypatia ${name}: ${message.slice(0, 500)}`, { code, stderr: message.slice(0, 500) })
    }
    if (result?.structuredContent !== undefined) return result.structuredContent
    try {
      return JSON.parse(toolText(result))
    } catch {
      throw new HypatiaCliError(`unparseable ${name} result: ${toolText(result).slice(0, 200)}`, { code: 'BAD_JSON' })
    }
  }

  /** A create that a replay repeats: a collision means the row is there. */
  async function create(name, args) {
    try {
      return await invoke(name, args)
    } catch (error) {
      if (error instanceof HypatiaCliError && error.code === 'DUPLICATE') return undefined
      throw error
    }
  }

  /** `tags` and `scopes` as the CLI would have stored them; omitted when that is nothing. */
  function lists(args, { tags, scopes }) {
    const cleanTags = asCliList(tags ?? [])
    if (cleanTags.length > 0) args.tags = cleanTags
    const cleanScopes = asCliList(scopes ?? [], { scopes: true })
    if (cleanScopes.length > 0) args.scopes = cleanScopes
    return args
  }

  const rowsOf = (structured) => (Array.isArray(structured?.rows) ? structured.rows : [])

  return {
    /** @returns {Promise<{found: true, name: string, content: any} | {found: false}>} */
    async knowledgeGet(name, shelf = shelfOf()) {
      try {
        const entry = await invoke('knowledge_get', { name, shelf })
        return { found: true, name: entry.name, content: entry.content }
      } catch (error) {
        if (error instanceof HypatiaCliError && error.code === 'NOT_FOUND') return { found: false }
        throw error
      }
    },

    features: () => connection.features(),

    /**
     * `embed: false` keeps the entry out of the vector index (hypatia #26); a
     * server whose `knowledge_create` does not list the argument would reject
     * it, so there it is dropped and the entry is embedded as before.
     *
     * @param {{data: string, tags?: string[], scopes?: string[], embed?: boolean, shelf?: string}} entry
     * @returns {Promise<boolean>} true when this call created the entry.
     */
    async knowledgeCreate(name, entry) {
      const args = { name, shelf: entry.shelf ?? shelfOf() }
      if (entry.data) args.data = entry.data
      if (entry.embed === false && (await connection.features()).noEmbed) args.embed = false
      return (await create('knowledge_create', lists(args, entry))) !== undefined
    },

    /**
     * `embed: false` as on `knowledgeCreate`.
     * @param {{data?: string, scopes?: string[], embed?: boolean, shelf?: string}} [entry]
     * @returns {Promise<boolean>} true when this call created the triple.
     */
    async statementCreate(head, relation, tail, entry = {}) {
      const args = { head, relation, tail, shelf: entry.shelf ?? shelfOf() }
      if (entry.data) args.data = entry.data
      if (entry.embed === false && (await connection.features()).noEmbed) args.embed = false
      const outcome = await create('statement_create', lists(args, { scopes: entry.scopes }))
      return outcome !== undefined && outcome.created !== false
    },

    /** Keyword search; rows as the CLI prints them. */
    async search(query, { catalog = 'knowledge', limit = 5, shelf = shelfOf() } = {}) {
      return rowsOf(await invoke('search', { query, catalog, limit, shelf }))
    },

    /**
     * Vector-similarity search; rows as the CLI prints them. `excludeTags`
     * narrows the entries before they are ranked (hypatia #35) and is dropped
     * on a server that does not list it, as on the CLI.
     */
    async similar(query, { target = 'knowledge', limit = 5, shelf = shelfOf(), excludeTags = [] } = {}) {
      const args = { query, target, limit, shelf }
      if (excludeTags.length > 0 && (await connection.features()).similarFilters) {
        args.exclude_tags = asCliList(excludeTags)
      }
      return rowsOf(await invoke('similar', args))
    },

    /** Raw JSE query; `jse` is the JSON text the CLI would take as its argument. */
    async query(jse, { shelf = shelfOf() } = {}) {
      return rowsOf(await invoke('query', { jse, shelf }))
    },
  }
}
