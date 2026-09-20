/**
 * Background consolidation: turns logged conversation spans into durable
 * knowledge — a span summary plus structured work-unit memories — using a
 * DEDICATED model route (never the main session's loop). Runs as a queue
 * executor, so it inherits durability, per-session ordering, and retry.
 *
 * Its own LLM calls go through ctx.llm.stream directly and never touch the
 * session log, so consolidation cannot trigger itself.
 *
 * dsh-llm is imported lazily inside the executor so this module's pure
 * helpers (transcript building, output parsing, trigger thresholds) stay
 * importable without the DSH package graph.
 *
 * @module dsh-hypatia-auto-memory/consolidator
 */

import { absolutizeDates, blocksToText, eventDate, flattenToolResult, redactSecrets } from './content-policy.js'
import { countLoggableMessages, isCompactionReplacement, isLoggableMessage } from './collector.js'
import { messageName, summaryName } from './writer.js'
import { EMPTY_PROGRESS, advanceProgress } from './progress.js'
import { TaskDeferredError } from './queue.js'

export const PLUGIN_NAME = 'dsh-hypatia-auto-memory'

/** Distinguishes permanent failures (no retry value) from transient ones. */
export class PermanentConsolidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PermanentConsolidationError'
    this.permanent = true
  }
}

/**
 * Choose one selected route per consolidation attempt in stable round-robin order.
 * Empty lists do not consume a turn, so adding the first route always uses it.
 */
export function createConsolidationRouteSelector() {
  let next = 0
  return (routes) => {
    if (!Array.isArray(routes) || routes.length === 0) return undefined
    const route = routes[next % routes.length]
    next = (next + 1) % routes.length
    return route
  }
}

/**
 * What a `turn/end` reason means for the consolidation trigger.
 *
 * `TurnEndReason` is merge-extensible — plugins can declare their own variants —
 * so unknown kinds must fall through to the conservative reading rather than
 * being treated as a boundary.
 *
 * @param {any} reason - the `reason` field of a `turn/end` event, if present.
 * @returns {'boundary'|'normal'|'skip'} `boundary` = a task ended, consolidate
 * eagerly; `normal` = ordinary turn, apply both thresholds; `skip` = the turn
 * ended in a state whose span is not worth cutting a memory at.
 */
export function classifyTurnEnd(reason) {
  switch (reason?.kind) {
    case 'aborted':
      // Only a human interrupt marks a task boundary. A parent-, hook- or
      // dispose-driven cancellation says nothing about the conversation.
      return reason.reason?.kind === 'user' ? 'boundary' : 'skip'
    case 'blocked':
    case 'error':
    case 'max-tokens':
    case 'interrupted':
      return 'skip'
    case 'completed':
    default:
      return 'normal'
  }
}

/**
 * Where the next consolidation span begins: the watermark, but never inside a
 * fork's inherited prefix.
 *
 * A forked session's log opens with its parent's events (`inheritedEventCount`
 * of them). The logger has always skipped that prefix; consolidation did not,
 * because a fresh fork's watermark starts at 0. The result was the parent's
 * conversation summarised a second time under the child's id, and — since
 * message ordinals are counted from the end of the prefix — the summary's edges
 * pointed at the child's own `msg-*-N` entries, marking messages summarised
 * whose content the summary never saw.
 *
 * @param {{lastConsolidatedSeq?: number} | undefined} progressRow
 * @param {{inheritedEventCount?: number} | undefined} session
 * @returns {number}
 */
export function consolidationStart(progressRow, session) {
  return Math.max(progressRow?.lastConsolidatedSeq ?? 0, session?.inheritedEventCount ?? 0)
}

/** System directive: span summary + work-unit extraction as strict JSON. */
function consolidationInstruction(maxWorkUnits) {
  return [
    'You are the memory consolidation engine of an AI coding assistant.',
    'Read the conversation transcript below and output EXACTLY one JSON object — no prose,',
    'no markdown fences — with this shape:',
    '',
    '{',
    '  "summary": "<markdown: 3-8 terse bullets covering the request, what was done, key',
    '              decisions with rationale, and pending items>",',
    '  "workUnits": [',
    '    {',
    '      "title": "<short descriptive slug-like title>",',
    '      "classification": "one-shot | correction-chain | bug-fix | design-decision | exploration",',
    '      "content": "<markdown following the protocol: ## Context / ## Solution (or ## Initial',
    '                  Attempt / ## Why It Was Wrong / ## Correct Approach / ## Lesson for',
    '                  correction-chain) / ## Key Detail>",',
    '      "tags": ["<topic>", "<topic>"]',
    '    }',
    '  ]',
    '}',
    '',
    `Rules: capture lessons, not logs. Be specific — "use Arc<Mutex<T>>", not "use proper`,
    'synchronization". Include non-obvious details and exact identifiers. Skip trivial chat',
    `(workUnits may be []). At most ${maxWorkUnits} work units — only the most valuable ones.`,
    'Write in the same language the conversation primarily uses.',
  ].join('\n')
}

/**
 * Compact transcript for the consolidation call: one line per actor turn, tool
 * outcomes folded into a ledger tail.
 *
 * Two properties this function owes the rest of the pipeline:
 *
 * - **Every line is redacted and date-absolutized**, exactly as the logging
 *   path does before writing to hypatia. Consolidation ships this text to a
 *   remote model, so raw secrets must never reach it — and a model that sees a
 *   secret will happily copy it into the summary it returns.
 * - **Over-budget spans drop whole entries from the TAIL, keeping the OLDEST**,
 *   and report how far they actually reached. The protocol batches oldest-first
 *   (`docs/memory.md`, "Batch order is FIFO"), and a single monotonic watermark
 *   cannot express "the tail is consolidated but the head is not" — so the
 *   caller advances only to `lastSeq` and the next trigger resumes from there.
 *   Character-level truncation would silently strip content the watermark then
 *   marked as done.
 *
 * @param {readonly any[]} events
 * @param {{maxInputTokens: number}} config
 * @param {Date} now - base for relative dates in an event that carries no
 *   timestamp; otherwise each line is resolved against its own event's time.
 * @param {{before?: any}} [context] - the event just ahead of the span, so a
 *   leading compaction replacement is recognised (it restates an old result).
 * @returns {{text: string, lastSeq: number, complete: boolean}} `lastSeq` is the
 * seq of the last event included; `complete` is false when the budget forced
 * later events out of this run.
 */
export function buildTranscript(events, config, now = new Date(), { before } = {}) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  // Tool results cite their call by id; the readable name lives on the call.
  const toolNames = new Map()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.callId !== undefined) {
      toolNames.set(event.data.callId, event.data.name ?? 'tool')
    }
  }

  const clean = (raw, event) => absolutizeDates(redactSecrets(String(raw)), eventDate(event, now)).trim()

  /** @type {Array<{seq: number, line: string}>} */
  const entries = []
  for (const event of events) {
    if (event.type === 'user/message') {
      if (event.data?.source?.kind !== 'user') continue
      const text = clean(blocksToText(event.data?.content ?? []), event)
      if (text !== '') entries.push({ seq: event.seq, line: `U: ${text}` })
    } else if (event.type === 'assistant/message') {
      const text = clean(blocksToText(event.data?.message?.content ?? []), event)
      if (text !== '') entries.push({ seq: event.seq, line: `A: ${text}` })
    } else if (event.type === 'tool/result') {
      if (isCompactionReplacement(event, bySeq, before)) continue
      const callId = event.data?.message?.source?.callId
      const name = toolNames.get(callId) ?? 'tool'
      const ok = event.data?.error === undefined
      const first = clean(flattenToolResult(event), event).split('\n')[0] ?? ''
      entries.push({ seq: event.seq, line: `T: ${name} ${ok ? '✅' : '❌'} ${first}`.trimEnd() })
    }
  }

  const budget = Math.max(1, config.maxInputTokens * 4)
  if (entries.length === 0) {
    return { text: '', lastSeq: -1, complete: true }
  }

  const kept = []
  let used = 0
  for (const entry of entries) {
    const cost = entry.line.length + 1 // the joining newline
    if (kept.length > 0 && used + cost > budget) break
    // A single entry larger than the whole budget would otherwise wedge the
    // watermark forever: admit it alone, truncated, so the run still advances.
    kept.push(kept.length === 0 && cost > budget
      ? { ...entry, line: `${entry.line.slice(0, budget)}\n[...truncated ${entry.line.length - budget} chars]` }
      : entry)
    used += cost
    if (used >= budget) break
  }

  const complete = kept.length === entries.length
  const text = kept.map((entry) => entry.line).join('\n')
    + (complete ? '' : `\n[later content deferred to the next consolidation run: ${entries.length - kept.length} entries]`)
  return { text, lastSeq: kept[kept.length - 1].seq, complete }
}

/**
 * Parse and validate the model's JSON output. Throws PermanentError on any
 * shape problem — a malformed answer will not heal by retrying.
 */
export function parseConsolidationOutput(raw, maxWorkUnits) {
  let text = String(raw).trim()
  // Tolerate an accidental markdown fence without accepting prose around it.
  const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/.exec(text)
  if (fence) text = fence[1].trim()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new PermanentConsolidationError(`consolidation output is not valid JSON: ${text.slice(0, 200)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PermanentConsolidationError('consolidation output is not a JSON object')
  }
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  if (summary === '') {
    throw new PermanentConsolidationError('consolidation output has an empty summary')
  }
  // `maxWorkUnits` is a soft instruction to the model, not a contract. Rejecting
  // the whole answer for an extra unit threw away a usable summary AND left
  // `lastConsolidatedSeq` in place, so every later trigger re-ran the same span
  // — growing, never converging, burning a model call each time. Trim instead.
  const rawUnits = (Array.isArray(parsed.workUnits) ? parsed.workUnits : []).slice(0, maxWorkUnits)
  const workUnits = rawUnits.map((unit, index) => {
    const title = typeof unit?.title === 'string' ? unit.title.trim() : ''
    const content = typeof unit?.content === 'string' ? unit.content.trim() : ''
    if (title === '' || content === '') {
      throw new PermanentConsolidationError(`work unit #${index + 1} has an empty title or content`)
    }
    const tags = Array.isArray(unit.tags)
      ? unit.tags.filter((t) => typeof t === 'string').slice(0, 5)
      : []
    const classification = typeof unit.classification === 'string' ? unit.classification : ''
    return { title, content, tags, classification }
  })
  return { summary, workUnits }
}

/**
 * @param {{
 *   queue: ReturnType<import('./queue.js').createQueue>,
 *   progress: any,
 *   sessions: any,
 *   llm: any,
 *   cli: ReturnType<import('./hypatia-client.js').createHypatiaClient>,
 *   writer: ReturnType<import('./writer.js').createWriter>,
 *   getConfig: () => any,
 *   status: import('./status.js').StatusLog,
 *   projectFor: (session: any) => Promise<string>,
 * }} deps
 */
export function createConsolidator({ queue, progress, sessions, llm, cli, writer, getConfig, status, projectFor }) {
  let warnedNoRoute = false
  const selectRoute = createConsolidationRouteSelector()

  /**
   * Turn-end trigger check. The turn threshold is a minimum interval between
   * accepted consolidation tasks, not a polling cadence: once the interval
   * has elapsed, every later turn re-evaluates the token/log gates until work
   * is successfully enqueued.
   *
   * @returns {{resetTokens: boolean, advanceCheckpoint: boolean}} whether to
   * zero the token counter and move the turn checkpoint to this turn. Both are
   * true only after the queue has durably accepted consolidation work.
   */
  async function onTurnEnd(sessionId, turn, state) {
    const config = getConfig()
    if (config.enabled === false || config.consolidation.enabled === false) {
      return { resetTokens: false, advanceCheckpoint: false }
    }
    const outcome = classifyTurnEnd(state.reason)
    if (outcome === 'skip') {
      // A blocked, failed, truncated or crash-closed turn is not a place to cut
      // a memory: its span is mid-thought, and `max-tokens`/`error` in
      // particular tend to repeat, which would consolidate the same broken
      // stretch again and again. Retain the checkpoint so the next healthy turn
      // can trigger immediately rather than waiting out the interval.
      return { resetTokens: false, advanceCheckpoint: false }
    }
    // A user interrupt IS a task boundary — the strongest cheap signal DSH
    // offers. `docs/memory-nolinear.md` puts task boundaries second only to
    // topic switches, so honour it without waiting out the turn interval; the
    // reduced token floor still filters out interrupts on trivial exchanges.
    const boundary = outcome === 'boundary'
    const elapsed = turn - (state.lastCheckTurn ?? 0)
    if (!boundary && elapsed < config.consolidation.checkEveryTurns) {
      return { resetTokens: false, advanceCheckpoint: false }
    }
    const tokenFloor = boundary
      ? Math.ceil(config.consolidation.minNewTokens / 4)
      : config.consolidation.minNewTokens
    if ((state.pendingTokens ?? 0) < tokenFloor) {
      return { resetTokens: false, advanceCheckpoint: false }
    }
    const current = progress.get(sessionId) ?? EMPTY_PROGRESS
    // Awaited: the resolver falls back to persistence for a session the store
    // will never publish again (see persisted-session.js).
    const session = await sessions.get(sessionId)
    if (session === undefined) {
      status.warn(`consolidation deferred for ${sessionId}: session not live`)
      return { resetTokens: false, advanceCheckpoint: false }
    }
    const fromSeq = consolidationStart(current, session)
    const toSeq = Math.min(session.seq ?? 0, current.lastLoggedSeq)
    if (toSeq <= fromSeq) {
      return { resetTokens: false, advanceCheckpoint: false }
    }
    const project = await projectFor(session)
    // Immediate: the thresholds already decided this span is ready. Riding the
    // flush window only delayed it by `flushWindowMs` (two minutes by default),
    // and a restart inside that window left the task persisted but unscheduled.
    await queue.enqueue({
      kind: 'consolidate',
      sessionId,
      fromSeq,
      toSeq,
      project,
      immediate: true,
    })
    status.info(`consolidation scheduled: ${sessionId} [${fromSeq}, ${toSeq})`)
    return { resetTokens: true, advanceCheckpoint: true }
  }

  /**
   * Decide how one new work unit relates to the memories nearest it.
   *
   * A separate, small call rather than part of the extraction prompt: the
   * candidates depend on the unit's own text, which does not exist until
   * extraction has answered. It is bounded by `maxWorkUnitsPerRun` (default 3)
   * and sees only titles and opening lines, so it costs a fraction of the
   * extraction call it follows.
   *
   * The judgement is the whole point of the pass. The previous implementation
   * had no model in the loop and simply asserted `extends` toward whatever came
   * back first — which wrote the relationship BACKWARDS whenever the new unit
   * actually contradicted the old one.
   *
   * @param {any} unit
   * @param {readonly any[]} candidates
   * @returns {Promise<{verdict: string, target: string} | undefined>}
   */
  async function adjudicate(unit, candidates) {
    const config = getConfig()
    const consolidation = config.consolidation
    if (consolidation.adjudicate === false) return undefined
    const route = selectRoute(consolidation.models)
    if (route === undefined) return undefined

    const listed = candidates.map((row, i) => {
      const body = typeof row?.content?.data === 'string' ? row.content.data : ''
      return `${i + 1}. ${row.name}\n${body.replace(/\s+/g, ' ').slice(0, 300)}`
    }).join('\n\n')

    const instruction = [
      'Decide how a NEW memory relates to EXISTING memories from the same knowledge base.',
      'Output EXACTLY one JSON object, no prose and no markdown fences:',
      '{"verdict": "duplicate|refines|extends|supersedes|contradicts|unrelated", "target": "<existing entry name>"}',
      '',
      '- duplicate: the new memory says the same thing; it will be discarded.',
      '- refines: the new memory is a more precise form of the target.',
      '- extends: the new memory adds to the target without changing it.',
      '- supersedes: the new memory deliberately replaces the target.',
      '- contradicts: the two cannot both be true. BOTH are kept and the conflict recorded.',
      '- unrelated: no meaningful relationship. Prefer this when unsure — a wrong',
      '  edge is worse than a missing one.',
      '',
      `## New memory: ${unit.title}`,
      unit.content.slice(0, 1000),
      '',
      '## Existing memories',
      listed,
    ].join('\n')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), consolidation.timeoutMs)
    try {
      const { createUserMessage, BlockAssembler } = await import('@deepseek-ai/dsh-llm')
      const assembler = new BlockAssembler()
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        system: 'You produce strict JSON only. You never add prose around it.',
        messages: [createUserMessage({
          content: [{ type: 'text', text: instruction }],
          source: { kind: 'plugin', plugin: PLUGIN_NAME },
        })],
        maxTokens: 200,
        purpose: 'memory-adjudication',
        signal: controller.signal,
      })) {
        assembler.push(chunk)
      }
      if (assembler.finish.kind !== 'stop') return undefined
      const text = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
      const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/.exec(text)
      const parsed = JSON.parse(fence ? fence[1].trim() : text)
      if (typeof parsed?.verdict !== 'string') return undefined
      return { verdict: parsed.verdict, target: typeof parsed.target === 'string' ? parsed.target : '' }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Final consolidation for a session that is ending.
   *
   * Thresholds are deliberately not applied. They exist to pace an ongoing
   * conversation, but at the end of one there is no later turn to wait for: a
   * task shorter than `checkEveryTurns` turns or lighter than `minNewTokens`
   * would otherwise be logged and never turned into knowledge at all — which is
   * exactly the shape of a quick, self-contained fix worth remembering.
   *
   * @param {string} sessionId
   * @param {any} session - still usable after disposal; the store has released
   * it but its event log is intact.
   */
  async function onSessionEnd(sessionId, session) {
    const config = getConfig()
    if (config.enabled === false || config.consolidation.enabled === false) return false
    const current = progress.get(sessionId) ?? EMPTY_PROGRESS
    const fromSeq = consolidationStart(current, session)
    const toSeq = Math.min(session?.seq ?? 0, current.lastLoggedSeq)
    if (toSeq <= fromSeq) return false
    const project = await projectFor(session)
    await queue.enqueue({
      kind: 'consolidate',
      sessionId,
      fromSeq,
      toSeq,
      project,
      immediate: true,
    })
    status.info(`consolidation scheduled at session end: ${sessionId} [${fromSeq}, ${toSeq})`)
    return true
  }

  /** Queue executor for one consolidate task. */
  async function execute(task) {
    const config = getConfig()
    const consolidation = config.consolidation
    const route = selectRoute(consolidation.models)
    if (route === undefined) {
      if (!warnedNoRoute) {
        warnedNoRoute = true
        status.warn('consolidation enabled but no model route is selected; choose one or more models in hypatia-auto-memory.consolidation.models')
      }
      return
    }
    warnedNoRoute = false
    const session = await sessions.get(task.sessionId)
    if (session === undefined) {
      throw new TaskDeferredError(`session ${task.sessionId} is not loaded; deferred until it is`)
    }
    // Clamped here as well as at scheduling time: a task persisted by an older
    // build may still carry a range reaching into a fork's inherited prefix.
    const inherited = session.inheritedEventCount ?? 0
    const fromSeq = Math.max(task.fromSeq, inherited)
    if (task.toSeq <= fromSeq) {
      await advanceProgress(progress, task.sessionId, (current) => ({
        lastConsolidatedSeq: Math.max(current.lastConsolidatedSeq, fromSeq),
      }))
      return
    }
    const events = session.snapshotEvents(fromSeq, task.toSeq)
    const now = new Date()
    const before = fromSeq > 0 ? session.snapshotEvents(fromSeq - 1, fromSeq)[0] : undefined
    const { text: transcript, lastSeq, complete } = buildTranscript(events, consolidation, now, { before })
    if (transcript.trim() === '') {
      await advanceProgress(progress, task.sessionId, () => ({ lastConsolidatedSeq: task.toSeq }))
      return
    }
    // Only the span the transcript actually carried is consolidated. An
    // over-budget run stops at `lastSeq`; the remainder keeps its place in the
    // watermark and the next trigger resumes from exactly there.
    const coveredToSeq = complete ? task.toSeq : lastSeq + 1

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), consolidation.timeoutMs)
    let assembled
    try {
      const { createUserMessage, BlockAssembler } = await import('@deepseek-ai/dsh-llm')
      const assembler = new BlockAssembler()
      const request = createUserMessage({
        content: [{ type: 'text', text: `${consolidationInstruction(consolidation.maxWorkUnitsPerRun)}\n\n<transcript>\n${transcript}\n</transcript>` }],
        source: { kind: 'plugin', plugin: PLUGIN_NAME },
      })
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        system: 'You produce strict JSON only. You never add prose around it.',
        messages: [request],
        maxTokens: consolidation.maxOutputTokens,
        purpose: 'memory-consolidation',
        signal: controller.signal,
      })) {
        assembler.push(chunk)
      }
      assembled = assembler
    } finally {
      clearTimeout(timer)
    }
    const finish = assembled.finish
    if (finish.kind !== 'stop') {
      if (finish.kind === 'max-tokens') {
        throw new PermanentConsolidationError('consolidation hit the output token cap (truncated JSON)')
      }
      const message = finish.kind === 'error' || finish.kind === 'aborted' ? finish.failure?.message ?? finish.kind : finish.kind
      throw new Error(`consolidation model call failed: ${message}`)
    }
    const text = assembled.blocks()
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    const { summary, workUnits } = parseConsolidationOutput(text, consolidation.maxWorkUnitsPerRun)

    const span = summaryName(task.sessionId, fromSeq, coveredToSeq)
    // The entries the log executor actually wrote for this span. Both sides
    // derive names the same way — same predicate, same dense ordinal counted
    // from the end of the inherited prefix — so the links resolve without
    // probing hypatia for each one. That only holds because `fromSeq` never
    // precedes the prefix: counting from inside it would restart the ordinals
    // at 0 and name the parent's messages after the child's.
    let itemIndex = countLoggableMessages(session.snapshotEvents(inherited, fromSeq))
    const items = []
    for (const event of events) {
      if (!isLoggableMessage(event)) continue
      if (event.seq < coveredToSeq) items.push(messageName(task.sessionId, itemIndex))
      itemIndex += 1
    }
    await writer.writeSummary({
      sessionId: task.sessionId,
      fromSeq: fromSeq,
      toSeq: coveredToSeq,
      markdown: summary,
      project: task.project,
      items,
    })
    const date = now.toISOString().slice(0, 10)
    for (const unit of workUnits) {
      const result = await writer.writeWorkUnit({
        maxDistance: consolidation.dedupMaxDistance,
        candidateLimit: consolidation.dedupCandidates,
        title: unit.title,
        content: unit.classification === ''
          ? unit.content
          : `${unit.content}\n\n_Classification: ${unit.classification}_`,
        tags: unit.tags,
        project: task.project,
        derivedFrom: span,
        date,
      })
      if (result.written) {
        status.info(`work unit stored: ${result.name}`)
      }
    }
    await advanceProgress(progress, task.sessionId, () => ({ lastConsolidatedSeq: coveredToSeq }))
    // A fresh tier-1 summary may complete a batch of sixteen, so give the
    // cascade a chance to run. It is its own task so a cascade failure can never
    // roll back a consolidation that already succeeded.
    if (consolidation.cascade?.enabled !== false) {
      await queue.enqueue({
        kind: 'cascade',
        sessionId: task.sessionId,
        fromSeq: fromSeq,
        toSeq: coveredToSeq,
        project: task.project,
        immediate: true,
      })
    }
    if (!complete) {
      status.info(`consolidation covered [${fromSeq}, ${coveredToSeq}) of [${fromSeq}, ${task.toSeq}); remainder deferred`)
    }
    status.markConsolidated()
    status.count('consolidations')
  }

  return { onTurnEnd, onSessionEnd, adjudicate, selectRoute, execute, buildTranscript, parseConsolidationOutput }
}
