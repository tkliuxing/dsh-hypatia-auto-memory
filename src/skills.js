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

/** Provider name DSH's filesystem skill provider registers under by default. */
const FILESYSTEM_PROVIDER = 'filesystem'

/**
 * What kind of holder an already-registered copy of a skill has.
 *
 * - `disk`: a SKILL.md the filesystem provider found — in a project, user,
 *   custom or bundled root.
 * - `runtime`: another plugin's registration (dsh-hypatia), or a provider this
 *   code does not know.
 *
 * The distinction matters because the two lose to this plugin differently.
 * Runtime registrations in one layer are first-come: the registry keeps the
 * first and ignores a second. A disk copy is subject to DSH's layering: the
 * skill registry is layered per scope, the nearest layer's same-name entry
 * wins outright, and rank (project 100/200 < runtime 250 < custom 300 < user
 * 400/500 < bundled 600) only breaks ties inside one layer. Agent presets —
 * `st`, `standard`, `cordis`, … — mount their own `skill-filesystem` into the
 * preset's layer, nearer to the agent than this plugin's global registration.
 * So in an agent session any disk copy wins, whatever its rank. Seen live:
 * with `~/.agents/skills/hypatia-dream` present, a session loaded that copy
 * while the global catalog (what the skill center shows) listed this plugin.
 *
 * @param {{provider?: string}} existing
 * @returns {'disk' | 'runtime'}
 */
export function holderKind(existing) {
  return existing?.provider === FILESYSTEM_PROVIDER ? 'disk' : 'runtime'
}

/** Directory of an already-registered copy, when it lives on disk. */
function directoryOf(existing) {
  if (existing?.resourceBase?.kind === 'directory' && typeof existing.resourceBase.path === 'string') {
    return existing.resourceBase.path
  }
  return typeof existing?.path === 'string' ? dirname(existing.path) : undefined
}

/**
 * Register every packaged skill, and say so loudly whenever another copy of
 * the same name will reach the agent instead.
 *
 * Another plugin's registration is yielded to: the registry would ignore this
 * one anyway. A disk copy is registered over — harmless, and it makes this
 * plugin's copy the one any global view sees — but it still wins in agent
 * sessions (see `holderKind`), so the warning names its directory. That
 * matters most for `hypatia-memory`: `hypatia skill install --agent codex`
 * writes the canonical one to `~/.agents/skills`, and it is the agent-driven
 * protocol, which needs host hooks DSH does not have.
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
        const why = skillName === 'hypatia-memory'
          ? ' — the agent-driven memory protocol, which needs host hooks DSH does not have'
          : ''
        if (holderKind(existing) === 'runtime') {
          const holder = existing.source ? `${existing.provider} (${existing.source})` : existing.provider
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
        const where = directoryOf(existing) ?? 'a skill directory'
        status.warn(
          `skill "${skillName}": the ${existing.source ?? 'disk'} copy at ${where} will be used in agent `
          + `sessions instead of this plugin's${why} — agent presets load skills from disk in a layer `
          + 'nearer to the agent than plugin registrations. Delete it, or move it out of that skills '
          + 'directory, to use this plugin\'s copy — renaming it in place is not enough, because DSH '
          + 'names a skill by its frontmatter `name`, not its directory',
        )
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
