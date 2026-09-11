/**
 * Typed wrapper over the `hypatia` CLI via the DSH subprocess service.
 *
 * Every invocation uses an argv array with NO shell interpretation, so the
 * plugin never needs sandbox escalation and never parses shell syntax — the
 * auto-approve layer that dsh-hypatia needs for bash-string calls simply does
 * not exist here.
 *
 * @module dsh-hypatia-auto-memory/hypatia-cli
 */

import { homedir } from 'node:os'

/** Per-call ceiling for one hypatia CLI invocation. */
const DEFAULT_TIMEOUT_MS = 30_000
const GRACE_MS = 3000
const STDOUT_MAX_BYTES = 512 * 1024
const STDERR_MAX_BYTES = 64 * 1024

export class HypatiaCliError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, stderr?: string, exitCode?: number|null}} [facts]
   */
  constructor(message, facts = {}) {
    super(message)
    this.name = 'HypatiaCliError'
    this.code = facts.code ?? 'HYPATIA_CLI'
    this.stderr = facts.stderr
    this.exitCode = facts.exitCode ?? null
  }
}

/**
 * Create the CLI runner bound to one subprocess service and config source.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - context injecting `subprocess`.
 * @param {{binaries: string[], timeoutMs?: number}} config
 */
export function createHypatiaCli(ctx, config) {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  /**
   * Run one argv, collect bounded output, enforce the deadline.
   * @param {string[]} argv
   * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string}>}
   */
  async function run(argv) {
    const binary = config.binaries[0]
    if (binary === undefined || binary === '') {
      throw new HypatiaCliError('no hypatia binary configured', { code: 'NO_BINARY' })
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv: [binary, ...argv],
        cwd: homedir(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: STDOUT_MAX_BYTES },
          stderr: { maxBytes: STDERR_MAX_BYTES },
        },
        graceMs: GRACE_MS,
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      throw new HypatiaCliError(`failed to spawn hypatia: ${String(error)}`, { code: 'SPAWN_FAILED' })
    }
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      clearTimeout(timer)
      throw new HypatiaCliError(`hypatia process failed: ${String(error)}`, { code: 'PROCESS_FAILED' })
    } finally {
      clearTimeout(timer)
    }
    const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    if (controller.signal.aborted) {
      throw new HypatiaCliError(`hypatia timed out after ${timeoutMs}ms: ${argv.join(' ')}`, {
        code: 'TIMEOUT',
        stderr,
        exitCode: outcome.exitCode,
      })
    }
    return { exitCode: outcome.exitCode, stdout, stderr }
  }

  /**
   * Run and require exit 0; throw with stderr context otherwise.
   *
   * A primary-key collision gets its own `DUPLICATE` code so the write helpers
   * can treat it as an idempotent no-op. hypatia has no upsert and no
   * `--if-not-exists` — both tables are plain `INSERT` with no `ON CONFLICT`
   * (`src/storage/sqlite_store.rs`) — so recognising the error text is the only
   * way a replay can finish a half-written multi-step graph write. Matching on
   * a message is unlovely; it is confined to this one function so that adding
   * an upsert upstream is a single deletion here. Both backends are covered:
   * SQLite reports `UNIQUE constraint failed:`, PostgreSQL `duplicate key`.
   *
   * @param {string[]} argv
   */
  async function runOk(argv) {
    const result = await run(argv)
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim().slice(0, 500)
      const duplicate = /UNIQUE constraint failed:|duplicate key/i.test(stderr)
      throw new HypatiaCliError(`hypatia exited ${result.exitCode}: ${argv.join(' ')}`, {
        code: duplicate ? 'DUPLICATE' : 'NONZERO_EXIT',
        stderr,
        exitCode: result.exitCode,
      })
    }
    return result
  }

  /**
   * Run a create that is expected to be replayed: a collision means the row is
   * already there, which is success for our purposes.
   * @returns {Promise<boolean>} true when this call created the row.
   */
  async function runCreate(argv) {
    try {
      await runOk(argv)
      return true
    } catch (error) {
      if (error instanceof HypatiaCliError && error.code === 'DUPLICATE') return false
      throw error
    }
  }

  /** Parse a pretty-JSON stdout payload, tolerating trailing whitespace. */
  function parseJson(stdout, what) {
    try {
      return JSON.parse(stdout)
    } catch {
      throw new HypatiaCliError(`unparseable ${what} output: ${stdout.slice(0, 200)}`, { code: 'BAD_JSON' })
    }
  }

  return {
    run,
    runOk,

    /**
     * Read one knowledge entry. Missing entries are a normal result, not an
     * error: the CLI prints `Knowledge '<name>' not found.` with exit 0.
     * @returns {Promise<{found: true, name: string, content: any} | {found: false}>}
     */
    async knowledgeGet(name, shelf = 'default') {
      const { stdout } = await runOk(['knowledge-get', name, '--shelf', shelf])
      const trimmed = stdout.trim()
      if (/^Knowledge '.*' not found\.$/.test(trimmed)) return { found: false }
      const parsed = parseJson(trimmed, 'knowledge-get')
      return { found: true, name: parsed.name, content: parsed.content }
    },

    /**
     * @param {{data: string, tags?: string[], scopes?: string[], shelf?: string}} entry
     * @returns {Promise<boolean>} true when this call created the entry.
     */
    async knowledgeCreate(name, entry) {
      const argv = ['knowledge-create', name, '--shelf', entry.shelf ?? 'default']
      // Use the `--data=<value>` form: consolidated content routinely begins
      // with a markdown bullet (`- …`), and a space-separated `-d <value>`
      // makes clap parse the leading `-` as a new flag (exit 2).
      if (entry.data) argv.push(`--data=${entry.data}`)
      if (entry.tags && entry.tags.length > 0) argv.push('--tags', entry.tags.join(','))
      if (entry.scopes && entry.scopes.length > 0) argv.push('--scopes', entry.scopes.join(','))
      return runCreate(argv)
    },

    /**
     * @param {{data?: string, scopes?: string[], shelf?: string}} [entry]
     * @returns {Promise<boolean>} true when this call created the triple.
     */
    async statementCreate(head, relation, tail, entry = {}) {
      const argv = [
        'statement-create', head, relation, tail,
        '--shelf', entry.shelf ?? 'default',
      ]
      // Same `--data=` rationale as knowledgeCreate: statement payloads can
      // start with `-` (markdown bullets) which a space-separated value would
      // expose to clap's flag parsing.
      if (entry.data) argv.push(`--data=${entry.data}`)
      if (entry.scopes && entry.scopes.length > 0) argv.push('--scopes', entry.scopes.join(','))
      return runCreate(argv)
    },

    /**
     * Keyword search. Returns the raw row array (shape owned by hypatia —
     * rows carry `key`, not `name`); callers filter defensively. An empty
     * result prints `No results found.` on stdout with exit 0.
     * @returns {Promise<any[]>}
     */
    async search(query, { catalog = 'knowledge', limit = 5, shelf = 'default' } = {}) {
      const { stdout } = await runOk(['search', query, '-c', catalog, '--limit', String(limit), '--shelf', shelf])
      if (stdout.includes('No results found.')) return []
      const parsed = parseJson(stdout, 'search')
      return Array.isArray(parsed) ? parsed : []
    },

    /**
     * Vector-similarity search — the recall path's primary ranking tool.
     * NOTE the flag is `-t/--target` (unlike keyword search's `-c`).
     * @returns {Promise<any[]>}
     */
    async similar(query, { target = 'knowledge', limit = 5, shelf = 'default' } = {}) {
      const { stdout } = await runOk(['similar', query, '-t', target, '--limit', String(limit), '--shelf', shelf])
      if (stdout.includes('No results found.')) return []
      const parsed = parseJson(stdout, 'similar')
      return Array.isArray(parsed) ? parsed : []
    },

    /**
     * Raw JSE query (rules/taboos preload, not-summarized checks).
     * @returns {Promise<any[]>} result rows.
     */
    async query(jse, { shelf = 'default' } = {}) {
      const { stdout } = await runOk(['query', jse, '--shelf', shelf])
      const parsed = parseJson(stdout, 'query')
      if (Array.isArray(parsed)) return parsed
      if (Array.isArray(parsed?.rows)) return parsed.rows
      return []
    },
  }
}
