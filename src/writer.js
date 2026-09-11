/**
 * Idempotent hypatia writer.
 *
 * Every write is get-before-create, so a crash between check and create, a
 * queue replay, or a backfill re-run converges instead of duplicating. Names are
 * derived, never random: `msg-<session>-<index>` from the dense message ordinal,
 * `sum-<session>-<from>-<to>` from the span, `wu-<slug>-<hash>` from the unit's
 * own content. Multi-step writes assert their edges unconditionally, so a replay
 * repairs a graph a crash left half-written.
 *
 * @module dsh-hypatia-auto-memory/writer
 */

import { createHash } from 'node:crypto'

import { sanitizeSlug } from './content-policy.js'

/**
 * Name prefixes and tags that mark the operational layer — raw logs, span
 * summaries, session nodes, dream run markers.
 *
 * These entries are indexed for full-text and vector search like everything
 * else, so they dominate any similarity query run against a shelf that has been
 * logging a while. They are bookkeeping, not knowledge: relating a new work unit
 * to one says nothing, and `hypatia-dream` excludes the same set when curating
 * the graph (`skills/hypatia-dream/SKILL.md`).
 */
const OPERATIONAL_PREFIXES = ['msg-', 'sum', 'session-', 'hypatia-dream-run-']
const OPERATIONAL_TAGS = new Set(['message', 'session', 'hypatia-dream-run'])

/** Name of a hypatia row: `similar`/query rows carry `name`, `search` rows `key`. */
function rowName(row) {
  return typeof row?.name === 'string' ? row.name
    : typeof row?.key === 'string' ? row.key : ''
}

/** Whether a candidate row belongs to the operational layer rather than knowledge. */
export function isOperationalRow(row) {
  const name = rowName(row)
  if (name === '') return true
  if (OPERATIONAL_PREFIXES.some((prefix) => name.startsWith(prefix))) return true
  const tags = row?.content?.tags
  return Array.isArray(tags) && tags.some((tag) => (
    OPERATIONAL_TAGS.has(tag) || tag === 'summary' || String(tag).startsWith('summary ')
  ))
}

/**
 * How a new work unit relates to an existing one, and what that means for the
 * graph. Mirrors the protocol's vocabulary (`docs/memory.md`, and the
 * relationship set `hypatia-dream` preserves).
 *
 * `contradicts` deliberately keeps BOTH entries and records `supersedes`:
 * `docs/memory-nolinear.md` is explicit that a correction must leave a trace —
 * *"否定会留下冲突的痕迹而不是悄悄覆盖——记忆系统最忌讳的就是悄悄忘记自己曾经
 * 知道什么"*.
 */
const VERDICTS = {
  duplicate: { write: false, predicate: undefined },
  refines: { write: true, predicate: 'refines' },
  extends: { write: true, predicate: 'extends' },
  supersedes: { write: true, predicate: 'supersedes' },
  contradicts: { write: true, predicate: 'supersedes' },
  unrelated: { write: true, predicate: undefined },
}

/**
 * hypatia entry naming per the hypatia-memory graph schema.
 *
 * `index` is the DENSE message ordinal within the session, not a session-log
 * seq — see `countLoggableMessages` in collector.js for why that distinction
 * matters to `$not-summaried` and to anything walking `msg-*` in order.
 */
export function messageName(sessionId, index) {
  return `msg-${sessionId}-${index}`
}

/** The session node a message's `belongTo` edge points at. */
export function sessionNodeName(sessionId) {
  return `session-${sessionId}`
}

/** Deterministic span summary name; stable across replays of the same range. */
export function summaryName(sessionId, fromSeq, toSeq) {
  return `sum-${sessionId}-${fromSeq}-${toSeq}`
}

/**
 * @param {ReturnType<import('./hypatia-cli.js').createHypatiaCli>} cli
 * @param {{
 *   status: import('./status.js').StatusLog,
 *   adjudicate?: (unit: any, candidates: readonly any[]) => Promise<{verdict: string, target?: string} | undefined>,
 * }} deps - `adjudicate` decides how a new work unit relates to nearby ones.
 * It is injected rather than implemented here because it needs a model route,
 * which the writer has no business owning; absent it, a unit is stored with no
 * relationship rather than a guessed one.
 */
export function createWriter(cli, { status, adjudicate }) {
  /**
   * Log one conversation message. Duplicates (same name already stored, e.g.
   * from a replayed task) are counted and skipped — the watermark must still
   * advance past them, which the queue does based on the resolved range.
   *
   * @param {{sessionId: string, index: number, markdown: string, project: string}} entry
   */
  async function writeMessage({ sessionId, index, markdown, project }) {
    const name = messageName(sessionId, index)
    const existing = await cli.knowledgeGet(name)
    if (existing.found) {
      status.count('duplicate')
      return { name, written: false }
    }
    await cli.knowledgeCreate(name, { data: markdown, tags: ['message'], scopes: [project] })
    status.count('written')
    return { name, written: true }
  }

  /**
   * Store one span summary and link it to every covered item with `summary`
   * statements (the protocol predicate, oriented `summary -> item`: hypatia's
   * `$not-summaried` anti-joins on `statement.tail`, so the summary must be the
   * head).
   *
   * Two properties this owes its callers:
   *
   * - **`items` is the list of entries actually written**, not a seq range to
   *   probe. Walking `[fromSeq, toSeq)` and calling `knowledgeGet` per step
   *   looked equivalent but is not: DSH appends one `assistant/chunk` event per
   *   streamed delta, so seq counts tokens, not messages. A single span meant
   *   thousands of serial CLI spawns, almost all of them looking up keys that
   *   could never exist — enough to wedge the session's task chain outright.
   * - **Edges are asserted even when the entry already exists.** The entry and
   *   its edges are separate CLI calls, so a crash between them leaves a
   *   summary with no links; returning early on `found` made that state
   *   permanent. `statementCreate` swallows primary-key collisions, so
   *   re-asserting an existing edge is free.
   *
   * @param {{sessionId: string, fromSeq: number, toSeq: number, markdown: string,
   *          project: string, items?: readonly string[], level?: number}} entry
   * `level` is the archive tier this summary sits at (1 = summarises messages).
   * It is carried as the `summary <N>` tag the protocol's cascade queries with
   * `$not-summaried`. Spaces inside a tag are safe: tags travel as one argv
   * element that hypatia splits on commas, never through a shell.
   */
  async function writeSummary({ sessionId, fromSeq, toSeq, markdown, project, items = [], level = 1 }) {
    const name = summaryName(sessionId, fromSeq, toSeq)
    const existing = await cli.knowledgeGet(name)
    if (existing.found) {
      status.count('duplicate')
    } else {
      await cli.knowledgeCreate(name, {
        data: markdown,
        tags: ['summary', `summary ${level}`],
        scopes: [project],
      })
      status.count('written')
    }
    for (const item of items) {
      await cli.statementCreate(name, 'summary', item, { scopes: [project] })
    }
    return { name, written: existing.found === false, links: items.length }
  }

  /**
   * Store the session node and link messages to it with `belongTo`.
   *
   * The protocol is explicit that this node is built from a summary the host
   * produced — a session title, or a compaction summary — and that a session
   * without one is simply skipped rather than given an invented summary
   * (`skills/hypatia-memory/SKILL.md`, "do not fabricate session summaries").
   *
   * hypatia has no `knowledge-update`, so a second title cannot replace the
   * first; the original stands and the caller is told nothing was written.
   *
   * @param {{sessionId: string, markdown: string, project: string,
   *          linkFrom: number, linkTo: number}} entry - `[linkFrom, linkTo)` is
   * the half-open range of message ordinals still needing a `belongTo` edge.
   */
  async function writeSessionNode({ sessionId, markdown, project, linkFrom = 0, linkTo = 0 }) {
    const name = sessionNodeName(sessionId)
    const existing = await cli.knowledgeGet(name)
    if (existing.found) {
      status.count('duplicate')
    } else if (markdown.trim() === '') {
      // The log path calls in with no text purely to settle owed `belongTo`
      // edges. If the node has since been deleted, recreating it empty would
      // fabricate the session summary the protocol forbids inventing — so leave
      // it absent and drop the edges with it.
      return { name, written: false, links: 0 }
    } else {
      await cli.knowledgeCreate(name, { data: markdown, tags: ['session'], scopes: [project] })
      status.count('written')
    }
    for (let index = linkFrom; index < linkTo; index += 1) {
      await cli.statementCreate(messageName(sessionId, index), 'belongTo', name, { scopes: [project] })
    }
    return { name, written: existing.found === false, links: Math.max(0, linkTo - linkFrom) }
  }

  /**
   * Candidates a new unit might relate to: semantically near, above the
   * similarity floor, and not part of the operational layer.
   *
   * Uses `similar` rather than `search` because only vector search reports a
   * `distance`. The old keyword pass had no comparable score, so it treated
   * *any* hit as a relationship — and since `msg-*` entries outnumber knowledge
   * by orders of magnitude, the "nearest" entry was usually a raw chat log.
   */
  async function findCandidates(unit, name, { maxDistance, limit }) {
    try {
      const rows = await cli.similar(`${unit.title}\n${unit.content}`.slice(0, 500), {
        target: 'knowledge',
        limit,
      })
      return rows
        .filter((row) => rowName(row) !== name)
        .filter((row) => !isOperationalRow(row))
        .filter((row) => typeof row?.distance !== 'number' || row.distance <= maxDistance)
        .slice(0, 3)
    } catch (error) {
      // Best-effort by design. A shelf with no embedding model fails every
      // `similar` call outright; that must cost the relationship edge, never
      // the memory itself.
      status.warn(`work-unit candidate lookup unavailable: ${String(error)}`)
      return []
    }
  }

  /**
   * Store one extracted work-unit memory with its protocol statements, after
   * adjudicating how it relates to the memories already nearby.
   *
   * @param {{title: string, content: string, tags: string[], project: string,
   *          derivedFrom?: string, date: string, maxDistance?: number,
   *          candidateLimit?: number}} unit
   */
  async function writeWorkUnit(unit) {
    const slug = sanitizeSlug(unit.title)
    // Content-addressed rather than `wu-<date>-<slug>`, which failed in both
    // directions: two different units whose titles slugged alike on one day
    // collided and the second was silently dropped, while the same lesson
    // re-extracted on another day produced a second entry. The date lives in the
    // body and its statements instead.
    const digest = createHash('sha256').update(`${slug}\n${unit.content.trim()}`).digest('hex').slice(0, 8)
    const name = `wu-${slug}-${digest}`
    const existing = await cli.knowledgeGet(name)

    let verdict = 'duplicate'
    let nearest = ''
    if (existing.found) {
      status.count('duplicate')
    } else {
      verdict = 'unrelated'
      const candidates = await findCandidates(unit, name, {
        maxDistance: unit.maxDistance ?? 0.45,
        limit: unit.candidateLimit ?? 5,
      })
      if (candidates.length > 0 && adjudicate !== undefined) {
        try {
          const decision = await adjudicate(unit, candidates)
          if (decision !== undefined && Object.hasOwn(VERDICTS, decision.verdict)) {
            verdict = decision.verdict
            nearest = rowName(candidates.find((row) => rowName(row) === decision.target) ?? candidates[0])
          }
        } catch (error) {
          // An adjudication failure means "no opinion", not "no memory".
          status.warn(`work-unit adjudication failed, storing unrelated: ${String(error)}`)
        }
      }

      if (VERDICTS[verdict].write === false) {
        status.count('duplicate')
        return { name, written: false, verdict, nearest }
      }

      await cli.knowledgeCreate(name, {
        data: `${unit.content}\n\n_Recorded: ${unit.date}_`,
        tags: ['memory', 'work-unit', ...unit.tags.map((t) => sanitizeSlug(t))].slice(0, 8),
        scopes: [unit.project],
      })
      status.count('written')
    }

    // Asserted whether or not the entry is new: a crash between the entry and
    // its edges must be repairable by a replay. Collisions are swallowed by the
    // CLI wrapper, so re-asserting is free.
    await cli.statementCreate(name, 'is_a', 'work-unit', { scopes: [unit.project] })
    if (unit.derivedFrom) {
      await cli.statementCreate(name, 'derivedFrom', unit.derivedFrom, { scopes: [unit.project] })
    }
    const predicate = VERDICTS[verdict]?.predicate
    if (predicate !== undefined && nearest !== '') {
      await cli.statementCreate(name, predicate, nearest, { scopes: [unit.project] })
    }
    return { name, written: existing.found === false, verdict, nearest }
  }

  return { writeMessage, writeSummary, writeSessionNode, writeWorkUnit, findCandidates, messageName, summaryName }
}
