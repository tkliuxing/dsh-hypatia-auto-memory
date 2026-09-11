/**
 * Durable state for dsh-hypatia-auto-memory: one storageDomain domain with a
 * per-session progress watermark table and a task table. Reads are synchronous
 * from in-memory state, writes resolve only after the backend acknowledges
 * durability, so the queue never acknowledges work that a crash could lose.
 *
 * @module dsh-hypatia-auto-memory/state
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export { EMPTY_PROGRESS, advanceProgress } from './progress.js'

/** Per-session watermark: how far logging and consolidation have advanced. */
export const progressTable = domainTable(z.object({
  /** Last session-log seq written to hypatia as a msg-* entry. */
  lastLoggedSeq: z.number().step(1).min(0).default(0),
  /** Last session-log seq covered by a consolidation run. */
  lastConsolidatedSeq: z.number().step(1).min(0).default(0),
  /** Turn when consolidation work was last durably accepted by the queue. */
  lastCheckTurn: z.number().step(1).min(0).default(0),
  /** Estimated unconsolidated tokens accumulated since that accepted task. */
  pendingTokens: z.number().min(0).default(0),
  /**
   * 1 once a `session-<id>` entry exists. The protocol builds that node from a
   * host-supplied session summary (a title, or a compaction summary) and
   * forbids inventing one, so most sessions never grow it — the flag is what
   * lets the log path skip the `belongTo` work rather than probing hypatia for
   * an entry that will not be there.
   */
  hasSessionNode: z.number().step(1).min(0).max(1).default(0),
  /** Message ordinal up to which `belongTo` edges have been asserted. */
  lastBelongToIndex: z.number().step(1).min(0).default(0),
}))

/**
 * One queued unit of work. `kind` is code-validated ('log-message' |
 * 'consolidate' | 'cascade' | 'session-node'); keeping it a plain string here
 * avoids schema-enum drift with the storage format. Tasks store seq ranges
 * only — content is always re-read from the authoritative session log at
 * execution time, never duplicated here.
 */
export const taskTable = domainTable(z.object({
  kind: z.string(),
  sessionId: z.string(),
  /** Half-open [fromSeq, toSeq) session-log range this task covers. */
  fromSeq: z.number().step(1).min(0),
  toSeq: z.number().step(1).min(0),
  /** Project scope the entries are written under. */
  project: z.string().default(''),
  /** pending | running | failed (done tasks are deleted). */
  status: z.string().default('pending'),
  attempts: z.number().step(1).min(0).default(0),
  // zod requires explicit nullability for fields that legacy deployments may
  // already hold as null; these records are disposable queue state.
  error: z.string().nullable(),
  enqueuedAt: z.number().default(0),
}))

/** The plugin's whole durable surface: two tables, versioned together.
 * Domain names must match /^[a-z][a-z0-9_]*$/ — underscores, not hyphens. */
export const domainSpec = defineDomain({
  name: 'hypatia_auto_memory',
  version: 1,
  tables: { progress: progressTable, tasks: taskTable },
})

/**
 * Open the plugin domain through the storageDomain service and wire its
 * lifecycle to the calling fiber.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - context injecting `storageDomain`.
 * @returns {Promise<{progress: any, tasks: any, close: () => Promise<void>}>}
 */
export async function openState(ctx) {
  const domain = await ctx.storageDomain.open(domainSpec)
  ctx.effect(() => () => {
    void domain.close().catch(() => {
      // Closing during teardown must never take the fiber down.
    })
  }, 'hypatia-auto-memory: close state domain')
  return { progress: domain.table('progress'), tasks: domain.table('tasks'), domain }
}
