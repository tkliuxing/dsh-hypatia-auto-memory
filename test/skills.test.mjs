import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { holderKind, parseFrontmatter, registerSkills } from '../src/skills.js'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function quiet() {
  const lines = []
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: () => {}, count: () => {} }
}

function fakeSkills(existing = {}) {
  const registered = []
  return {
    registered,
    get: async (name) => existing[name],
    register: (skill) => { registered.push(skill) },
  }
}

function skillDir(name, frontmatter, body = '# body\n') {
  const dir = join(tmpdir(), `ham-skills-${process.pid}-${Math.random().toString(36).slice(2)}`, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
  return dirname(dir)
}

test('frontmatter is read, and the body excludes it', () => {
  const { attributes, body } = parseFrontmatter('---\nname: x\ndescription: "d"\nuser-invocable: false\n---\n# hi\n')
  assert.deepEqual(attributes, { name: 'x', description: '"d"', 'user-invocable': 'false' })
  assert.equal(body, '# hi\n')
})

test('content without frontmatter is kept whole', () => {
  const { attributes, body } = parseFrontmatter('# hi\n')
  assert.deepEqual(attributes, {})
  assert.equal(body, '# hi\n')
})

test('a packaged skill registers under its frontmatter name', async () => {
  const dir = skillDir('folder-name', 'name: real-name\ndescription: what it does\nuser-invocable: false')
  const skills = fakeSkills()
  const names = await registerSkills({ skills }, dir, quiet(), 'ham')

  assert.deepEqual(names, ['real-name'])
  const [skill] = skills.registered
  assert.equal(skill.name, 'real-name')
  assert.equal(skill.description, 'what it does')
  assert.equal(skill.provider, 'ham')
  // DSH validates this as a tagged union when the agent LOADS the skill, so a
  // bare path string registers fine and then fails every read with
  // `"value.resourceBase" must match exactly one oneOf branch (matched 0)`.
  assert.deepEqual(skill.resourceBase, { kind: 'directory', path: dirname(skill.path) })
  assert.equal(skill.invocation.userInvocable, false, 'user-invocable: false is honoured')
  assert.equal(skill.content.startsWith('# body'), true)
})

test('another plugin\'s registration is never shadowed, and the warning says what to do', async () => {
  // Runtime registrations are first-come in DSH — a second one under the same
  // name is ignored — so dsh-hypatia registered first means dsh-hypatia's copy.
  const dir = skillDir('hypatia-memory', 'name: hypatia-memory\ndescription: d')
  const skills = fakeSkills({ 'hypatia-memory': { provider: 'dsh-hypatia', source: 'bundled' } })
  const status = quiet()
  const names = await registerSkills({ skills }, dir, status, 'ham')

  assert.deepEqual(names, [])
  assert.deepEqual(skills.registered, [])
  assert.match(status.lines[0], /already registered by dsh-hypatia \(bundled\)/)
  assert.match(status.lines[0], /host hooks DSH does not have/)
  assert.match(status.lines[0], /remove dsh-hypatia/)
})

test('a user skill on disk is registered over, and still reported: it wins in agent sessions', async () => {
  // Rank puts plugins above ~/.agents/skills, but only within one layer. Agent
  // presets load disk skills in their own, nearer layer, so a session gets the
  // disk copy whatever its rank — seen live with ~/.agents/skills/hypatia-dream.
  const dir = skillDir('hypatia-memory', 'name: hypatia-memory\ndescription: d')
  const skills = fakeSkills({
    'hypatia-memory': {
      provider: 'filesystem',
      source: 'user-agents',
      resourceBase: { kind: 'directory', path: '/home/u/.agents/skills/hypatia-memory' },
    },
  })
  const status = quiet()
  const names = await registerSkills({ skills }, dir, status, 'ham')

  assert.deepEqual(names, ['hypatia-memory'], 'registering is harmless and wins every global view')
  assert.match(status.lines[0], /user-agents copy at \/home\/u\/\.agents\/skills\/hypatia-memory will be used in agent sessions/)
  assert.match(status.lines[0], /host hooks DSH does not have/)
  assert.match(status.lines[0], /Delete it, or move it out of that skills directory/)
  // Seen live: a copy renamed in place (hypatia-dream -> d-dream) still loaded
  // as hypatia-dream, because the filesystem provider takes the frontmatter name.
  assert.match(status.lines[0], /renaming it in place is not enough/)
  assert.doesNotMatch(status.lines.join('\n'), /dsh-hypatia/)
})

test('a project skill is reported the same way, by its file path when no base is given', async () => {
  const dir = skillDir('hypatia-dream', 'name: hypatia-dream\ndescription: d')
  const skills = fakeSkills({
    'hypatia-dream': {
      provider: 'filesystem',
      source: 'project-agents',
      path: '/w/.agents/skills/hypatia-dream/SKILL.md',
    },
  })
  const status = quiet()
  const names = await registerSkills({ skills }, dir, status, 'ham')

  assert.deepEqual(names, ['hypatia-dream'])
  assert.match(status.lines[0], /project-agents copy at \/w\/\.agents\/skills\/hypatia-dream will be used in agent sessions/)
  assert.doesNotMatch(status.lines[0], /host hooks/, 'the protocol note is only for hypatia-memory')
})

test('only the filesystem provider counts as a disk copy; plugins pass source "bundled" too', () => {
  for (const source of ['project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents', 'bundled']) {
    assert.equal(holderKind({ provider: 'filesystem', source }), 'disk', source)
  }
  assert.equal(holderKind({ provider: 'dsh-hypatia', source: 'bundled' }), 'runtime')
  assert.equal(holderKind({ provider: 'remote-skills' }), 'runtime')
})

test('a re-register by this same plugin is allowed', async () => {
  const dir = skillDir('hypatia-memory', 'name: hypatia-memory\ndescription: d')
  const skills = fakeSkills({ 'hypatia-memory': { provider: 'ham' } })
  assert.deepEqual(await registerSkills({ skills }, dir, quiet(), 'ham'), ['hypatia-memory'])
})

test('one rejected skill does not cost the others their registration', async () => {
  // Read, parse and register used to run unguarded in one loop, so a single bad
  // SKILL.md threw out of it and every skill after — a set decided by readdir
  // order — was silently never registered.
  const dir = skillDir('good', 'name: good\ndescription: d')
  mkdirSync(join(dir, 'broken'), { recursive: true })
  writeFileSync(join(dir, 'broken', 'SKILL.md'), '---\nname: broken\ndescription: d\n---\nbody\n')
  const skills = fakeSkills()
  const registry = {
    get: skills.get,
    register: (skill) => {
      if (skill.name === 'broken') throw new Error('registry rejected it')
      skills.register(skill)
    },
  }
  const status = quiet()

  assert.deepEqual(await registerSkills({ skills: registry }, dir, status, 'ham'), ['good'])
  assert.match(status.lines.join('\n'), /"broken" not registered: .*registry rejected it/)
})

test('an unreadable skills directory warns instead of throwing', async () => {
  const status = quiet()
  assert.deepEqual(await registerSkills({ skills: fakeSkills() }, '/nope/not/here', status, 'ham'), [])
  assert.match(status.lines[0], /skills dir unreadable/)
})

test('the package ships all three skills', async () => {
  const skills = fakeSkills()
  const names = await registerSkills({ skills }, join(PACKAGE_ROOT, 'skills'), quiet(), 'ham')
  assert.deepEqual(names.sort(), ['hypatia', 'hypatia-dream', 'hypatia-memory'])
})

test('the two carried copies still match the repository originals', () => {
  // They are copies of ../skills, kept because this plugin replaces
  // dsh-hypatia, which used to supply them. `npm run sync-skills` refreshes
  // them; this test is what notices when someone forgets.
  const canonical = join(dirname(PACKAGE_ROOT), 'skills')
  if (existsSync(canonical) === false) return // published package, no repo around it
  for (const name of ['hypatia', 'hypatia-dream']) {
    assert.equal(
      readFileSync(join(PACKAGE_ROOT, 'skills', name, 'SKILL.md'), 'utf8'),
      readFileSync(join(canonical, name, 'SKILL.md'), 'utf8'),
      `${name} drifted from ../skills — run npm run sync-skills`,
    )
  }
})
