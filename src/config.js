/**
 * Settings namespace and live configuration for dsh-hypatia-auto-memory.
 *
 * All user-facing behavior knobs live in the `hypatia-auto-memory` settings
 * namespace so they are editable through settings.yaml / Web settings and
 * hot-updatable through the settings provider. The cordis `config` block on
 * the bundle row only carries skill-packaging knobs (see index.js).
 *
 * @module dsh-hypatia-auto-memory/config
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace carrying the auto-memory policy. */
export const SETTINGS_NAMESPACE = 'hypatia-auto-memory'

/** Composition defaults; every schema field mirrors one of these. */
export const DEFAULTS = {
  enabled: true,
  binaries: ['hypatia'],
  // How the plugin itself talks to hypatia: a private `hypatia mcp` process,
  // or one CLI command per call. A binary without `mcp` falls back to the CLI
  // on its own (see hypatia-client.js). Applies from the next call.
  transport: 'mcp',
  // Where every entry this plugin writes — and every lookup it makes — goes.
  // Read at startup, like `enabled`: see shelf.js for what a switch does.
  shelf: 'default',
  // Approve the AGENT's own `hypatia …` bash calls (retrieval, explicit
  // remember/forget). This plugin's own writes never need it — they go over
  // its own connection, never through a tool call. Read at startup, like `enabled`.
  autoApprove: true,
  collector: {
    enabled: true,
    maxAssistantChars: 8000,
    // User messages were never capped, so a pasted log went into hypatia whole.
    // Generous, because what the user typed is the part most worth keeping.
    maxUserChars: 32000,
    toolLedger: true,
  },
  consolidation: {
    enabled: true,
    models: [],
    maxInputTokens: 16000,
    maxOutputTokens: 2000,
    timeoutMs: 120_000,
    checkEveryTurns: 5,
    minNewTokens: 3000,
    maxWorkUnitsPerRun: 3,
    // Work-unit relationship adjudication. `dedupMaxDistance` is a cosine
    // distance ceiling on candidates worth judging at all; anything further
    // away is not a relative, and asking about it only invites a wrong edge.
    adjudicate: true,
    dedupMaxDistance: 0.45,
    dedupCandidates: 5,
    // Hierarchical archive. 16:1 per tier is the protocol's constant; it is what
    // makes the summary layer log₁₆(n) deep instead of growing with the
    // conversation.
    cascade: {
      enabled: true,
      batchSize: 16,
    },
  },
  queue: {
    concurrency: 1,
    maxAttempts: 3,
    retryDelayMs: 5000,
    flushWindowMs: 120_000,
  },
  // Recall is a session seed, not a per-turn injector: the agent pulls the rest
  // through the bundled skill. `maxEntries` / `maxCharsPerEntry` belonged to the
  // removed per-turn path and would now be knobs that control nothing.
  recall: {
    enabled: true,
    preloadRulesTaboos: true,
  },
  // Startup housekeeping of the progress table (see housekeeping.js). Both act
  // only on positive evidence and skip on any doubt.
  housekeeping: {
    // Reset a row whose session has no msg-* entry left in the shelf (a wiped
    // or replaced shelf). A session whose messages were all deleted on purpose
    // looks the same and would be logged again — switch off if that matters.
    reconcileOnStartup: true,
    // Drop the row and tasks of a session DSH no longer has.
    pruneVanishedSessions: true,
    // Consolidate a logged tail the in-session trigger never reached. A process
    // restart takes the session-end path with it, so a short session would
    // otherwise stay logged-but-never-distilled. Gated by the same
    // `consolidation.minNewTokens` floor, read from the progress row.
    backfillConsolidation: true,
  },
}

/** Exact LLM route eligible for one consolidation attempt. */
const ConsolidationModelSchema = z.object({
  provider: z.string(),
  model: z.string(),
})

/** Schema of the auto-memory settings section. */
export const SettingsSchema = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  binaries: z.array(z.string()).default(DEFAULTS.binaries),
  transport: z.union(['mcp', 'cli']).default(DEFAULTS.transport),
  shelf: z.string().default(DEFAULTS.shelf),
  autoApprove: z.boolean().default(DEFAULTS.autoApprove),
  collector: z.object({
    enabled: z.boolean().default(DEFAULTS.collector.enabled),
    maxAssistantChars: z.number().step(1).min(500).default(DEFAULTS.collector.maxAssistantChars),
    maxUserChars: z.number().step(1).min(500).default(DEFAULTS.collector.maxUserChars),
    toolLedger: z.boolean().default(DEFAULTS.collector.toolLedger),
  }).default(DEFAULTS.collector),
  consolidation: z.object({
    enabled: z.boolean().default(DEFAULTS.consolidation.enabled),
    models: z.array(ConsolidationModelSchema).default(DEFAULTS.consolidation.models),
    maxInputTokens: z.number().step(1).min(1000).default(DEFAULTS.consolidation.maxInputTokens),
    maxOutputTokens: z.number().step(1).min(200).default(DEFAULTS.consolidation.maxOutputTokens),
    timeoutMs: z.number().step(1).min(1000).max(3_600_000).default(DEFAULTS.consolidation.timeoutMs),
    checkEveryTurns: z.number().step(1).min(1).default(DEFAULTS.consolidation.checkEveryTurns),
    minNewTokens: z.number().step(1).min(500).default(DEFAULTS.consolidation.minNewTokens),
    maxWorkUnitsPerRun: z.number().step(1).min(1).max(10).default(DEFAULTS.consolidation.maxWorkUnitsPerRun),
    adjudicate: z.boolean().default(DEFAULTS.consolidation.adjudicate),
    dedupMaxDistance: z.number().min(0).max(2).default(DEFAULTS.consolidation.dedupMaxDistance),
    dedupCandidates: z.number().step(1).min(1).max(20).default(DEFAULTS.consolidation.dedupCandidates),
    cascade: z.object({
      enabled: z.boolean().default(DEFAULTS.consolidation.cascade.enabled),
      batchSize: z.number().step(1).min(2).max(64).default(DEFAULTS.consolidation.cascade.batchSize),
    }).default(DEFAULTS.consolidation.cascade),
  }).default(DEFAULTS.consolidation),
  queue: z.object({
    concurrency: z.number().step(1).min(1).max(8).default(DEFAULTS.queue.concurrency),
    maxAttempts: z.number().step(1).min(1).max(10).default(DEFAULTS.queue.maxAttempts),
    retryDelayMs: z.number().step(1).min(100).default(DEFAULTS.queue.retryDelayMs),
    flushWindowMs: z.number().step(1).min(0).max(600_000).default(DEFAULTS.queue.flushWindowMs),
  }).default(DEFAULTS.queue),
  recall: z.object({
    enabled: z.boolean().default(DEFAULTS.recall.enabled),
    preloadRulesTaboos: z.boolean().default(DEFAULTS.recall.preloadRulesTaboos),
  }).default(DEFAULTS.recall),
  housekeeping: z.object({
    reconcileOnStartup: z.boolean().default(DEFAULTS.housekeeping.reconcileOnStartup),
    pruneVanishedSessions: z.boolean().default(DEFAULTS.housekeeping.pruneVanishedSessions),
    backfillConsolidation: z.boolean().default(DEFAULTS.housekeeping.backfillConsolidation),
  }).default(DEFAULTS.housekeeping),
})

/**
 * Read-only namespace publishing the shelves `hypatia list` reports, so the
 * settings card can offer them as choices. The browser cannot run the CLI, and
 * a settings descriptor is the one Host-owned value this plugin can put on the
 * wire. Nothing is ever written to it: the Host re-registers it with a fresh
 * composition layer (`base`) whenever the listing changes, and no card claims
 * the namespace, so it renders nowhere.
 */
export const INVENTORY_NAMESPACE = 'hypatia-auto-memory-shelves'

/** Schema of the shelf inventory; `error` is set when the listing failed. */
export const InventorySchema = z.object({
  shelves: z.array(z.object({
    name: z.string(),
    path: z.string(),
    connected: z.boolean(),
  })).default([]),
  error: z.string().default(''),
  listedAt: z.number().default(0),
})

/**
 * Validate the route list before its consumer sees it. An empty list is valid:
 * logging continues while consolidation stays idle until the user selects one
 * or more catalog routes.
 */
function validateSettings(value) {
  // One argv element to hypatia, and the name `hypatia list` prints: a blank
  // or padded name would silently address a shelf that does not exist.
  if (value.shelf === '' || /\s/.test(value.shelf)) {
    throw new Error('hypatia-auto-memory: shelf must be a non-empty name without whitespace')
  }
  const seen = new Set()
  for (const route of value.consolidation.models) {
    if (route.provider.trim() === '' || route.model.trim() === '') {
      throw new Error('hypatia-auto-memory: every consolidation model route needs a provider and model')
    }
    const key = `${route.provider}\0${route.model}`
    if (seen.has(key)) {
      throw new Error(`hypatia-auto-memory: duplicate consolidation model route ${route.provider}/${route.model}`)
    }
    seen.add(key)
  }
}

/**
 * Attach this plugin's settings section to the provider (when present) and
 * return a live config handle. Reads through the returned `get()` always see
 * the currently authoritative value; `onChange` fires on attach, detach, and
 * every committed change.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - settings-consuming context.
 * @returns {{get: () => any, onChange: (cb: (value: any) => void) => () => void}}
 */
export function installConfig(ctx) {
  let source = () => DEFAULTS
  const listeners = new Set()
  ctx.settings.installSection(ctx, SETTINGS_NAMESPACE, SettingsSchema, DEFAULTS, {
    validate: validateSettings,
    setSource: (current) => {
      source = current
    },
    onChange: () => {
      for (const cb of listeners) {
        try {
          cb(source())
        } catch {
          // A status listener must never break settings application.
        }
      }
    },
  })
  return {
    get: () => source(),
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
