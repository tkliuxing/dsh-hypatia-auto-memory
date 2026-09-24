/**
 * The Memory tab's read-only HTTP route family.
 *
 * Why a route and not a settings namespace. The tab needs two different things
 * from the Host: a small per-session status that changes whenever a task
 * settles, and the session's distilled memory (`sum-*` span summaries and the
 * `wu-*` units derived from them), which is read out of the hypatia CLI on
 * demand. A settings namespace can serve neither well — it is root-scoped (the
 * Host cannot know which session the browser is showing, so it would have to
 * ship every session's data), and publishing to it means disposing and
 * re-creating the owning fiber, because `settings.register` refuses a duplicate
 * namespace and offers no way to update a registered `base`. A session-scoped
 * HTTP route is parameterized and on demand, which is what this needs.
 *
 * The pattern is `dsh-hypatia-ui`'s: one `prefix` route owns the whole family so
 * the plugin claims exactly one pathname and cannot collide with a sibling over
 * individual paths.
 *
 * ## This route is not authenticated — it authenticates itself
 *
 * The shipped `dsh web` composition authenticates its own API routes; a route a
 * plugin registers is not one of them (see `dsh-hypatia-ui`'s `host/http.ts`,
 * which reaches the same CLI and states the same reasoning). These routes reach
 * the `hypatia` CLI, so the boundary is enforced here:
 *
 * - the connecting socket must be loopback,
 * - the `Host` the browser addressed must be a loopback name, and
 * - the request must be same-origin with that authority.
 *
 * A browser tab on the DSH page passes all three. A page on another origin fails
 * the third check even from the same machine, so a drive-by `fetch` cannot reach
 * the shelf. The `Host` check is what stops DNS rebinding: a rebound page is
 * same-origin with its own attacker-chosen name (Origin and Host agree), and
 * arrives over a loopback socket, but that name is not a loopback one. The
 * `Origin` / `sec-fetch-site` reading is a browser signal and not an authority
 * claim; the loopback socket is what actually bounds reachability, and the other
 * two narrow it to this page.
 *
 * ## What it will not return
 *
 * Summaries and work units are distilled knowledge, so their bodies are served —
 * that is the point of the tab. Raw `msg-*` entries are not: they hold the
 * conversation verbatim, the user just wrote them, and the agent is the right
 * reader for them. Status carries watermarks, counters and failure labels only.
 *
 * @module dsh-hypatia-auto-memory/memory-api
 */

import { isIPv4, isIPv6 } from 'node:net'
import { sessionView } from './memory-status.js'

/** Route prefix this plugin claims on the DSH web server. */
export const MEMORY_API_PREFIX = '/api/dsh-hypatia-auto-memory'

/** Span summaries served for one session, newest first. */
export const MAX_SUMMARIES = 40

/** Work units served for one session, newest first. */
export const MAX_WORK_UNITS = 40

/**
 * Rows one content query may scan. JSE has no ORDER BY, so "newest first" can
 * only be decided after reading every candidate; this bounds that read. A
 * session that reaches it reports its counts as lower bounds (`truncated`).
 */
export const SCAN_LIMIT = 1000

/** Cap on one entry's body, so one long summary cannot dominate the response. */
export const BODY_MAX_CHARS = 4000

/** Cap on every body in one response, oldest dropped first. */
export const CONTENT_BUDGET_CHARS = 120_000

/**
 * How long a session's content is reused before the CLI is asked again. Content
 * only changes when consolidation runs, and the tab polls, so this is what keeps
 * a five-second poll from turning into two `hypatia` invocations every five
 * seconds. A settled consolidation invalidates its session immediately, so the
 * TTL only covers changes the Host cannot see.
 */
export const CONTENT_TTL_MS = 15_000

/**
 * How long a successful shelf listing is reused before `hypatia list` runs
 * again. The settings card reads it on open, so this only shields against a
 * user flipping between tabs repeatedly; a failed listing is never reused. (The pre-0.1.7 settings namespace polled every minute;
 * on demand with a TTL needs no timer at all.)
 */
export const SHELVES_TTL_MS = 60_000

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
}

/**
 * Whether an address is a loopback literal.
 * @param {string | undefined} address - a remote address, possibly IPv4-mapped IPv6.
 * @returns {boolean} true for 127.0.0.0/8, ::1, and ::ffff:127.0.0.0/8.
 */
export function isLoopbackAddress(address) {
  if (address === undefined || address === '') return false
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  if (isIPv4(normalized)) return normalized.startsWith('127.')
  if (isIPv6(normalized)) return normalized === '::1'
  return false
}

/**
 * Whether the request arrived over a loopback socket.
 * @param {import('node:http').IncomingMessage} req - the incoming request.
 * @returns {boolean} true when the peer address is loopback.
 */
export function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket?.remoteAddress ?? undefined)
}

/**
 * Whether a `Host` header names this machine's loopback interface.
 *
 * `*.localhost` is included because browsers resolve it to loopback without
 * asking DNS (RFC 6761), so it cannot be rebound.
 *
 * @param {string | undefined} host - the request's `Host` header.
 * @returns {boolean} true for localhost, *.localhost, 127.0.0.0/8 and [::1].
 */
export function isLoopbackHost(host) {
  if (host === undefined || host === '') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname.startsWith('[')) return hostname === '[::1]'
  return isIPv4(hostname) && hostname.startsWith('127.')
}

/**
 * Whether the request is same-origin with its own Host authority.
 * @param {import('node:http').IncomingMessage} req - the incoming request.
 * @returns {boolean} true when `Origin` matches `Host`, or when no `Origin` was
 *   sent and `sec-fetch-site` says same-origin. A cross-site fetch is refused,
 *   and so is a request carrying neither marker (a bare `curl`).
 */
export function isSameOriginRequest(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (host === undefined || host === '') return false
  const origin = req.headers.origin
  if (origin === undefined) return req.headers['sec-fetch-site'] === 'same-origin'
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * The single admission gate the route calls first.
 * @param {import('node:http').IncomingMessage} req - the incoming request.
 * @returns {boolean} true when the request may reach the CLI.
 */
export function isTrustedRequest(req) {
  return isLoopbackRequest(req) && isLoopbackHost(req.headers.host) && isSameOriginRequest(req)
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - the response to complete.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - the payload, serialized as JSON.
 */
export function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

/* ------------------------------------------------------------------ queries */

/** The name prefix every tier-1 span summary of one session carries. */
export function summaryPrefix(sessionId) {
  return `sum-${sessionId}-`
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * An exact matcher for one session's summary names.
 *
 * The `$like` pattern is only a coarse pre-filter: `_` in a session id is a LIKE
 * wildcard, and `sum-<id>-%` also matches a session whose id merely starts with
 * `<id>-`. This pins the whole `sum-<id>-<fromSeq>-<toSeq>` shape (writer.js).
 *
 * @param {string} sessionId - the session to match.
 * @returns {(name: string) => boolean}
 */
export function summaryMatcher(sessionId) {
  const pattern = new RegExp(`^${escapeRegExp(summaryPrefix(sessionId))}\\d+-\\d+$`)
  return (name) => pattern.test(name)
}

/**
 * JSE selecting one session's span summaries.
 *
 * `summaryName()` builds `sum-<session>-<fromSeq>-<toSeq>` (writer.js), so the
 * session is in the name and a LIKE pattern finds its tier-1 summaries without a
 * graph walk. Cascade archives are named `sum<N>-<digest>` and span sessions by
 * construction, so they are deliberately out of scope here.
 *
 * @param {string} sessionId - the session to read.
 * @param {number} limit - rows to ask for.
 * @returns {object} the JSE document to hand `hypatia query`.
 */
export function summariesQuery(sessionId, limit) {
  return { $knowledge: [['$like', 'name', `${summaryPrefix(sessionId)}%`]], limit, offset: 0 }
}

/**
 * JSE selecting the work units derived from one session's summaries.
 *
 * The plugin links a unit to its source with `derivedFrom` (`wu-… derivedFrom
 * sum-…`), and unit names are content-addressed rather than session-derived, so
 * the link is the only way to find them.
 *
 * @param {string} sessionId - the session to read.
 * @param {number} limit - rows to ask for.
 * @returns {object} the JSE document to hand `hypatia query`.
 */
export function derivedFromQuery(sessionId, limit) {
  return {
    $statement: [['$and', ['$eq', 'relation', 'derivedFrom'], ['$like', 'tail', `${summaryPrefix(sessionId)}%`]]],
    limit,
    offset: 0,
  }
}

/**
 * JSE selecting specific knowledge entries by name.
 * @param {string[]} names - entry names; duplicates and blanks are dropped.
 * @returns {object} the JSE document to hand `hypatia query`.
 */
export function knowledgeByNamesQuery(names) {
  const unique = [...new Set(names.filter((name) => typeof name === 'string' && name !== ''))]
  const conditions = unique.map((name) => ['$eq', 'name', name])
  const condition = conditions.length === 1 ? conditions[0] : ['$or', ...conditions]
  return { $knowledge: [condition], limit: unique.length, offset: 0 }
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

/** Cap one body, marking that it was cut. */
export function boundBody(markdown) {
  return markdown.length > BODY_MAX_CHARS ? `${markdown.slice(0, BODY_MAX_CHARS)}…` : markdown
}

/** Whether a body was over the cap, so `boundBody` cut it. */
function isCut(markdown) {
  return markdown.length > BODY_MAX_CHARS
}

/**
 * Normalize knowledge rows across the shapes hypatia has answered with.
 *
 * `hypatia query` returns `{name, content: {data, format, tags, scopes},
 * created_at}` (the shape `dsh-hypatia-ui` normalizes too); this reads it
 * defensively because the tab renders whatever it gets.
 *
 * @param {unknown} rows - the raw `hypatia query` result.
 * @returns {{name: string, markdown: string, cut: boolean, format: string, tags: string[], createdAt: string}[]}
 */
export function normalizeKnowledgeRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return []
    const name = str(row.name)
    if (name === '') return []
    const content = typeof row.content === 'object' && row.content !== null ? row.content : {}
    const data = str(content.data)
    return [{
      name,
      markdown: boundBody(data),
      cut: isCut(data),
      format: str(content.format),
      tags: Array.isArray(content.tags) ? content.tags.filter((tag) => typeof tag === 'string') : [],
      createdAt: str(row.created_at),
    }]
  })
}

/**
 * Normalize statement rows into the pairs the work-unit lookup needs.
 * @param {unknown} rows - the raw `hypatia query` result.
 * @returns {{head: string, tail: string, createdAt: string}[]}
 */
export function normalizeStatementRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return []
    const head = str(row.head)
    const tail = str(row.tail)
    return head === '' ? [] : [{ head, tail, createdAt: str(row.created_at) }]
  })
}

/**
 * The distinct unit names an edge list names, newest edge first.
 *
 * A unit's `derivedFrom` edge is written with the unit, so the edge's
 * `created_at` orders units without reading their bodies first.
 *
 * @param {{head: string, tail: string, createdAt: string}[]} statements - this session's edges.
 * @returns {string[]} every distinct `wu-*` head.
 */
export function unitNamesNewestFirst(statements) {
  const newest = new Map()
  for (const { head, createdAt } of statements) {
    if (!head.startsWith('wu-')) continue
    const seen = newest.get(head)
    if (seen === undefined || createdAt > seen) newest.set(head, createdAt)
  }
  return newestFirst([...newest].map(([name, createdAt]) => ({ name, createdAt }))).map((entry) => entry.name)
}

/**
 * The archive tier a summary sits at, read from its `summary <N>` tag.
 * @param {string[]} tags - one entry's tags.
 * @returns {number} the tier, or 1 when the tag is absent or unreadable.
 */
export function summaryLevel(tags) {
  for (const tag of tags) {
    const match = /^summary\s+(\d+)$/.exec(tag)
    if (match !== null) return Number(match[1])
  }
  return 1
}

/** Newest first, with the name as a stable tiebreak — `created_at` may be equal. */
function newestFirst(entries) {
  return [...entries].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
    return left.name < right.name ? 1 : -1
  })
}

/**
 * Drop bodies from the oldest entries until the running total is spent.
 *
 * One budget is threaded through every section of a response, so the cap is on
 * the whole payload rather than on each list separately.
 *
 * @param {object[]} entries - newest-first entries.
 * @param {number} [spent] - body characters already used by earlier sections.
 * @returns {{kept: object[], truncated: boolean, spent: number}}
 */
export function fitBudget(entries, spent = 0) {
  let total = spent
  const kept = []
  for (const entry of entries) {
    if (total + entry.markdown.length > CONTENT_BUDGET_CHARS) return { kept, truncated: true, spent: total }
    total += entry.markdown.length
    kept.push(entry)
  }
  return { kept, truncated: false, spent: total }
}

/**
 * Build the route family over the state tables and the hypatia client.
 *
 * Content is cached per session and invalidated by the caller when a
 * consolidation settles (see `invalidate`), because that is exactly when a
 * session's summaries change. The status half is recomputed per request: it is
 * an in-memory fold over the two tables and costs nothing.
 *
 * @param {{
 *   cli: {query: (jse: string) => Promise<any>, listShelves: () => Promise<{name: string, path: string, connected: boolean}[]>},
 *   read: (sessionId: string) => {sessions: object[], failed: object[]},
 *   status: import('./status.js').StatusLog,
 *   ttlMs?: number,
 *   shelvesTtlMs?: number,
 *   now?: () => number,
 * }} deps - `read` folds the state tables for one session (see memory-status.js).
 * @returns {{route: {kind: string, path: string, handler: Function}, invalidate: (sessionId?: string) => void, fetchContent: (sessionId: string, watermark?: number) => Promise<object>, fetchShelves: () => Promise<object>}}
 */
export function createMemoryApi({ cli, read, status, ttlMs = CONTENT_TTL_MS, shelvesTtlMs = SHELVES_TTL_MS, now = Date.now }) {
  /** @type {Map<string, {at: number, watermark: number | undefined, value: object}>} */
  const cache = new Map()
  /**
   * Bumped by every `invalidate`. A read that was already in flight when it ran
   * started before the change it announces, so its result must not be cached.
   */
  let generation = 0
  /** @type {Map<string, {signature: string, at: number}>} */
  const changes = new Map()
  /** @type {{at: number, value: {shelves: object[], error: string, listedAt: number}} | undefined} */
  let shelvesCache
  /** @type {Promise<{shelves: object[], error: string, listedAt: number}> | undefined} */
  let shelvesInFlight
  /** Last successful listing, kept to answer a failure with. */
  let lastShelves = []

  /**
   * The shelf listing for the settings card, from cache while it is fresh.
   *
   * Only a successful listing is cached: after a failure the next open asks
   * again, so fixing hypatia (`hypatia connect …`) shows up at once. A failed
   * `hypatia list` answers with the last good shelves and says why — the card
   * must be able to tell "no shelves registered" from "could not ask", and a
   * transient CLI failure should not empty a dropdown the user is looking at.
   * Concurrent requests share one `hypatia list`.
   */
  function fetchShelves() {
    if (shelvesCache !== undefined && now() - shelvesCache.at < shelvesTtlMs) return Promise.resolve(shelvesCache.value)
    shelvesInFlight ??= (async () => {
      try {
        const shelves = await cli.listShelves()
        lastShelves = shelves
        const value = { shelves, error: '', listedAt: now() }
        shelvesCache = { at: now(), value }
        return value
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        status.warn(`shelf listing failed: ${message}`)
        shelvesCache = undefined
        return { shelves: lastShelves, error: message, listedAt: now() }
      } finally {
        shelvesInFlight = undefined
      }
    })()
    return shelvesInFlight
  }

  async function loadContent(sessionId) {
    const isSummary = summaryMatcher(sessionId)
    const summaryRows = await cli.query(JSON.stringify(summariesQuery(sessionId, SCAN_LIMIT)))
    const summaries = normalizeKnowledgeRows(summaryRows)
      .filter((entry) => isSummary(entry.name))
      .map((entry) => ({ ...entry, level: summaryLevel(entry.tags) }))

    const statementRows = await cli.query(JSON.stringify(derivedFromQuery(sessionId, SCAN_LIMIT)))
    const statements = normalizeStatementRows(statementRows).filter((row) => isSummary(row.tail))
    const allNames = unitNamesNewestFirst(statements)
    const names = allNames.slice(0, MAX_WORK_UNITS)
    const units = names.length === 0
      ? []
      : normalizeKnowledgeRows(await cli.query(JSON.stringify(knowledgeByNamesQuery(names))))

    // Every candidate was read, so the newest are chosen here rather than by
    // whatever order the shelf returned; the counts are the full ones unless a
    // scan hit its cap, in which case they are lower bounds and say so.
    const shownSummaries = newestFirst(summaries).slice(0, MAX_SUMMARIES)
    const summaryFit = fitBudget(shownSummaries)
    const unitFit = fitBudget(newestFirst(units), summaryFit.spent)
    const scanCapped = (Array.isArray(summaryRows) && summaryRows.length >= SCAN_LIMIT)
      || (Array.isArray(statementRows) && statementRows.length >= SCAN_LIMIT)
    return {
      summaries: summaryFit.kept.map((entry) => ({
        name: entry.name,
        level: entry.level,
        createdAt: entry.createdAt,
        markdown: entry.markdown,
      })),
      workUnits: unitFit.kept.map((entry) => ({
        name: entry.name,
        createdAt: entry.createdAt,
        markdown: entry.markdown,
      })),
      summaryCount: summaries.length,
      workUnitCount: allNames.length,
      truncated: summaryFit.truncated
        || unitFit.truncated
        || summaries.length > MAX_SUMMARIES
        || allNames.length > MAX_WORK_UNITS
        || scanCapped
        || summaryFit.kept.some((entry) => entry.cut)
        || unitFit.kept.some((entry) => entry.cut),
    }
  }

  /**
   * One session's content, from cache while it is fresh.
   *
   * A cached read is keyed on the consolidation watermark it was taken at as
   * well as its age: consolidation is what changes the shelf, and it advances
   * the watermark before its task settles and `invalidate` runs, so a read
   * asked for at a newer watermark must not be answered from an older one.
   *
   * @param {string} sessionId - the session to read.
   * @param {number} [watermark] - the session's consolidated seq right now.
   * @returns {Promise<object>} the content half of the payload.
   */
  async function fetchContent(sessionId, watermark) {
    const hit = cache.get(sessionId)
    if (hit !== undefined && hit.watermark === watermark && now() - hit.at < ttlMs) return hit.value
    const startedAt = generation
    const value = await loadContent(sessionId)
    // Stamped after the read, not before: two hypatia round trips can take a
    // while, and a stamp from before them would start the TTL already spent.
    if (generation === startedAt) cache.set(sessionId, { at: now(), watermark, value })
    return value
  }

  /**
   * Forget cached content, for one session or all of them.
   * @param {string} [sessionId] - the session whose content changed.
   */
  function invalidate(sessionId) {
    generation += 1
    if (sessionId === undefined) cache.clear()
    else cache.delete(sessionId)
  }

  /**
   * When this Host last saw the session's status change, so the tab's stamp
   * stands still while nothing happens. The first observation counts as a
   * change: before it, the Host has nothing to compare against.
   */
  function changedAt(sessionId, view) {
    const signature = JSON.stringify(view)
    const seen = changes.get(sessionId)
    if (seen !== undefined && seen.signature === signature) return seen.at
    const at = now()
    changes.set(sessionId, { signature, at })
    return at
  }

  async function handleSession(req, res, query) {
    const sessionId = query.get('session') ?? ''
    if (sessionId === '') {
      writeJson(res, 400, { error: 'the session query parameter is required' })
      return
    }
    // A session id is hex, dashes and the `session-` prefix, so this refuses
    // only shapes that would widen the LIKE pattern into a scan of other
    // sessions' rows. `_` is also a LIKE wildcard and is deliberately left to
    // the exact matcher in `loadContent`, which pins the whole name shape.
    if (/[%\\]/.test(sessionId)) {
      writeJson(res, 400, { error: 'malformed session id' })
      return
    }
    const wantContent = query.get('content') === '1'
    const session = sessionView(read(sessionId), sessionId)
    // `content` names which half this response carries. Without it a reader has
    // to infer "the shelf was not read" from missing keys — which is exactly how
    // a status-only poll came to look like "the shelf is empty".
    const payload = { session, updatedAt: changedAt(sessionId, session), content: wantContent }
    if (!wantContent) {
      writeJson(res, 200, payload)
      return
    }
    try {
      Object.assign(payload, await fetchContent(sessionId, session.consolidatedSeq), { contentError: '' })
    } catch (error) {
      // Status must survive a broken shelf: the tab's job is to say what is
      // wrong, and "hypatia is unreachable" is one of the things it can say.
      const message = error instanceof Error ? error.message : String(error)
      status.warn(`memory content unavailable for ${sessionId}: ${message}`)
      Object.assign(payload, {
        summaries: [], workUnits: [], summaryCount: 0, workUnitCount: 0, truncated: false,
        contentError: message,
      })
    }
    writeJson(res, 200, payload)
  }

  async function handler(req, res) {
    if (!isTrustedRequest(req)) {
      writeJson(res, 403, { error: 'forbidden' })
      return
    }
    if ((req.method ?? 'GET') !== 'GET') {
      writeJson(res, 405, { error: 'method not allowed' })
      return
    }
    let url
    try {
      // The base is a placeholder: only the pathname and search are read.
      url = new URL(req.url ?? '', 'http://localhost')
    } catch {
      writeJson(res, 400, { error: 'malformed request url' })
      return
    }
    const path = url.pathname.slice(MEMORY_API_PREFIX.length)
    if (path === '/shelves') {
      writeJson(res, 200, await fetchShelves())
      return
    }
    if (path !== '/session') {
      writeJson(res, 404, { error: 'not found' })
      return
    }
    await handleSession(req, res, url.searchParams)
  }

  return {
    route: { kind: 'prefix', path: MEMORY_API_PREFIX, handler },
    invalidate,
    fetchContent,
    fetchShelves,
  }
}
