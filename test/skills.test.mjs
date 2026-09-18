import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { parseFrontmatter, precedenceOf, registerSkills } from '../src/skills.js'

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

test('a user skill on disk loses to this plugin, which registers anyway', async () => {
  // DSH ranks plugin (runtime) skills above ~/.agents/skills. Refusing here
  // handed the win to a stray user copy — or to the canonical hypatia-memory
  // that `hypatia skill install --agent codex` writes to that directory.
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

  assert.deepEqual(names, ['hypatia-memory'])
  assert.match(status.lines[0], /takes precedence over the user-agents copy at \/home\/u\/\.agents\/skills\/hypatia-memory/)
  assert.doesNotMatch(status.lines.join('\n'), /dsh-hypatia/)
})

test('a project skill outranks every plugin: registered anyway, with a warning naming it', async () => {
  const dir = skillDir('hypatia-memory', 'name: hypatia-memory\ndescription: d')
  const skills = fakeSkills({
    'hypatia-memory': {
      provider: 'filesystem',
      source: 'project-agents',
      path: '/w/.agents/skills/hypatia-memory/SKILL.md',
    },
  })
  const status = quiet()
  const names = await registerSkills({ skills }, dir, status, 'ham')

  assert.deepEqual(names, ['hypatia-memory'], 'harmless: it simply loses while the project copy exists')
  assert.match(status.lines[0], /project copy at \/w\/\.agents\/skills\/hypatia-memory \(project-agents\) outranks plugin skills/)
})

test('precedence follows DSH\'s ranking, and "bundled" is a disk skill only from the filesystem', () => {
  assert.equal(precedenceOf({ provider: 'filesystem', source: 'project-dsh' }), 'project')
  assert.equal(precedenceOf({ provider: 'filesystem', source: 'project-agents' }), 'project')
  for (const source of ['custom', 'user-dsh', 'user-agents']) {
    assert.equal(precedenceOf({ provider: 'filesystem', source }), 'below', source)
  }
  assert.equal(precedenceOf({ provider: 'filesystem', source: 'bundled' }), 'below')
  assert.equal(precedenceOf({ provider: 'dsh-hypatia', source: 'bundled' }), 'runtime', 'plugins pass "bundled" too')
  assert.equal(precedenceOf({ provider: 'remote-skills' }), 'runtime')
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
