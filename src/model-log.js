/**
 * Durable, bounded record of the model attempts the background pipeline makes.
 *
 * Why this exists. The route one consolidation attempt runs on is chosen by a
 * process-local round-robin cursor (`createConsolidationRouteSelector`) and,
 * before this, was dropped the moment the call was made. "Which model actually
 * summarised that span?" was then unanswerable from outside the process: the
 * settings card shows the configured route LIST, the host logger goes to a
 * terminal that scrolls away, and the usage ledger only folds agent turns — it
 * cannot see a plugin's direct `llm.stream` call at all (see
 * `@linxin666/dsh-usage` `usage-service.ts`, which folds `assistant/message`).
 *
 * The record is written at SELECTION time and updated when the attempt settles,
 * so a row left at `pending` is itself evidence: the process died, or the
 * attempt is still in flight. That distinguishes the three states the cursor
 * alone cannot — selected, completed, and consumed-but-produced-nothing.
 *
 * It lives in its OWN storage domain rather than in the one holding watermarks
 * and queued tasks. In that domain a record failing its schema rejects the whole
 * open and silently disables the plugin (see the note on `taskTable` in
 * state.js); diagnostics must never be able to take the authoritative data down
 * with them. Here the blast radius is one bounded table nobody's correctness
 * depends on. `openModelLog` therefore degrades to a logger-only log when the
 * domain will not open, and callers keep working.
 *
 * @module dsh-hypatia-auto-memory/model-log
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** How many attempts to keep. A ring large enough to answer "the last run(s)". */
export const MODEL_CALL_LIMIT = 100

/**
 * One model attempt. `outcome` is the state that matters:
 *
 * - `pending`  — selected, not settled (in flight, or the process died).
 * - `ok`       — the call settled AND produced a usable result.
 * - `incomplete` — settled without one: output cap, abort, refusal, a reply
 *   that did not parse, or one that parsed into nothing usable. The cursor WAS
 *   consumed and nothing was stored. This is a deliberate catch-all: from
 *   outside, every one of those looks the same, and a caller that reported `ok`
 *   for a stop that yielded no summary would make the table lie.
 * - `error`    — the call itself threw (provider/transport failure).
 *
 * `detail` carries a finish kind, a fixed label, or a provider error message —
 * never message content and never model output. The plugin's whole log path is
 * built to keep conversation text out of places a later reader can stumble
 * into, and a `JSON.parse` failure is exactly where that leaks by accident:
 * Node quotes the offending input in the message (`Unexpected token 'H', "Here
 * is th"...`). Parse sites therefore record a fixed label, and `finish` caps
 * whatever it is handed, because a provider `failure.message` can carry a whole
 * HTTP body.
 */
export const modelCallTable = domainTable(z.object({
  /** Monotonic within the process; recovered from the stored rows on open. */
  seq: z.number().step(1).min(1),
  /** Epoch milliseconds at selection. */
  at: z.number().default(0),
  /** The `purpose` the call was made with ('memory-consolidation', …). */
  purpose: z.string().default(''),
  provider: z.string().default(''),
  model: z.string().default(''),
  outcome: z.string().default('pending'),
  /** Wall time from selection to settle; 0 while pending. */
  ms: z.number().min(0).default(0),
  detail: z.string().default(''),
}))

/** Upper bound on `detail`; see the table doc. Applied on every write. */
export const DETAIL_MAX = 200

/**
 * Diagnostics domain. Separate from `hypatia_auto_memory` on purpose (module
 * doc); its own version line, so the authoritative domain's format never has to
 * move for a table only a human reads.
 */
export const diagnosticsSpec = defineDomain({
  name: 'hypatia_auto_memory_diag',
  version: 1,
  // Table names must match /^[a-z][a-z0-9_]*$/ — the module-load guard rejects
  // camelCase before any medium is touched.
  tables: { model_calls: modelCallTable },
})

/**
 * Fixed-width key so lexicographic order equals sequence order. A bare numeric
 * key would be re-ordered by the JSON object it is stored in (integer-like keys
 * sort first, numerically), which is why ordering is carried by the padded key
 * AND by the `seq` field the reader sorts on.
 * @param {number} seq
 */
function keyOf(seq) {
  return String(seq).padStart(12, '0')
}

/**
 * The log a caller gets when none was injected (unit tests, a composition
 * without storage). Call sites default to it, so none of them branches on
 * observability being available.
 */
export const NULL_MODEL_LOG = Object.freeze({
  begin: () => ({ finish: async () => {} }),
  recent: () => [],
})

/**
 * @param {{
 *   table?: any,
 *   status: import('./status.js').StatusLog,
 *   limit?: number,
 *   now?: () => number,
 * }} deps - `table` absent (or the domain failed to open) means: log lines
 * still happen, nothing is stored, and no caller has to branch.
 */
export function createModelLog({ table, status, limit = MODEL_CALL_LIMIT, now = Date.now }) {
  let counter = 0
  if (table !== undefined) {
    // Every stored row passed the schema at open, so `seq` is always the number
    // the padded key was derived from.
    for (const [, row] of table.entries()) {
      if (row.seq > counter) counter = row.seq
    }
  }

  function onWriteError(error) {
    status.warn(`model-call log write failed: ${String(error)}`)
  }

  /** Keep the newest `limit` rows; drop the rest oldest-first. */
  async function prune() {
    while (table.size > limit) {
      let oldest
      for (const [key, row] of table.entries()) {
        if (oldest === undefined || row.seq < oldest.row.seq) oldest = { key, row }
      }
      if (oldest === undefined) return
      await table.delete(oldest.key)
    }
  }

  async function write(key, record) {
    try {
      await table.put(key, record)
      await prune()
    } catch (error) {
      onWriteError(error)
    }
  }

  /**
   * Record one attempt as it is selected, before the call is made.
   *
   * @param {string} purpose - The same string handed to `llm.stream`.
   * @param {{provider: string, model: string}} route
   * @returns {{seq: number, finish: (outcome: string, detail?: string) => Promise<void>}}
   */
  function begin(purpose, route) {
    counter += 1
    const seq = counter
    const at = now()
    const key = keyOf(seq)
    const record = {
      seq,
      at,
      purpose,
      provider: String(route?.provider ?? ''),
      model: String(route?.model ?? ''),
      outcome: 'pending',
      ms: 0,
      detail: '',
    }
    // Durable before the call runs, so an attempt that never settles still
    // leaves a row. Awaited by `finish`, never by the caller.
    const stored = table === undefined ? Promise.resolve() : write(key, record)
    return {
      seq,
      async finish(outcome, detail = '') {
        // Never rejects, and callers do not await it: every one of them calls
        // this from a `finally`, where a throw here would replace the error the
        // queue was going to see, and a storage stall would hold the queue task
        // open after its own timeout has already been cleared.
        try {
          await stored
          const ms = Math.max(0, now() - at)
          const bounded = String(detail).slice(0, DETAIL_MAX)
          if (table !== undefined) {
            await write(key, { ...record, outcome, ms, detail: bounded })
          }
          const suffix = bounded === '' ? '' : ` (${bounded})`
          status.info(`model call: ${purpose} ${record.provider}/${record.model} ${outcome} ${ms}ms${suffix}`)
        } catch (error) {
          onWriteError(error)
        }
      },
    }
  }

  /** Newest-first snapshot, for a human reading the state file or a card. */
  function recent(count = 20) {
    if (table === undefined) return []
    return [...table.entries()]
      .map(([, row]) => row)
      .sort((a, b) => Number(b?.seq) - Number(a?.seq))
      .slice(0, count)
  }

  return { begin, recent }
}

/**
 * Open the diagnostics domain and build the log. Never throws: a domain that
 * will not open costs the stored history, not the memory pipeline.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - context injecting `storageDomain`.
 * @param {{status: import('./status.js').StatusLog, limit?: number, now?: () => number}} deps
 * @returns {Promise<{modelLog: ReturnType<typeof createModelLog>, domain?: any}>}
 * `domain` is the open handle when there is one, so a caller that finds itself
 * disposed can close it (mirrors `openState`).
 */
export async function openModelLog(ctx, { status, limit, now }) {
  let domain
  try {
    domain = await ctx.storageDomain.open(diagnosticsSpec)
  } catch (error) {
    status.warn(`model-call log unavailable, attempts will only be logged: ${String(error)}`)
    return { modelLog: createModelLog({ status, limit, now }) }
  }
  try {
    ctx.effect(() => () => {
      void domain.close().catch(() => {
        // Closing during teardown must never take the fiber down.
      })
    }, 'hypatia-auto-memory: close diagnostics domain')
  } catch {
    // The fiber went away while the domain was opening, so no disposer will
    // ever run for it — closing here is the only thing that prevents a leak.
    // Deliberately silent: the plugin is being torn down, and a warning about
    // an unavailable log would be noise at exactly the moment nothing can act
    // on it.
    await domain.close().catch(() => {})
    return { modelLog: createModelLog({ status, limit, now }) }
  }
  return { modelLog: createModelLog({ table: domain.table('model_calls'), status, limit, now }), domain }
}
