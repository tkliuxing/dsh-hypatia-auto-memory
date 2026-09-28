/**
 * On-demand consolidation: the two surfaces a user drives directly.
 *
 * The plugin writes memory in the background, on thresholds. That is the right
 * default and the wrong answer when a reader wants the summary NOW — measured
 * live, a session sat 151 logged events behind while the token floor had only
 * accumulated 645, because the floor counts user/assistant prose and the
 * trigger was freshly restarted. Waiting for the gate is not an option a user
 * should have to accept, so there is an explicit request.
 *
 * There are three faces, and this module owns the two that live in the Host:
 *
 * - the slash command `hypatia-summarize`, executed by the UI **without a model
 *   turn** (`CommandDefinition.handler`'s contract), and
 * - the tool `hypatia_summarize`, which is the skill's execution path: the
 *   agent asks for consolidation instead of writing `sum-*` entries itself.
 *
 * The third face — the Memory tab's button — rides the same host action from
 * `memory-api.js`. All three call one function and report its one result
 * vocabulary, so they cannot drift into telling a user different things.
 *
 * What is deliberately NOT here: any way to run the consolidation model call
 * inline. An explicit request only ENQUEUES. The queue executor is the single
 * writer of `sum-*` / `wu-*` (idempotent by name), and a synchronous second
 * writer would be exactly the duplicate this design exists to avoid.
 *
 * @module dsh-hypatia-auto-memory/on-demand
 */

import { SUMMARIZE_REASON } from './consolidator.js'

/** Slash command a user types in the composer. */
export const SUMMARIZE_COMMAND = 'hypatia-summarize'

/** Agent-facing tool name, per DSH's snake_case tool convention. */
export const SUMMARIZE_TOOL = 'hypatia_summarize'

/** Plugin-owned identity of the command definition, independent of its name. */
export const SUMMARIZE_DEFINITION_ID = 'dsh-hypatia-auto-memory/hypatia-summarize'

/**
 * `/`-menu description. The client keeps the Host's own text for a non-builtin
 * command and shows it in the Commands section, after the builtins, so this
 * line is the whole discovery story for the command — it has to say what the
 * command does without relying on the name being recognized.
 *
 * Bilingual on purpose: the dictionaries this plugin ships are, and the command
 * registry has one `description` field with no locale behind it.
 */
export const SUMMARIZE_COMMAND_DESCRIPTION = 'Summarise this session into Hypatia memory now · 立即整理本会话'

/** Tool description; model-facing, so English only and explicit about the side effect. */
export const SUMMARIZE_TOOL_DESCRIPTION = 'Summarise a session into long-term Hypatia memory right now, without waiting '
  + 'for the automatic background thresholds. Queues the consolidation span that is currently unsummarised; the '
  + 'summary is produced in the background on the plugin\'s dedicated model route, so this call returns immediately '
  + 'and does not consume this session\'s context. Use it only when the user explicitly asks to summarise, '
  + 'consolidate or digest the current (or a named) session now. Never call it on your own initiative.'

/**
 * The session id a command invocation or a tool call is bound to.
 *
 * Mirrors the collector's own derivation (`header.id` first): the header is the
 * durable copy, and a detached session exposes the same value through `id`.
 *
 * @param {any} session
 * @returns {string} the id, or '' when there is none to read.
 */
export function sessionIdOf(session) {
  const value = session?.header?.id ?? session?.id
  return value === undefined || value === null ? '' : String(value)
}

/**
 * The one result an unavailable consolidation half reports.
 * @param {string} sessionId
 * @returns {{sessionId: string, queued: boolean, reason: string, fromSeq: number, toSeq: number}}
 */
export function unavailableOutcome(sessionId) {
  return { sessionId, queued: false, reason: SUMMARIZE_REASON.Unavailable, fromSeq: 0, toSeq: 0 }
}

/**
 * The one result the whole plugin being switched off reports, for the route
 * family that stays mounted so a user can still see why nothing happens.
 * @param {string} sessionId
 * @returns {{sessionId: string, queued: boolean, reason: string, fromSeq: number, toSeq: number}}
 */
export function disabledOutcome(sessionId) {
  return { sessionId, queued: false, reason: SUMMARIZE_REASON.Disabled, fromSeq: 0, toSeq: 0 }
}

/**
 * The human-readable rendering of one outcome, shared by the command and the
 * Memory tab's button. English, because it is also the tool's model-facing text
 * (see {@link summarizeOutcomeValue}); the client localizes its own rendering
 * and falls back to the reason code, not to this sentence.
 *
 * @param {{sessionId: string, queued: boolean, reason: string, fromSeq: number, toSeq: number}} result
 * @returns {string}
 */
export function outcomeText(result) {
  if (result.queued) {
    return `Consolidation queued for ${result.sessionId} over events [${result.fromSeq}, ${result.toSeq}). `
      + 'The summary is written in the background on the plugin\'s own model route.'
  }
  switch (result.reason) {
    case SUMMARIZE_REASON.Empty:
      return `${result.sessionId} has nothing left to summarise: every logged event is already consolidated.`
    case SUMMARIZE_REASON.Busy:
      return `A consolidation covering [${result.fromSeq}, ${result.toSeq}) is already queued for ${result.sessionId}.`
    case SUMMARIZE_REASON.Disabled:
      return 'Consolidation is turned off (hypatia-auto-memory.consolidation.enabled).'
    case SUMMARIZE_REASON.Unavailable:
      return 'Consolidation is unavailable: no model route is mounted for it.'
    case SUMMARIZE_REASON.Unknown:
      return `No session "${result.sessionId}" is available to consolidate.`
    default:
      return `Consolidation was not queued (${result.reason}).`
  }
}

/**
 * The command's verdict on one outcome.
 *
 * "Nothing to do" and "already queued" are successes: the handler did its job
 * and the answer is truthful. Only a genuine refusal — the feature is off, no
 * route exists, the session is gone — is an error, which the composer renders
 * as one.
 *
 * @param {{sessionId: string, queued: boolean, reason: string, fromSeq: number, toSeq: number}} result
 * @returns {{kind: 'success', text: string} | {kind: 'error', text: string}}
 */
export function commandResult(result) {
  const text = outcomeText(result)
  if (result.queued) return { kind: 'success', text }
  if (result.reason === SUMMARIZE_REASON.Empty || result.reason === SUMMARIZE_REASON.Busy) {
    return { kind: 'success', text }
  }
  return { kind: 'error', text }
}

/**
 * The tool's canonical value for one outcome.
 *
 * Structured rather than prose-only so an agent can branch on `queued` and
 * `reason`; `message` carries the explanatory sentence for the common case.
 *
 * @param {{sessionId: string, queued: boolean, reason: string, fromSeq: number, toSeq: number}} result
 * @returns {{sessionId: string, queued: boolean, reason: string, fromSeq: number, toSeq: number, message: string}}
 */
export function summarizeOutcomeValue(result) {
  return { ...result, message: outcomeText(result) }
}

/**
 * The tool's `execute`, split from registration so it is unit-testable without
 * the DSH package graph.
 *
 * The calling session is the default and an explicit `sessionId` overrides it.
 * A call with neither is an error: guessing "the first session" or "the most
 * recent one" would consolidate a conversation nobody asked about.
 *
 * @param {{run: (sessionId: string) => Promise<any>}} deps
 * @returns {(args: {sessionId?: string}, exec: {agent?: {session: any}}) => Promise<any>}
 */
export function summarizeToolHandler({ run }) {
  return async (args, exec) => {
    const explicit = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
    const sessionId = explicit !== '' ? explicit : sessionIdOf(exec?.agent?.session)
    if (sessionId === '') {
      throw new Error('hypatia_summarize: no calling session is bound to this call; pass sessionId explicitly')
    }
    return summarizeOutcomeValue(await run(sessionId))
  }
}

/**
 * Register `/hypatia-summarize`.
 *
 * The handler never sends anything to the model — that is the registry's own
 * contract for `handler`, and the acceptance test for this face is that no
 * model call is logged.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - a `commands`-injected context.
 * @param {{run: (sessionId: string) => Promise<any>, status: import('./status.js').StatusLog}} deps
 */
export function registerSummarizeCommand(ctx, { run, status }) {
  ctx.effect(() => ctx.commands.register({
    definitionId: SUMMARIZE_DEFINITION_ID,
    name: SUMMARIZE_COMMAND,
    description: SUMMARIZE_COMMAND_DESCRIPTION,
    handler: async (invocation) => {
      const sessionId = sessionIdOf(invocation?.agent?.session)
      if (sessionId === '') {
        return { kind: 'error', text: 'hypatia-summarize: this invocation has no session to consolidate' }
      }
      return commandResult(await run(sessionId))
    },
  }), 'dsh-hypatia-auto-memory: /hypatia-summarize')
  status.info(`command registered: /${SUMMARIZE_COMMAND}`)
}

/**
 * Register the `hypatia_summarize` tool.
 *
 * `@deepseek-ai/dsh-tools` is imported lazily, like `@deepseek-ai/dsh-llm` in
 * the consolidator: the pure helpers above stay importable (and testable)
 * without the DSH package graph, and a composition that has no tool registry
 * never needs the package at all.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - a `tools`-injected context.
 * @param {{run: (sessionId: string) => Promise<any>, status: import('./status.js').StatusLog}} deps
 * @returns {Promise<void>} resolves once the definition is registered.
 */
export async function registerSummarizeTool(ctx, { run, status }) {
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  const definition = defineTool({
    name: SUMMARIZE_TOOL,
    description: SUMMARIZE_TOOL_DESCRIPTION,
    parameters: {
      sessionId: {
        type: 'string',
        description: 'Session id to summarise. Defaults to the session this call runs in.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          queued: { type: 'boolean', required: true },
          reason: {
            type: 'string',
            required: true,
            description: 'Empty when queued; otherwise disabled, empty, busy, unknown-session or unavailable.',
          },
          fromSeq: { type: 'number', required: true },
          toSeq: { type: 'number', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    execute: summarizeToolHandler({ run }),
  })
  ctx.effect(() => ctx.tools.register(definition), 'dsh-hypatia-auto-memory: hypatia_summarize tool')
  status.info(`tool registered: ${SUMMARIZE_TOOL}`)
}
