/**
 * Reasoning-effort resolution: which `reasoningEffort` one model call sends.
 *
 * Why this is its own module. Three call sites need the same answer — span
 * extraction and adjudication in consolidator.js, and the archive call in
 * cascade.js — and the answer is the same shape of question for all three:
 * "what did the route's configuration ask for, and does this route actually
 * declare it?" Duplicating the capability lookup would also duplicate its cache
 * and its warnings, so `createReasoningResolver` is built once (index.js) and
 * handed to both executors.
 *
 * Two layers, deliberately separate:
 *
 * - `resolveReasoningEffort` is PURE: configuration + the route's advertised
 *   metadata + the call's purpose in, one decision out. It is the whole policy,
 *   so it is unit-testable without an `llm` double.
 * - `createReasoningResolver` is the impure half: it asks the adapter
 *   (`llm.resolveModelInfo`), memoizes per route, and reports the one thing the
 *   pure half cannot — that a configured effort was DROPPED.
 *
 * ## Why an effort is dropped rather than sent
 *
 * The core LLM layer rejects an effort the route does not declare, before any
 * provider I/O, with `UNSUPPORTED_REASONING_EFFORT` and no clamping or aliasing
 * (see `resolveCallWithInfo` in `@deepseek-ai/dsh-llm`). A typo in the profile
 * would otherwise become a queue task that retries and then fails permanently,
 * so an unverifiable or undeclared effort is omitted — the call still runs on
 * the provider's own default. That silence is exactly why the attempt record
 * carries the effort that was actually sent (see model-log.js): a dropped value
 * would otherwise be indistinguishable from one that was honoured.
 *
 * @module dsh-hypatia-auto-memory/reasoning
 */

/**
 * The effort id that means "do not reason". Adapters spell their other levels
 * however they like — the vocabulary is adapter-owned and opaque — but the one
 * value this plugin reasons about by name is `off`.
 */
export const THINKING_OFF_EFFORT = 'off'

/**
 * Purposes that ask for no reasoning when the route's configuration is silent.
 *
 * Both are mechanical transforms into a fixed output shape: extraction fills a
 * JSON skeleton, adjudication picks one of six labels for two short texts.
 * Reasoning spends the SAME `maxOutputTokens` cap as the answer, so on a route
 * that resolves an omitted effort to `high` these calls used to hit `max-tokens`
 * with the answer half written (see `ADJUDICATION_MAX_TOKENS` and
 * `THINKING_OUTPUT_ALLOWANCE` in consolidator.js).
 *
 * The archive call is deliberately NOT here: compressing sixteen summaries is
 * semantic work, not a transform, so it leaves the choice to the adapter.
 */
const THINKING_OFF_PURPOSES = Object.freeze(['memory-consolidation', 'memory-adjudication'])

/**
 * Decide one call's reasoning effort.
 *
 * Pure. The rule, in the order it is applied:
 *
 * 1. A configured value is a user instruction, so it wins even over the purpose
 *    policy below. If the route does not declare it, it is refused (`refused`
 *    is set) rather than passed through to a guaranteed core rejection.
 * 2. With no configured value, only the purposes in {@link THINKING_OFF_PURPOSES}
 *    ask for anything, and only where the route advertises `off`. A route that
 *    cannot stop thinking is not asked twice, and this case is silent: it is the
 *    plugin's own preference, not something the user asked for.
 * 3. Otherwise nothing is sent, which leaves the adapter's configured default
 *    materialized by the core (or the provider's own default).
 *
 * @param {{
 *   purpose: string,
 *   configured?: string,
 *   reasoning?: {efforts?: readonly {id?: string}[]} | undefined,
 * }} input - `reasoning` is the adapter metadata for this exact route; absent
 * (or without `efforts`) means the route declares no reasoning control at all.
 * @returns {{effort?: string, refused?: string}} `effort` is what to send, or
 * nothing to send at all; `refused` names the configured value that could not be
 * honoured, and is set ONLY for a configured value — the caller warns on it.
 */
export function resolveReasoningEffort({ purpose, configured, reasoning }) {
  const requested = typeof configured === 'string' ? configured.trim() : ''
  const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []
  const advertised = new Set(
    efforts.map((effort) => effort?.id).filter((id) => typeof id === 'string'),
  )

  if (requested !== '') {
    return advertised.has(requested) ? { effort: requested } : { refused: requested }
  }
  if (!THINKING_OFF_PURPOSES.includes(purpose)) return {}
  return advertised.has(THINKING_OFF_EFFORT) ? { effort: THINKING_OFF_EFFORT } : {}
}

/** Human-readable route, for warnings. */
function routeLabel(route) {
  return `${String(route?.provider ?? '')}/${String(route?.model ?? '')}`
}

/** Advertised ids in the adapter's own order, for warnings. */
function advertisedList(reasoning) {
  const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []
  return efforts.map((effort) => effort?.id).filter((id) => typeof id === 'string')
}

/**
 * The impure half: adapter capability lookup, memoized, plus the warnings the
 * pure decision cannot emit.
 *
 * @param {{
 *   llm: any,
 *   status: import('./status.js').StatusLog,
 * }} deps - `llm.resolveModelInfo` is optional: a composition (or a test double)
 * without it simply cannot verify anything, which drops a configured effort
 * instead of sending a value the core may reject.
 * @returns {{
 *   capability: (route: any, signal?: AbortSignal) => Promise<{reasoning: any, verified: boolean, failure: string}>,
 *   effort: (route: any, purpose: string, signal?: AbortSignal) => Promise<string | undefined>,
 * }}
 */
export function createReasoningResolver({ llm, status }) {
  /** Per-route adapter metadata; capability does not change while an instance lives. */
  const capabilities = new Map()
  /** Messages already emitted, so a warning is not repeated per call. */
  const reported = new Set()

  function warnOnce(key, message) {
    if (reported.has(key)) return
    reported.add(key)
    status.warn(message)
  }

  /**
   * The adapter's reasoning metadata for one route.
   *
   * Never warns: `effort` knows whether a configured value is at stake, and one
   * event deserves one message. Returns `failure` (the lookup's error text) so
   * that message can say WHY the value was dropped.
   *
   * @returns {Promise<{reasoning: any, verified: boolean, failure: string}>}
   * `verified` is false when the capability could not be read at all — either
   * the lookup threw, or this composition has no `resolveModelInfo`.
   */
  async function capability(route, signal) {
    const key = `${route?.provider ?? ''}\0${route?.model ?? ''}`
    const cached = capabilities.get(key)
    if (cached !== undefined) return cached

    let result
    if (typeof llm?.resolveModelInfo !== 'function') {
      // Nothing to ask. Not an error: the plugin's own policy needs no
      // capability answer, it just omits the control (which is what every call
      // did before the lookup existed).
      result = { reasoning: undefined, verified: false, failure: '' }
    } else {
      try {
        const info = await llm.resolveModelInfo(route.provider, route.model, signal)
        result = { reasoning: info?.reasoning, verified: true, failure: '' }
      } catch (error) {
        // A route whose capability cannot be read is treated as one that
        // declares nothing, so the call proceeds without the control.
        result = { reasoning: undefined, verified: false, failure: String(error) }
      }
    }
    capabilities.set(key, result)
    return result
  }

  /**
   * The effort to send for one call, or `undefined` to send none.
   *
   * Exactly one warning per distinct event: a CONFIGURED effort that could not
   * be used (naming the value and the reason), or — when nothing was configured
   * — a capability lookup that failed, which means the purpose policy silently
   * stopped applying to that route.
   */
  async function effort(route, purpose, signal) {
    const { reasoning, verified, failure } = await capability(route, signal)
    const resolved = resolveReasoningEffort({ purpose, configured: route?.reasoningEffort, reasoning })

    if (resolved.refused === undefined) {
      if (failure !== '') {
        warnOnce(
          `${route?.provider ?? ''}\0${route?.model ?? ''}\0lookup`,
          `reasoning capability lookup failed for ${routeLabel(route)}: ${failure}`,
        )
      }
      return resolved.effort
    }

    const advertised = advertisedList(reasoning)
    const detail = failure !== ''
      ? `its reasoning capability could not be read (${failure})`
      : !verified
        ? 'this composition cannot report a route\'s reasoning capability'
        : advertised.length === 0
          ? 'it declares no reasoning efforts'
          : `it declares ${advertised.join(', ')}`
    warnOnce(
      `${route?.provider ?? ''}\0${route?.model ?? ''}\0${resolved.refused}`,
      `ignoring reasoningEffort "${resolved.refused}" for ${routeLabel(route)}: ${detail}; `
      + 'the call runs without an explicit effort',
    )
    return undefined
  }

  return { capability, effort }
}
