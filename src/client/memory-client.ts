/**
 * The Memory tab's read side: one same-origin request per refresh.
 *
 * The Host half serves it from `/api/dsh-hypatia-auto-memory/session`
 * (see `src/memory-api.js`), which is parameterized by session and authenticates
 * itself — unlike a settings namespace, it can answer for the one session the
 * tab is bound to instead of shipping every session's state to the browser.
 *
 * Zero runtime imports beyond `fetch`, so the parsing half is unit-tested under
 * `node:test` like `shelves.ts`.
 */

/** Route prefix the Host claims; the tab appends `/session`. */
export const MEMORY_API_PREFIX = '/api/dsh-hypatia-auto-memory'

/** One task that exhausted its attempts. */
export interface FailedMemoryTask {
  kind: string
  sessionId: string
  attempts: number
  error: string
}

/** What the Host derived for one session out of the state tables. */
export interface SessionMemoryStatus {
  sessionId: string
  /** False when the Host has no row and no task for this session yet. */
  known: boolean
  loggedSeq: number
  consolidatedSeq: number
  /** True when consolidation has covered everything logged. */
  caughtUp: boolean
  pendingTokens: number
  sessionNode: boolean
  belongTo: number
  deferred: number
  failed: number
  failedTasks: FailedMemoryTask[]
  error: string
}

/** One distilled entry: a span summary or a work unit. */
export interface MemoryEntry {
  name: string
  /** Markdown body, already capped by the Host. */
  markdown: string
  /** Archive tier, summaries only; 1 condenses messages. */
  level: number
  createdAt: string
}

/**
 * The shelf half of a response.
 *
 * Kept as one object rather than spread across the payload so "the Host did not
 * read the shelf" is representable: the five-second poll asks for status only,
 * and a reader that cannot tell that apart from "the shelf is empty" wipes the
 * content it already showed.
 */
export interface MemoryContent {
  summaries: MemoryEntry[]
  workUnits: MemoryEntry[]
  /** How many the shelf holds, before the response caps. */
  summaryCount: number
  workUnitCount: number
  /** True when a cap dropped entries or cut a body short. */
  truncated: boolean
  /** Non-empty when the shelf could not be read; the status half is still valid. */
  error: string
}

/** One response from the Host. */
export interface MemoryPayload {
  session: SessionMemoryStatus
  /** Epoch milliseconds the Host last saw this session's status change. */
  updatedAt: number
  /** Absent when this response carried status only. */
  content: MemoryContent | undefined
}

/** Read one session's memory. `content` also asks the Host to read the shelf. */
export type FetchMemory = (sessionId: string, options: { content: boolean }) => Promise<MemoryPayload>

/**
 * The URL one refresh reads.
 * @param sessionId - the session the tab is bound to.
 * @param content - whether to ask the Host to read the shelf as well.
 * @returns a same-origin path with its query.
 */
export function memoryUrl(sessionId: string, content: boolean): string {
  const query = new URLSearchParams({ session: sessionId })
  if (content) query.set('content', '1')
  return `${MEMORY_API_PREFIX}/session?${query.toString()}`
}

/** Fetch one session's memory from the Host. */
export const fetchMemory: FetchMemory = async (sessionId, { content }) => {
  const response = await fetch(memoryUrl(sessionId, content), {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`
    throw new Error(message)
  }
  const payload = parseMemoryPayload(body, sessionId)
  if (payload === undefined) throw new Error('the Host returned an unreadable memory payload')
  return payload
}

/**
 * Session-log events that are recorded but not yet consolidated.
 *
 * Both watermarks index the same log, so their difference is exactly the work
 * consolidation still owes. Clamped at zero: a consolidation run may cover a
 * range the logging watermark has not caught up to yet, which is not a backlog.
 *
 * @param session - the session half of a payload.
 * @returns the gap in session-log events.
 */
export function consolidationGap(session: SessionMemoryStatus): number {
  return Math.max(0, session.loggedSeq - session.consolidatedSeq)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseFailedTasks(value: unknown): FailedMemoryTask[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): FailedMemoryTask[] => isRecord(entry)
    ? [{
        kind: str(entry.kind),
        sessionId: str(entry.sessionId),
        attempts: num(entry.attempts),
        error: str(entry.error),
      }]
    : [])
}

function parseEntries(value: unknown): MemoryEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): MemoryEntry[] => {
    if (!isRecord(entry)) return []
    const name = str(entry.name)
    if (name === '') return []
    return [{
      name,
      markdown: str(entry.markdown),
      level: num(entry.level) || 1,
      createdAt: str(entry.createdAt),
    }]
  })
}

/**
 * Read the Host's answer into the tab's shape, defensively.
 *
 * A malformed field falls back to its zero value rather than reaching the DOM;
 * a payload with no usable `session` is rejected outright, because rendering a
 * panel of zeros for a session the Host never answered about would be a lie.
 *
 * A status-only answer parses to `content: undefined` — never to empty lists,
 * which is what made the five-second poll erase the shelf content. The Host also
 * states which half it sent (`content`), and that flag is what this prefers; the
 * key sniffing beside it keeps a bundle built after the flag from misreading a
 * Host that predates it, so the fix does not need a profile restart to land.
 *
 * @param value - the parsed response body.
 * @param sessionId - the session that was asked for.
 * @returns the payload, or undefined when the body is not one.
 */
export function parseMemoryPayload(value: unknown, sessionId: string): MemoryPayload | undefined {
  if (!isRecord(value) || !isRecord(value.session)) return undefined
  const session = value.session
  const carried = value.content === true
    || Object.hasOwn(value, 'summaries')
    || Object.hasOwn(value, 'contentError')
  return {
    session: {
      sessionId: str(session.sessionId) || sessionId,
      known: session.known === true,
      loggedSeq: num(session.loggedSeq),
      consolidatedSeq: num(session.consolidatedSeq),
      caughtUp: session.caughtUp === true,
      pendingTokens: num(session.pendingTokens),
      sessionNode: session.sessionNode === true,
      belongTo: num(session.belongTo),
      deferred: num(session.deferred),
      failed: num(session.failed),
      failedTasks: parseFailedTasks(session.failedTasks),
      error: str(session.error),
    },
    updatedAt: num(value.updatedAt),
    content: carried
      ? {
          summaries: parseEntries(value.summaries),
          workUnits: parseEntries(value.workUnits),
          summaryCount: num(value.summaryCount),
          workUnitCount: num(value.workUnitCount),
          truncated: value.truncated === true,
          error: str(value.contentError),
        }
      : undefined,
  }
}

/**
 * Fold a new answer onto the one on screen.
 *
 * Status is always the newest. Content is only replaced by an answer that
 * carried content, so the poll cannot erase it. An answer whose shelf read
 * failed keeps the content already shown — entries, counts and the truncation
 * flag together, so the header still describes the list under it — and records
 * the error beside it, because a transient hypatia failure should not blank
 * what the reader was looking at.
 *
 * @param previous - the payload on screen, if any.
 * @param next - the answer just parsed.
 * @returns the payload to render.
 */
export function mergeMemory(
  previous: MemoryPayload | undefined,
  next: MemoryPayload,
): MemoryPayload {
  if (next.content === undefined) return { ...next, content: previous?.content }
  // A failed read keeps whatever was on screen — the entries AND the counts that
  // describe them — and replaces only the reason. The guard must not consult the
  // previous error: on the SECOND consecutive failure it is already set, and
  // testing for it fell through to the zeroed answer, blanking the panel the
  // first failure had deliberately preserved.
  if (next.content.error !== '' && previous?.content !== undefined) {
    return { ...next, content: { ...previous.content, error: next.content.error } }
  }
  return next
}
