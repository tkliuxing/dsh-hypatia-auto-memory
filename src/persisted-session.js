/**
 * Read-only sessions for work whose session may never be opened again.
 *
 * A queued task resolves its session through the live store, and one whose
 * session is not loaded defers instead of failing — DSH loads sessions lazily,
 * so "not loaded yet" is ordinary. The catch is what ends the wait:
 * `session/created` is emitted only where an agent actually runs
 * (`sessions.enter`/`announce` in agent-loop), so a finished session may never
 * emit it again. Subagent sessions are the sharp case — the sidebar does not
 * list them at all. Measured on a live profile: a subagent's consolidation sat
 * `deferred` across a restart, and stayed deferred while its transcript was
 * open on screen, because opening a transcript renders persisted events without
 * publishing a Session.
 *
 * `sessionPersistence.open(id, 'read')` returns that same log without publishing
 * anything — the canonical read-only path, the one DSH's own `message-feedback`
 * uses — and the executors only ever use four members of a Session —
 * `snapshotEvents`, `inheritedEventCount`, `seq`, `header`. So storage can
 * serve them directly, and a tail nothing will reopen still becomes knowledge.
 *
 * The handle is the only correct entry point: the service exposes
 * `create`/`open`/`flush`/`stat`/`list` and nothing else. An earlier revision
 * called `persistence.load(id)`, which does not exist — the TypeError was
 * swallowed by this module's own read-failure guard, so EVERY unloaded session
 * resolved to "no session" and its queued consolidation stayed `deferred`
 * forever. A missing method looked exactly like a session that had never been
 * written, which is why the silent-defer bug survived so long.
 *
 * @module dsh-hypatia-auto-memory/persisted-session
 */

/** How many whole event logs may sit in memory at once. */
const DEFAULT_CACHE_SIZE = 4

/**
 * Wrap one `SessionInspection` (`{meta, inheritedEventCount, events}`) as the
 * read-only subset of `Session` the executors use.
 *
 * Ranges are seq-based, as in the live Session. The log is contiguous, so a
 * slice is enough — but it is taken against the FIRST event's seq rather than
 * array position, so a seeded or forked log (whose stored prefix need not start
 * at 0) still answers the same seq range the watermark asks for.
 *
 * @param {{meta?: any, inheritedEventCount?: number, events?: readonly any[]}} inspection
 * @returns {{header: any, inheritedEventCount: number, seq: number, snapshotEvents: (from?: number, to?: number) => readonly any[]} | undefined}
 */
export function toReadOnlySession(inspection) {
  const events = inspection?.events
  if (Array.isArray(events) === false) return undefined
  const base = events[0]?.seq ?? 0
  const end = base + events.length
  return {
    header: inspection.meta,
    inheritedEventCount: inspection.inheritedEventCount ?? 0,
    seq: end,
    snapshotEvents(from = base, to = end) {
      return events.slice(Math.max(0, from - base), Math.max(0, to - base))
    },
  }
}

/**
 * Resolve sessions from persistence, with a small bounded cache.
 *
 * A read failure is reported and treated as "no session": the caller then
 * defers exactly as before, which is the correct degradation — never a
 * half-consolidated span written from a partial log.
 *
 * @param {{
 *   persistence: {
 *     open: (id: string, access: 'read') => Promise<{
 *       header: any,
 *       inheritedEventCount?: number,
 *       read: (offset?: number, length?: number) => Promise<{events: readonly any[]}>,
 *       close: () => Promise<void>,
 *     }>,
 *   },
 *   status: import('./status.js').StatusLog,
 *   cacheSize?: number,
 * }} deps
 */
export function createPersistedSessions({ persistence, status, cacheSize = DEFAULT_CACHE_SIZE }) {
  /** @type {Map<string, any>} */
  const cache = new Map()

  return {
    /**
     * @param {string} sessionId
     * @returns {Promise<any | undefined>}
     */
    async get(sessionId) {
      const cached = cache.get(sessionId)
      if (cached !== undefined) return cached
      let session
      let handle
      try {
        handle = await persistence.open(sessionId, 'read')
        const { events } = await handle.read()
        session = toReadOnlySession({
          meta: handle.header,
          inheritedEventCount: handle.inheritedEventCount,
          events,
        })
      } catch (error) {
        // A read failure is reported and treated as "no session": the caller
        // then defers exactly as before, which is the correct degradation —
        // never a half-consolidated span written from a partial log.
        status.warn(`persisted session ${sessionId} could not be read: ${String(error)}`)
        return undefined
      } finally {
        // The read is done with the handle either way; a read handle holds
        // backend state (an open file, a lock) that must not leak per lookup.
        await handle?.close?.().catch(() => {})
      }
      if (session === undefined) return undefined
      cache.set(sessionId, session)
      // One entry is a whole event log; evict in insertion order.
      if (cache.size > cacheSize) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      return session
    },
    clear() {
      cache.clear()
    },
  }
}
