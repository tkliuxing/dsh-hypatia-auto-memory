/**
 * Recall: seed each session with the project's standing rules and taboos, and
 * leave everything else to the agent.
 *
 * Why only a seed. `docs/memory-nolinear.md` sorts agents into three kinds and
 * puts harness explicitly in the second: *"对于拥有持续上下文、能自主调用工具的
 * Agent（harness、openclaw 这一类），更自然的方式是让回忆保持在技能层——Agent
 * 在判断需要时自己发起检索，甚至在任务中途发现线索后中途补查。"* Deterministic
 * injection is prescribed for the first kind (agents that rebuild their prompt
 * every turn) and, as a last resort, the third (agents with no initiative).
 *
 * The earlier design injected `## Reference Information` on every human turn
 * from an `agent/pre-step` listener. That cost more than it looked:
 *
 * - It returned a `PreStepDecision` WITHOUT calling `next()`. Per cordis's
 *   waterfall contract that is a veto of the rest of the chain *including the
 *   loop's built-in behavior* — and the built-in is what appends DSH's own
 *   assembled runtime context section. The plugin was silently swallowing it.
 * - It blocked every turn on a `hypatia similar` subprocess (30s ceiling) whose
 *   query was the raw user text, which `docs/memory.md` specifically says not
 *   to do: reference entries should be found *"by analyzing (not
 *   verbatim-searching) the user input"*.
 * - It fixed the retrieval to the first human message of the turn, so the agent
 *   could not follow a lead it discovered mid-task.
 *
 * Rules and taboos stay pushed rather than pulled because they are preferences
 * the agent cannot know it should ask for. The bundled `hypatia-memory` skill
 * carries the query recipes for everything else.
 *
 * The seed also names the shelf when it is not hypatia's `default`: the agent's
 * own `hypatia` calls would otherwise search one shelf while this plugin writes
 * to another. That line is sent even with the preload switched off or nothing
 * to preload, because it is not a preference — without it retrieval is wrong.
 *
 * The seed carries `source: {kind: 'plugin', plugin, form: 'recall'}` so the
 * collector skips it — recall output must never be re-logged into memory.
 *
 * @module dsh-hypatia-auto-memory/recall
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PLUGIN_NAME } from './consolidator.js'
import { DEFAULT_SHELF } from './shelf.js'

/**
 * JSE from the hypatia-memory protocol: entries tagged `tag` whose scopes carry
 * this project or the global marker.
 *
 * `$contains` on `scopes` routes to exact array membership, not a substring
 * match, so the `''` arm matches only entries deliberately written global (a
 * trailing comma in `--scopes`) rather than every entry in the shelf.
 */
function scopedTagQuery(tag, project) {
  return JSON.stringify([
    '$knowledge',
    ['$contains', 'tags', tag],
    ['$or', ['$contains', 'scopes', project], ['$contains', 'scopes', '']],
  ])
}

/** Best-effort name extraction from a hypatia row (shape owned by hypatia;
 * search/similar rows carry `key`, JSE query rows carry `name`). */
function rowName(row) {
  return typeof row?.key === 'string' ? row.key
    : typeof row?.name === 'string' ? row.name : ''
}

/** Best-effort text extraction from a row's content field. */
function rowText(row, cap) {
  const content = row?.content
  const raw = typeof content === 'string' ? content
    : typeof content?.data === 'string' ? content.data
      : typeof content?.text === 'string' ? content.text
        : JSON.stringify(content ?? '')
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat
}

/** Render one tag's rows as a markdown bullet list, dropping empty entries. */
function renderRows(rows, cap) {
  return rows
    .map((row) => {
      const name = rowName(row)
      const text = rowText(row, cap)
      if (name === '' && text === '') return ''
      return name === '' ? `- ${text}` : `- **${name}**: ${text}`
    })
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   cli: ReturnType<import('./hypatia-cli.js').createHypatiaCli>,
 *   shelf?: string,
 *   getConfig: () => any,
 *   status: import('./status.js').StatusLog,
 *   projectFor: (session: any) => Promise<string>,
 * }} deps
 */
export function createRecall({ ctx, cli, shelf = DEFAULT_SHELF, getConfig, status, projectFor }) {
  async function queryRulesAndTaboos(agent) {
    const project = await projectFor(agent.session)
    return Promise.all([
      cli.query(scopedTagQuery('rule', project)).catch((error) => {
        status.warn(`rules preload query failed: ${String(error)}`)
        return []
      }),
      cli.query(scopedTagQuery('taboo', project)).catch((error) => {
        status.warn(`taboos preload query failed: ${String(error)}`)
        return []
      }),
    ])
  }

  async function preloadRulesAndTaboos(agent) {
    const config = getConfig()
    const preload = config.recall.preloadRulesTaboos !== false
    const namesShelf = shelf !== DEFAULT_SHELF
    if (!preload && !namesShelf) return
    const [rules, taboos] = preload ? await queryRulesAndTaboos(agent) : [[], []]
    const rulesText = renderRows(rules, 400)
    const taboosText = renderRows(taboos, 400)
    if (rulesText === '' && taboosText === '' && !namesShelf) return

    const sections = ['## Long-term memory (auto-loaded from hypatia)', '']
    if (namesShelf) {
      sections.push(`Memory lives on the hypatia shelf \`${shelf}\`: add \`--shelf ${shelf}\` to every \`hypatia\` command you run.`, '')
    }
    if (rulesText !== '') sections.push('### Rules', rulesText, '')
    if (taboosText !== '') sections.push('### Taboos', taboosText, '')
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: sections.join('\n') }],
      source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'recall' },
    }))
  }

  ctx.on('agent/session-start', (payload) => {
    const config = getConfig()
    if (config.enabled === false || config.recall.enabled === false) return
    void preloadRulesAndTaboos(payload.agent).catch((error) => {
      status.warn(`rules preload failed: ${String(error)}`)
    })
  })

  return { preloadRulesAndTaboos }
}
