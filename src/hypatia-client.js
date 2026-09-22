/**
 * The hypatia client the plugin uses: MCP by default, the CLI as fallback.
 *
 * `hypatia-auto-memory.transport` picks the transport and is read on every
 * call. With `mcp`, a binary that serves no usable MCP (one from before the
 * `mcp` subcommand) sends every call to the CLI for the rest of the run, with
 * one warning; a profile reload tries MCP again. Any other failure is the
 * call's own and propagates, as it would on the CLI.
 *
 * The shelf listing always comes from the CLI. `hypatia mcp` reads the
 * registry once, at start, so a shelf connected while it runs would stay
 * missing from the settings card; the listing is the one call whose point is
 * to notice that.
 *
 * @module dsh-hypatia-auto-memory/hypatia-client
 */

import { HypatiaCliError, createHypatiaCli } from './hypatia-cli.js'
import { createHypatiaMcp, createMcpConnection } from './hypatia-mcp.js'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - context injecting `subprocess`.
 * @param {{binaries: string[], transport?: 'mcp' | 'cli', shelf?: string}} config -
 *   read live; `shelf` is where every call goes unless the call names another.
 * @param {{status: {warn: (message: string) => void}, connection?: ReturnType<typeof createMcpConnection>}} deps -
 *   `connection` is for tests.
 */
export function createHypatiaClient(ctx, config, { status, connection }) {
  const cli = createHypatiaCli(ctx, config)
  const conn = connection ?? createMcpConnection(ctx, { binary: () => config.binaries[0] })
  const mcp = createHypatiaMcp(conn, config)
  /** Why MCP was given up for this run; empty while it is in use. */
  let unavailable = ''

  const usesMcp = () => (config.transport ?? 'mcp') === 'mcp' && unavailable === ''

  async function via(method, args) {
    if (!usesMcp()) return cli[method](...args)
    try {
      return await mcp[method](...args)
    } catch (error) {
      if (!(error instanceof HypatiaCliError)) throw error
      if (error.code === 'MCP_UNAVAILABLE') {
        if (unavailable === '') {
          unavailable = error.message
          conn.dispose()
          status.warn(`${error.message}; using the hypatia CLI until the profile reloads`)
        }
        return cli[method](...args)
      }
      // Queued behind the call that gave MCP up, so it never reached a server.
      if (error.code === 'MCP_CLOSED' && unavailable !== '') return cli[method](...args)
      throw error
    }
  }

  /** Logged once, so the profile log says which flags this run's writes carry. */
  let announced = false
  async function features() {
    const found = await via('features', [])
    if (!announced) {
      announced = true
      const yes = (flag) => (flag ? 'yes' : 'no')
      status.info?.(`hypatia over ${usesMcp() ? 'mcp' : 'cli'}: no-embed ${yes(found.noEmbed)}, similar filters ${yes(found.similarFilters)}`)
    }
    return found
  }

  return {
    /** What the binary can do beyond the baseline (see hypatia-cli.js `features`). */
    features,
    knowledgeGet: (...args) => via('knowledgeGet', args),
    knowledgeCreate: (...args) => via('knowledgeCreate', args),
    statementCreate: (...args) => via('statementCreate', args),
    search: (...args) => via('search', args),
    similar: (...args) => via('similar', args),
    query: (...args) => via('query', args),
    listShelves: () => cli.listShelves(),

    /** The transport the next call will use. */
    transport: () => (usesMcp() ? 'mcp' : 'cli'),

    /** Close the MCP process, if one is running. */
    dispose: () => conn.dispose(),
  }
}
