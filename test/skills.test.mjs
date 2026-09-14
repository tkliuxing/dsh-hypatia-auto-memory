import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { parseFrontmatter, registerSkills } from '../src/skills.js'

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
  assert.equal(skill.invocation.userInvocable, false, 'user-invocable: false is honoured')
  assert.equal(skill.content.startsWith('# body'), true)
})

test('another provider is never shadowed, and the warning says what to do', async () => {
  // The registry keeps whoever registered first, so shadowing would silently
  // hand the agent dsh-hypatia's agent-driven protocol instead of this one.
  const dir = skillDir('hypatia-memory', 'name: hypatia-memory\ndescription: d')
  const skills = fakeSkills({ 'hypatia-memory': { provider: 'dsh-hypatia' } })
  const status = quiet()
  const names = await registerSkills({ skills }, dir, status, 'ham')

  assert.deepEqual(names, [])
  assert.deepEqual(skills.registered, [])
  assert.match(status.lines[0], /already provided by dsh-hypatia/)
  assert.match(status.lines[0], /remove dsh-hypatia/)
})

test('a re-register by this same plugin is allowed', async () => {
  const dir = skillDir('hypatia-memory', 'name: hypatia-memory\ndescription: d')
  const skills = fakeSkills({ 'hypatia-memory': { provider: 'ham' } })
  assert.deepEqual(await registerSkills({ skills }, dir, quiet(), 'ham'), ['hypatia-memory'])
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
