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

// The shelf listing the settings card offers is served by the Memory tab's
// HTTP route family (see `fetchShelves` in memory-api.js). Until dsh 0.1.7 it
// rode a read-only settings namespace, but the settings overhaul removed the
// Host-side `settings.register` API that made that possible, and a dynamic
// listing was never configuration anyway.
