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

/** Filesystem sources whose skills outrank plugin registrations. */
const OUTRANKS_PLUGINS = new Set(['project-dsh', 'project-agents'])
/** Filesystem sources that plugin registrations outrank. */
const OUTRANKED_BY_PLUGINS = new Set(['custom', 'user-dsh', 'user-agents'])

/**
 * Where an already-registered copy of a skill stands against this plugin's.
 *
 * DSH merges same-name skills by rank within one layer: project entries
 * outrank runtime (plugin) entries, which outrank user entries
 * (`packages/skill`: project-dsh 100, project-agents 200, runtime 250, custom
 * 300, user-dsh 400, user-agents 500, bundled 600). Only another RUNTIME
 * registration is settled by order instead — the registry keeps the first and
 * ignores a second under the same name.
 *
 * - `project`: a project skill; it wins whatever this plugin does.
 * - `below`: a custom, user or DSH-bundled skill on disk; once registered,
 *   this plugin's copy wins.
 * - `runtime`: another plugin's registration (dsh-hypatia), or a provider this
 *   code does not know; first come, first served.
 *
 * Plugins pass `source: 'bundled'` too, so `bundled` counts as a disk skill
 * only when the filesystem provider holds it.
 *
 * @param {{provider?: string, source?: string}} existing
 * @returns {'project' | 'below' | 'runtime'}
 */
export function precedenceOf(existing) {
  const source = existing?.source
  if (OUTRANKS_PLUGINS.has(source)) return 'project'
  if (OUTRANKED_BY_PLUGINS.has(source)) return 'below'
  if (source === 'bundled' && existing?.provider === 'filesystem') return 'below'
  return 'runtime'
}

/** Directory of an already-registered copy, when it lives on disk. */
function directoryOf(existing) {
  if (existing?.resourceBase?.kind === 'directory' && typeof existing.resourceBase.path === 'string') {
    return existing.resourceBase.path
  }
  return typeof existing?.path === 'string' ? dirname(existing.path) : undefined
}

/**
 * Register every packaged skill, yielding only where DSH itself would not let
 * this plugin's copy win.
 *
 * An earlier version refused whenever ANY provider already held the name. That
 * is right for dsh-hypatia — another runtime registration, where the registry
 * keeps the first — and wrong for everything DSH ranks below plugins: a stray
 * `~/.agents/skills/hypatia-dream` silently displaced this plugin's copy, and
 * the canonical `hypatia-memory` that `hypatia skill install --agent codex`
 * writes there — the agent-driven protocol, which needs host hooks DSH does
 * not have — could have displaced this plugin's variant. DSH would have put
 * this plugin first both times; the refusal gave the win away.
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
        const standing = precedenceOf(existing)
        const where = directoryOf(existing)
        if (standing === 'runtime') {
          const holder = existing.source ? `${existing.provider} (${existing.source})` : existing.provider
          const why = skillName === 'hypatia-memory'
            ? ' — the agent-driven memory protocol, which needs host hooks DSH does not have'
            : ''
          const advice = existing.provider === 'dsh-hypatia'
            ? 'remove dsh-hypatia from the profile (`dsh plugin --profile <name> remove dsh-hypatia`) '
              + 'or set `skills: false` on it'
            : `disable the copy ${existing.provider} registers`
          status.warn(
            `skill "${skillName}" is already registered by ${holder}, and DSH keeps the first runtime `
            + `registration, so the agent gets that copy${why}. To use this plugin's copy, ${advice}`,
          )
          continue
        }
        if (standing === 'project') {
          status.warn(
            `skill "${skillName}": the project copy${where ? ` at ${where}` : ''} (${existing.source}) `
            + 'outranks plugin skills in DSH, so the agent gets it; delete it to use this plugin\'s copy',
          )
        } else {
          status.info(
            `skill "${skillName}": this plugin's copy takes precedence over the ${existing.source} copy`
            + `${where ? ` at ${where}` : ''} — DSH ranks plugin skills above user and bundled ones`,
          )
        }
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
