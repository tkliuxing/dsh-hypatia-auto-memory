/**
 * Hierarchical summary cascade — the log₁₆(n) archive the protocol calls for.
 *
 * A span summary (`summary 1`) condenses messages. Sixteen unarchived `summary 1`
 * entries condense into one `summary 2`, sixteen of those into a `summary 3`,
 * and so on. `docs/memory-nolinear.md` argues the point: the alternative — one
 * model call reading ten thousand words and emitting two hundred — loses
 * information in a way nobody can bound. Each tier here compresses only material
 * that a previous tier already distilled, so loss accumulates at the edges of
 * each step instead of in a single collapse. Nothing is deleted; the lower tiers
 * simply leave the hot path, and a reader drills down through `summary` edges
 * when they need the detail.
 *
 * Membership comes from hypatia's own `$not-summaried`, which anti-joins on
 * `statement.tail` for `relation = 'summary'` and returns `created_at ASC` — so
 * "the oldest sixteen entries at this tier that nothing has archived yet" is one
 * query, and the FIFO batch order the protocol specifies falls out of it.
 *
 * @module dsh-hypatia-auto-memory/cascade
 */

import { createHash } from 'node:crypto'

import { PLUGIN_NAME } from './consolidator.js'

/** Tag marking the tier an entry belongs to. */
export function levelTag(level) {
  return `summary ${level}`
}

/**
 * Name of a tier-N archive entry.
 *
 * Derived from its members so a replay of the same batch reproduces the same
 * name. It keeps the `sum` prefix every downstream exclusion list already knows
 * (`hypatia-dream`'s among them). The protocol asks for descriptive names; a
 * model-authored title cannot be used as the key because the model may word it
 * differently on a retry and silently fork the entry — so the title goes in the
 * body's first heading instead, and the key stays derivable.
 */
export function archiveName(level, members) {
  const digest = createHash('sha256').update([...members].sort().join('\n')).digest('hex').slice(0, 12)
  return `sum${level}-${digest}`
}

/** JSE selecting the oldest unarchived entries of one tier within a project. */
export function notSummarisedQuery(tag, project, limit) {
  // The OBJECT form is the only one that carries `limit`: appending a metadata
  // object to the array form is rejected as "unexpected node in condition
  // context" (asserted in test/integration/cli-contract.test.mjs).
  return JSON.stringify({
    '$not-summaried': [tag, ['$contains', 'scopes', project]],
    limit,
  })
}

/** Directive for one archive step. */
function archiveInstruction(level, count) {
  return [
    `You are the memory archivist of an AI coding assistant, building tier ${level} of a`,
    'hierarchical archive. Below are',
    `${count} summaries from tier ${level - 1}, oldest first.`,
    '',
    'Output EXACTLY one JSON object — no prose, no markdown fences:',
    '{"title": "<short descriptive noun phrase naming what this stretch of work was about>",',
    ' "summary": "<markdown: 5-10 terse bullets>"}',
    '',
    'Compress the narrative, not the conclusions. Keep decisions and their reasons, exact',
    'identifiers, and anything still unresolved. Drop chronology and restatement. You are',
    'reading material that was already distilled once, so do not distil it to vagueness —',
    'a bullet that could describe any project is worse than no bullet.',
    'Write in the same language the summaries use.',
  ].join('\n')
}

/**
 * @param {{
 *   cli: ReturnType<import('./hypatia-client.js').createHypatiaClient>,
 *   llm: any,
 *   selectRoute: (routes: any) => any,
 *   getConfig: () => any,
 *   status: import('./status.js').StatusLog,
 * }} deps
 */
export function createCascade({ cli, llm, selectRoute, getConfig, status }) {
  /**
   * Ask the model to archive one batch.
   * @returns {Promise<{title: string, summary: string} | undefined>}
   */
  async function archiveBatch(level, rows, route, timeoutMs) {
    const body = rows.map((row, i) => {
      const data = typeof row?.content?.data === 'string' ? row.content.data : ''
      return `### ${i + 1}. ${row.name}\n${data}`
    }).join('\n\n')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const { createUserMessage, BlockAssembler } = await import('@deepseek-ai/dsh-llm')
      const assembler = new BlockAssembler()
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        system: 'You produce strict JSON only. You never add prose around it.',
        messages: [createUserMessage({
          content: [{ type: 'text', text: `${archiveInstruction(level, rows.length)}\n\n${body}` }],
          source: { kind: 'plugin', plugin: PLUGIN_NAME },
        })],
        maxTokens: getConfig().consolidation.maxOutputTokens,
        purpose: 'memory-cascade',
        signal: controller.signal,
      })) {
        assembler.push(chunk)
      }
      if (assembler.finish.kind !== 'stop') return undefined
      const text = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
      const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/.exec(text)
      const parsed = JSON.parse(fence ? fence[1].trim() : text)
      const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : ''
      if (summary === '') return undefined
      const title = typeof parsed?.title === 'string' && parsed.title.trim() !== ''
        ? parsed.title.trim()
        : `Archive tier ${level}`
      return { title, summary }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Run the cascade for one project, from tier 2 upward, until a tier has fewer
   * than `batchSize` unarchived entries.
   *
   * @param {{project: string}} task
   */
  async function execute(task) {
    const config = getConfig()
    const consolidation = config.consolidation
    if (consolidation.cascade?.enabled === false) return
    const batchSize = consolidation.cascade?.batchSize ?? 16
    const route = selectRoute(consolidation.models)
    if (route === undefined) return

    // A ceiling on tiers, not an expected depth: reaching tier 8 at 16:1 would
    // mean ~4 billion source entries. It exists so a malformed shelf cannot spin.
    for (let level = 2; level <= 8; level += 1) {
      const sourceTag = levelTag(level - 1)
      let rows
      try {
        rows = await cli.query(notSummarisedQuery(sourceTag, task.project, batchSize))
      } catch (error) {
        status.warn(`cascade query failed at tier ${level}: ${String(error)}`)
        return
      }
      if (rows.length < batchSize) return

      const members = rows.map((row) => row?.name).filter((name) => typeof name === 'string')
      if (members.length < batchSize) return
      const name = archiveName(level, members)

      const existing = await cli.knowledgeGet(name)
      if (existing.found === false) {
        const archived = await archiveBatch(level, rows, route, consolidation.timeoutMs)
        if (archived === undefined) {
          status.warn(`cascade archive produced nothing usable at tier ${level}`)
          return
        }
        await cli.knowledgeCreate(name, {
          data: `# ${archived.title}\n\n${archived.summary}`,
          tags: ['summary', levelTag(level)],
          scopes: [task.project],
        })
        status.count('written')
      }
      // Edges are asserted whether or not the entry is new, so a crash between
      // the two leaves something a replay can finish. Note the consequence when
      // it does crash mid-batch: the members that DID get linked drop out of the
      // next `$not-summaried` result, so the retry archives a different batch
      // under a different name and the first entry keeps only its partial set.
      // Nothing is lost — every member still ends up archived exactly once — but
      // the grouping boundary is not the one the first attempt intended.
      // The archive entry is embedded — it is distilled knowledge, and the entry
      // point for drilling down. Its edges are not: they are for the traversal
      // and for `$not-summaried`, and nobody looks for a `summary` edge by
      // meaning (see writer.js `writeSummary`).
      for (const member of members) {
        await cli.statementCreate(name, 'summary', member, { scopes: [task.project], embed: false })
      }
      status.info(`cascade: tier ${level} archived ${members.length} entries as ${name}`)
    }
  }

  return { execute, archiveBatch }
}
