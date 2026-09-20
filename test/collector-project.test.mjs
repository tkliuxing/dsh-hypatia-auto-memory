import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { createCollector } from '../src/collector.js'
import { ROOT_PROJECT, projectScope } from '../src/content-policy.js'

// Stop git's upward search at the temp dir, so a temp dir inside some checkout
// cannot lend its name to the directories these tests treat as outside git.
process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir())

/**
 * The project scope every entry is written under. hypatia splits a written
 * scope list on commas, trims each item and stores `""` as no scope, while the
 * cascade and recall find entries by exact membership of the project name — so
 * a name hypatia would rewrite leaves its entries unreachable.
 */

test('a name hypatia would store differently becomes one it stores as given', () => {
  assert.equal(projectScope(''), ROOT_PROJECT, 'the empty name of `/` stored as no scope at all')
  assert.equal(projectScope('a,b'), 'a_b', 'a comma split one project into two scopes')
  assert.equal(projectScope(' padded '), 'padded', 'hypatia trims each scope')
  assert.equal(projectScope(' , '), '_')
  assert.equal(projectScope(undefined), ROOT_PROJECT)
})

test('every other name is unchanged, so no scope in use moves', () => {
  for (const name of ['hypatia', 'deepseek-harness', 'my project', '项目', 'a_b', 'v1.2', '.dotfiles']) {
    assert.equal(projectScope(name), name)
  }
})

test('the scope is a fixed point: normalizing twice changes nothing', () => {
  for (const name of ['', 'a,b', ' x , y ', 'plain']) {
    assert.equal(projectScope(projectScope(name)), projectScope(name))
  }
})

test('the root scope cannot be any real directory name', () => {
  // A basename never contains a slash, so `/` is never some project's own.
  assert.ok(ROOT_PROJECT.includes('/'))
  assert.equal(projectScope(ROOT_PROJECT), ROOT_PROJECT)
})

/* ---------------------------------------------------------------------------- */
/* Resolution through the collector                                             */
/* ---------------------------------------------------------------------------- */

function makeCollector() {
  const ctx = { sessions: { get: () => undefined }, on: () => {} }
  return createCollector({
    ctx,
    queue: { enqueue: async () => {} },
    progress: { get: () => undefined, put: () => {} },
    getConfig: () => ({ collector: { enabled: true }, queue: { flushWindowMs: 0 } }),
    status: { error: () => {}, info: () => {}, warn: () => {} },
    onTurnEnd: async () => ({ resetTokens: false, advanceCheckpoint: false }),
    onSessionEnd: async () => {},
  })
}

const sessionAt = (id, cwd) => ({ header: { id, cwd } })

test('a session at `/` gets the root scope, not an empty one', async () => {
  const collector = makeCollector()
  assert.equal(await collector.projectFor(sessionAt('s-root', '/')), ROOT_PROJECT)
  assert.equal(await collector.projectForCwd('/'), ROOT_PROJECT)
})

test('directory names are scoped the same with and without git', async (t) => {
  // Each session sits at its directory's top, where the git-root basename and
  // the cwd basename agree.
  const base = mkdtempSync(join(tmpdir(), 'auto-memory-project-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const plain = join(base, 'plain')
  const comma = join(base, 'a,b')
  const repo = join(base, 'x,y')
  for (const dir of [plain, comma, repo]) mkdirSync(dir)
  execFileSync('git', ['init', '-q', repo])

  const collector = makeCollector()
  assert.equal(await collector.projectForCwd(plain), 'plain')
  assert.equal(await collector.projectForCwd(comma), 'a_b')
  assert.equal(await collector.projectForCwd(repo), 'x_y')
  assert.equal(await collector.projectFor(sessionAt('s-repo', repo)), 'x_y')
})

test('a session below a repo top is scoped by the repo, not its own directory', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'auto-memory-project-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const repo = join(base, 'repo')
  const deep = join(repo, 'src', 'lib')
  mkdirSync(deep, { recursive: true })
  execFileSync('git', ['init', '-q', repo])

  const collector = makeCollector()
  assert.equal(await collector.projectForCwd(join(repo, 'src')), 'repo')
  assert.equal(await collector.projectForCwd(deep), 'repo')
  assert.equal(await collector.projectFor(sessionAt('s-sub', join(repo, 'src'))), 'repo')
})

test('the repo name is normalized when the session is below its top too', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'auto-memory-project-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const repo = join(base, 'x,y')
  mkdirSync(join(repo, 'src'), { recursive: true })
  execFileSync('git', ['init', '-q', repo])

  assert.equal(await makeCollector().projectForCwd(join(repo, 'src')), 'x_y')
})

test('outside git, a subdirectory is still scoped by its own name', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'auto-memory-project-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const sub = join(base, 'plain', 'src')
  mkdirSync(sub, { recursive: true })

  assert.equal(await makeCollector().projectForCwd(sub), 'src')
})

test('a checkout reached through a symlink is scoped by the directory git resolves', async (t) => {
  // git resolves symlinks for --show-toplevel, so a link named differently
  // from its target gives the target's name, at the top as well as below it.
  const base = mkdtempSync(join(tmpdir(), 'auto-memory-project-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const real = join(base, 'real-name')
  const link = join(base, 'link-name')
  mkdirSync(join(real, 'src'), { recursive: true })
  execFileSync('git', ['init', '-q', real])
  symlinkSync(real, link)

  const collector = makeCollector()
  assert.equal(await collector.projectForCwd(link), 'real-name')
  assert.equal(await collector.projectForCwd(join(link, 'src')), 'real-name')
})

test('only git\'s line ending is cut, so the scope is the one the name gets at the top', async (t) => {
  // JS `trim` strips U+FEFF, which hypatia keeps; `projectScope` does the trimming.
  const base = mkdtempSync(join(tmpdir(), 'auto-memory-project-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const name = `repo${String.fromCharCode(0xfeff)}`
  const repo = join(base, name)
  mkdirSync(join(repo, 'src'), { recursive: true })
  execFileSync('git', ['init', '-q', repo])

  assert.equal(await makeCollector().projectForCwd(join(repo, 'src')), projectScope(name))
})

test('an inherited GIT_DIR or GIT_WORK_TREE does not decide the project', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'auto-memory-project-'))
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(base, { recursive: true, force: true })
  })
  const repo = join(base, 'repo')
  const other = join(base, 'other')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(other)
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['init', '-q', other])
  process.env.GIT_DIR = join(other, '.git')
  process.env.GIT_WORK_TREE = other

  assert.equal(await makeCollector().projectForCwd(join(repo, 'src')), 'repo')
})

test('a git call that times out is asked again, not remembered', async (t) => {
  // A fake `git` that hangs past the timeout once, then hands over to the real
  // one. The fallback answers the slow call; the next caller gets the repo.
  const base = mkdtempSync(join(tmpdir(), 'auto-memory-project-'))
  const savedPath = process.env.PATH
  t.after(() => {
    process.env.PATH = savedPath
    rmSync(base, { recursive: true, force: true })
  })
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const repo = join(base, 'repo')
  const sub = join(repo, 'src')
  const bin = join(base, 'bin')
  mkdirSync(sub, { recursive: true })
  mkdirSync(bin)
  execFileSync('git', ['init', '-q', repo])
  const marker = join(base, 'hung-once')
  writeFileSync(join(bin, 'git'), [
    '#!/bin/sh',
    `if [ ! -e '${marker}' ]; then : > '${marker}'; exec sleep 10; fi`,
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'))
  chmodSync(join(bin, 'git'), 0o755)
  process.env.PATH = `${bin}${delimiter}${savedPath}`

  const collector = makeCollector()
  assert.equal(await collector.projectForCwd(sub), 'src', 'the slow call falls back')
  assert.equal(await collector.projectForCwd(sub), 'repo', 'the timeout was not cached')
})
