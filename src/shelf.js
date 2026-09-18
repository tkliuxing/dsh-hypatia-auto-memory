/**
 * The shelf auto-memory writes to, and what follows from being able to change it.
 *
 * Every hypatia call the plugin makes targets one shelf, read from
 * `hypatia-auto-memory.shelf` at startup. It is a startup setting — like
 * `enabled` — because a queue already holding work for one shelf must not
 * carry it into another halfway through.
 *
 * Changing it is a switch, not a migration. The progress and task tables are
 * this plugin's record of how far each session was written *into a shelf*, so
 * they are kept per shelf: switching to a new shelf starts its sessions from
 * zero there, and switching back resumes exactly where the old shelf's
 * watermarks stopped — nothing is re-logged or re-consolidated into a shelf
 * that already has it. Rows of the `default` shelf keep their original,
 * unprefixed keys, so a profile that never changes the setting reads the
 * tables exactly as before.
 *
 * @module dsh-hypatia-auto-memory/shelf
 */

/** Shelf hypatia itself falls back to when no `--shelf` is given. */
export const DEFAULT_SHELF = 'default'

/**
 * Key prefix of a non-default shelf's rows. Legacy keys are session ids and
 * `<kind>:<sessionId>` task ids, neither of which can start with `@`.
 */
const PREFIX = '@shelf/'

function prefixFor(shelf) {
  return shelf === DEFAULT_SHELF ? '' : `${PREFIX}${encodeURIComponent(shelf)}/`
}

/**
 * A storage-domain table narrowed to one shelf's rows.
 *
 * Exposes the subset of the table API this plugin uses (`get`, `put`,
 * `update`, `delete`, `entries`) with keys as callers know them. Create ONE
 * view per table and share it: `advanceProgress` chains writes per table
 * object, and two views of one table would not see each other's chain.
 *
 * @param {any} table - storage-domain table.
 * @param {string} shelf - shelf whose rows the view reads and writes.
 */
export function shelfTable(table, shelf) {
  const prefix = prefixFor(shelf)
  const own = (key) => (prefix === '' ? !key.startsWith(PREFIX) : key.startsWith(prefix))
  return {
    get: (key) => table.get(prefix + key),
    put: (key, value) => table.put(prefix + key, value),
    update: (key, fn) => table.update(prefix + key, fn),
    delete: (key) => table.delete(prefix + key),
    * entries() {
      for (const [key, value] of table.entries()) {
        if (own(key)) yield [key.slice(prefix.length), value]
      }
    },
  }
}

/**
 * Parse `hypatia list`.
 *
 * The CLI prints one aligned row per registered shelf —
 * `  <name>  <path>  [connected]` — or `No shelves registered.`. A name has no
 * spaces (it is one clap argument), while a path may, so the name is the first
 * token, the status the last, and the path everything between.
 *
 * @param {string} stdout
 * @returns {{name: string, path: string, connected: boolean}[]}
 */
export function parseShelfList(stdout) {
  const shelves = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\S+)\s+(.*?)\s+\[(connected|disconnected)\]\s*$/.exec(line)
    if (match === null) continue
    shelves.push({ name: match[1], path: match[2], connected: match[3] === 'connected' })
  }
  return shelves
}

/** How often the Host re-reads `hypatia list` for the settings card. */
const INVENTORY_INTERVAL_MS = 60_000

/**
 * Publish `hypatia list` to the settings card through the read-only
 * inventory namespace (see `INVENTORY_NAMESPACE` in config.js).
 *
 * The namespace is owned by a child fiber whose composition layer IS the
 * listing, so publishing a new listing means disposing that fiber and
 * registering again. That only happens when the listing changed; an unchanged
 * poll spawns one CLI call and nothing else. A failed listing keeps the last
 * shelves it had and says why, so the card can tell "no shelves" from "could
 * not ask".
 *
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   cli: { listShelves: () => Promise<{name: string, path: string, connected: boolean}[]> },
 *   status: import('./status.js').StatusLog,
 *   namespace: string,
 *   schema: any,
 *   label: string,
 *   intervalMs?: number,
 *   now?: () => number,
 * }} deps
 * @returns {{refresh: () => Promise<{shelves: any[], error: string}>}}
 */
export function publishShelfInventory({ ctx, cli, status, namespace, schema, label, intervalMs = INVENTORY_INTERVAL_MS, now = Date.now }) {
  let fiber
  let published = ''
  let listing = { shelves: [], error: '' }
  let chain = Promise.resolve()
  let stopped = false
  // A failure that repeats every poll is logged once, not once a minute.
  let publishError = ''
  const publishFailed = (error) => {
    const message = String(error)
    if (message !== publishError) status.warn(`shelf inventory not published: ${message}`)
    publishError = message
  }

  async function publish() {
    let next
    try {
      next = { shelves: await cli.listShelves(), error: '' }
    } catch (error) {
      next = { shelves: listing.shelves, error: error instanceof Error ? error.message : String(error) }
    }
    if (stopped) return listing
    if (next.error !== '' && next.error !== listing.error) status.warn(`shelf listing failed: ${next.error}`)
    listing = next
    const key = JSON.stringify(next)
    if (key === published) return listing
    // Claimed up front so an overlapping poll does not publish twice; given
    // back on any failure below, so the next poll retries the same listing.
    published = key
    const base = { ...next, listedAt: now() }
    try {
      const previous = fiber
      fiber = undefined
      await previous?.dispose()
      // The profile may be unloading: the parent fiber refuses new children
      // before the effect that sets `stopped` has run.
      if (stopped) return listing
      fiber = ctx.plugin({
        name: `${label}/shelf-inventory`,
        inject: ['settings'],
        apply: (c) => {
          try {
            c.settings.register(namespace, schema, { base })
            publishError = ''
          } catch (error) {
            published = ''
            publishFailed(error)
          }
        },
      })
    } catch (error) {
      published = ''
      if (!stopped) publishFailed(error)
    }
    return listing
  }

  /** Serialized; never rejects, so callers may drop the promise. */
  function refresh() {
    const next = chain.then(publish, publish).catch(() => listing)
    chain = next
    return next
  }

  const timer = setInterval(() => { void refresh() }, intervalMs)
  timer.unref?.()
  ctx.effect(() => () => {
    stopped = true
    clearInterval(timer)
  }, `${label}: stop shelf inventory`)

  return { refresh }
}
