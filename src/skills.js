/**
 * Bundled skill packaging.
 *
 * Three skills ship with the plugin:
 *
 *   hypatia-memory  this plugin's own variant — the automatic layer does the
 *                   writing, so the skill is about retrieval and explicit
 *                   remember/forget, not about logging messages by hand.
 *   hypatia         verbatim copy of the repository's CLI reference.
 *   hypatia-dream   verbatim copy of the consolidation pass.
 *
 * The last two used to arrive with `dsh-hypatia`. This plugin replaces it, so
 * it carries them itself — otherwise removing `dsh-hypatia` from a profile
 * would take the CLI reference away with it. `npm run sync-skills` refreshes
 * both copies from the repository root.
 *
 * @module dsh-hypatia-auto-memory/skills
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Minimal YAML-frontmatter reader for flat `key: value` pairs — the grammar
 * every shipped SKILL.md uses.
 * @param {string} source
 * @returns {{attributes: Record<string, string>, body: string}}
 */
export function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (match === null) return { attributes: {}, body: source }
  const attributes = {}
  for (const line of match[1].split('\n')) {
    const pair = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (pair !== null) attributes[pair[1]] = pair[2].trim()
  }
  return { attributes, body: source.slice(match[0].length) }
}

/**
 * Register every packaged skill, refusing to shadow another provider's.
 *
 * Shadowing is refused rather than forced because the registry keeps whoever
 * registered first: when `dsh-hypatia` is also installed, the agent would
 * silently get its agent-driven memory protocol — which asks the model to log
 * every message by hand, the exact work this plugin already does in the
 * background. Better to say so loudly than to let the two disagree in the
 * model's context.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - context injecting `skills`.
 * @param {string} skillsDir - directory of `<name>/SKILL.md` folders.
 * @param {import('./status.js').StatusLog} status
 * @param {string} provider - provider tag recorded on each registration.
 * @returns {Promise<string[]>} names actually registered.
 */
export async function registerSkills(ctx, skillsDir, status, provider) {
  let entries
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    status.warn(`skills dir unreadable: ${skillsDir}`)
    return []
  }
  const registered = []
  for (const entry of entries) {
    if (entry.isDirectory() === false) continue
    const skillFile = join(skillsDir, entry.name, 'SKILL.md')
    if (existsSync(skillFile) === false) continue
    const { attributes, body } = parseFrontmatter(readFileSync(skillFile, 'utf8'))
    const skillName = attributes.name ?? entry.name
    const existing = await ctx.skills.get(skillName).catch(() => undefined)
    if (existing !== undefined && existing.provider !== provider) {
      status.warn(
        `skill "${skillName}" is already provided by ${existing.provider}; `
        + 'this plugin replaces dsh-hypatia — remove it from the profile '
        + '(`dsh plugin --profile <name> remove dsh-hypatia`) or set `skills: false` on it, '
        + 'otherwise the agent gets the agent-driven memory protocol this plugin already performs',
      )
      continue
    }
    ctx.skills.register({
      name: skillName,
      description: attributes.description ?? '',
      content: body,
      path: skillFile,
      source: 'bundled',
      provider,
      resourceBase: dirname(skillFile),
      invocation: { modelInvocable: true, userInvocable: attributes['user-invocable'] !== 'false' },
    })
    registered.push(skillName)
  }
  if (registered.length > 0) status.info(`registered bundled skills: ${registered.join(', ')}`)
  return registered
}
