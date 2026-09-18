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
 * What to do about a skill name another provider already holds.
 *
 * Two holders are realistic, and they need different fixes. `dsh-hypatia` —
 * the plugin this one replaces — registers the same three names. And since
 * hypatia #20, `hypatia skill install --agent codex` writes the canonical
 * skills to `~/.agents/skills`, which DSH also reads, as user skills ranked
 * above plugin registrations. Telling everyone to remove `dsh-hypatia` sent the
 * second case looking for a plugin that was not installed.
 *
 * @param {{provider?: string, path?: string, resourceBase?: {kind?: string, path?: string}}} existing
 * @returns {string}
 */
export function shadowAdvice(existing) {
  if (existing?.provider === 'dsh-hypatia') {
    return 'remove dsh-hypatia from the profile (`dsh plugin --profile <name> remove dsh-hypatia`) '
      + 'or set `skills: false` on it'
  }
  const onDisk = existing?.resourceBase?.kind === 'directory'
    ? existing.resourceBase.path
    : typeof existing?.path === 'string' ? dirname(existing.path) : undefined
  if (typeof onDisk === 'string' && onDisk !== '') {
    return `delete or rename ${onDisk} — \`hypatia skill install --agent codex\` writes the canonical `
      + 'skills to ~/.agents/skills, which DSH reads as user skills ahead of this plugin'
  }
  return `disable the copy ${existing?.provider ?? 'that provider'} registers`
}

/**
 * Register every packaged skill, refusing to shadow another provider's.
 *
 * Shadowing is refused rather than forced because the registry keeps whoever
 * registered first, and the other copy is usually the canonical
 * `hypatia-memory` — the agent-driven protocol, which asks the model to log
 * every message by hand and needs host hooks DSH does not have. Better to say
 * so loudly, naming where the other copy lives, than to let the two disagree
 * in the model's context.
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
    // Guarded per skill: one unreadable file or one registry rejection used to
    // throw out of the loop, so every skill after it — a set decided by readdir
    // order, not by anything the user could reason about — was silently never
    // registered, with one warning naming only the first casualty.
    try {
      const { attributes, body } = parseFrontmatter(readFileSync(skillFile, 'utf8'))
      const skillName = attributes.name ?? entry.name
      const existing = await ctx.skills.get(skillName).catch(() => undefined)
      if (existing !== undefined && existing.provider !== provider) {
        const holder = existing.source ? `${existing.provider} (${existing.source})` : existing.provider
        const why = skillName === 'hypatia-memory'
          ? ' — the agent-driven memory protocol, which needs host hooks DSH does not have'
          : ''
        status.warn(
          `skill "${skillName}" is already provided by ${holder}, so the agent gets that copy${why}. `
          + `To use this plugin's copy, ${shadowAdvice(existing)}`,
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
        // A TAGGED UNION, not a path: DSH validates the loaded skill against
        // `{kind:'directory',path} | {kind:'url',url} | {kind:'opaque'}` and a
        // bare string fails that check at LOAD time, not registration — the
        // skill appears in the registry and every attempt to read it comes back
        // as `"value.resourceBase" must match exactly one oneOf branch
        // (matched 0)` — what the agent hit on its first two calls once this
        // plugin took over the skill names from dsh-hypatia.
        resourceBase: { kind: 'directory', path: dirname(skillFile) },
        invocation: { modelInvocable: true, userInvocable: attributes['user-invocable'] !== 'false' },
      })
      registered.push(skillName)
    } catch (error) {
      status.warn(`skill "${entry.name}" not registered: ${String(error)}`)
    }
  }
  if (registered.length > 0) status.info(`registered bundled skills: ${registered.join(', ')}`)
  return registered
}
