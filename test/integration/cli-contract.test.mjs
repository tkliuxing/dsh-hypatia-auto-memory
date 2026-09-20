/**
 * Contract tests against a REAL hypatia CLI, on a shelf created and destroyed
 * per run.
 *
 * The plugin talks to hypatia by parsing its stdout and, in one place, its
 * stderr. Those are not typed interfaces — they are text this project happens
 * to depend on, and the unit suite can only assert that the parsers do what we
 * believe. These tests assert that the belief is true of the binary actually
 * installed, so a hypatia upgrade that changes an error string or a row shape
 * fails here rather than silently in production.
 *
 * Skipped when `hypatia` is not on PATH. Run with `npm run test:integration`.
 *
 * SAFETY: every command goes through `hyp()`, which pins `--shelf` to the
 * throwaway shelf. The developer's `default` shelf holds real memories; a bare
 * `hypatia` call here would write into it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { projectScope } from '../../src/content-policy.js'

const hypatiaAvailable = spawnSync('hypatia', ['--version'], { encoding: 'utf8' }).status === 0
const options = hypatiaAvailable
  ? {}
  : { skip: 'hypatia CLI not on PATH' }

let shelfName = ''
let shelfDir = ''

/** One CLI call, always pinned to the throwaway shelf. */
function hyp(argv) {
  const result = spawnSync('hypatia', [...argv, '--shelf', shelfName], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function contentOf(name) {
  const { stdout } = hyp(['knowledge-get', name])
  return JSON.parse(stdout).content
}

test('hypatia CLI contracts the plugin parses', options, async (t) => {
  shelfDir = mkdtempSync(join(tmpdir(), 'hypatia-it-'))
  shelfName = `dsh-auto-memory-it-${process.pid}`
  execFileSync('hypatia', ['connect', shelfDir, '-n', shelfName], { stdio: 'ignore' })
  t.after(() => {
    spawnSync('hypatia', ['disconnect', shelfName], { stdio: 'ignore' })
    rmSync(shelfDir, { recursive: true, force: true })
  })

  await t.test('--scopes: only a trailing comma yields the global marker', () => {
    // `writer.js` joins its scopes array with commas, so a one-element array
    // never produces the global entry — which is what we want for auto-written
    // memories, and why `recall`'s JSE ORs the project scope with "".
    hyp(['knowledge-create', 'p-plain', '--data=x', '--scopes', 'proj'])
    hyp(['knowledge-create', 'p-trail', '--data=x', '--scopes', 'proj,'])
    hyp(['knowledge-create', 'p-empty', '--data=x', '--scopes', ''])
    assert.deepEqual(contentOf('p-plain').scopes, ['proj'])
    assert.deepEqual(contentOf('p-trail').scopes, ['proj', ''])
    assert.equal(contentOf('p-empty').scopes, null, 'empty --scopes drops the field entirely')
  })

  await t.test('the scopes projectScope produces are stored and found as given', () => {
    // `projectScope` (content-policy.js) maps the names hypatia would rewrite —
    // `/`'s empty basename, commas — onto these. They are only safe if hypatia
    // stores each as one scope that exact-membership queries match.
    for (const [name, scope] of [['p-root', projectScope('')], ['p-comma', projectScope('a,b')]]) {
      hyp(['knowledge-create', name, '--data=x', '--tags', 'message', '--scopes', scope])
      assert.deepEqual(contentOf(name).scopes, [scope])
      const rows = JSON.parse(hyp(['query', JSON.stringify({ '$not-summaried': ['message', ['$contains', 'scopes', scope]], limit: 4 })]).stdout)
      assert.deepEqual(rows.map((r) => r.name), [name])
    }
  })

  await t.test('duplicate writes are rejected with the text hypatia-cli.js keys on, or are no-ops', () => {
    // `runOk` classifies a collision as DUPLICATE so `runCreate` can treat a
    // replay as an idempotent no-op. Knowledge entries have no upsert, so for
    // them this string IS the contract.
    const dupKnowledge = hyp(['knowledge-create', 'p-plain', '--data=y'])
    assert.equal(dupKnowledge.status, 1)
    assert.match(dupKnowledge.stderr, /UNIQUE constraint failed:|duplicate key/i)

    // `statement-create` became idempotent in hypatia #20: a repeat exits 0 and
    // leaves the stored statement alone. Older binaries still reject it with the
    // UNIQUE error. Either is a successful replay to the plugin; anything else —
    // a failure it would not classify as DUPLICATE — would wedge a graph write.
    hyp(['statement-create', 'p-plain', 'summary', 'p-trail'])
    const dupStatement = hyp(['statement-create', 'p-plain', 'summary', 'p-trail'])
    const rejected = dupStatement.status === 1
      && /UNIQUE constraint failed:|duplicate key/i.test(dupStatement.stderr)
    const idempotent = dupStatement.status === 0
      && /Statement already exists/.test(`${dupStatement.stdout}${dupStatement.stderr}`)
    assert.ok(
      rejected || idempotent,
      `unexpected duplicate-statement behaviour: exit ${dupStatement.status}, ${dupStatement.stdout}${dupStatement.stderr}`,
    )
  })

  await t.test('a missing knowledge entry is exit 0 with a parseable sentinel', () => {
    // `knowledgeGet` distinguishes "absent" from "failed" purely by this line;
    // if it ever changed, every get-before-create write would start throwing.
    const missing = hyp(['knowledge-get', 'definitely-absent'])
    assert.equal(missing.status, 0)
    assert.match(missing.stdout.trim(), /^Knowledge '.*' not found\.$/)
  })

  await t.test('$not-summaried takes limit through the OBJECT form only', () => {
    for (let i = 1; i <= 3; i += 1) {
      hyp(['knowledge-create', `msg-x-${i}`, `--data=m${i}`, '--tags', 'message', '--scopes', 'proj'])
    }
    const condition = ['message', ['$contains', 'scopes', 'proj']]

    const all = hyp(['query', JSON.stringify(['$not-summaried', ...condition])])
    assert.equal(all.status, 0)
    assert.equal(JSON.parse(all.stdout).length, 3)

    const limited = hyp(['query', JSON.stringify({ '$not-summaried': condition, limit: 2 })])
    assert.equal(limited.status, 0)
    assert.equal(JSON.parse(limited.stdout).length, 2, 'object form applies the limit')

    // The obvious-looking alternative is rejected outright, so the cascade must
    // build the object form rather than appending metadata to the array.
    const trailing = hyp(['query', JSON.stringify(['$not-summaried', ...condition, { limit: 2 }])])
    assert.equal(trailing.status, 1)
    assert.match(trailing.stderr, /unexpected node in condition context/)
  })

  await t.test('$not-summaried excludes an entry once a summary edge points at it', () => {
    // Direction matters: the anti-join is on `statement.tail`, so the SUMMARY
    // must be the head. Writing the edge the other way round would leave every
    // message permanently unsummarised and the cascade would never converge.
    hyp(['knowledge-create', 'sum-x-1', '--data=s', '--tags', 'summary,summary 1', '--scopes', 'proj'])
    hyp(['statement-create', 'sum-x-1', 'summary', 'msg-x-1', '--scopes', 'proj'])
    const rows = JSON.parse(hyp(['query', JSON.stringify(['$not-summaried', 'message', ['$contains', 'scopes', 'proj']])]).stdout)
    assert.deepEqual(rows.map((r) => r.name), ['msg-x-2', 'msg-x-3'])
  })

  await t.test('a level tag with a space round-trips, and cascades on it', () => {
    // The cascade selects its next batch with `$not-summaried` on `summary <N>`.
    // Tags travel as one argv element that hypatia splits on commas, so the
    // space is harmless — but the whole hierarchy depends on that being true.
    hyp(['knowledge-create', 'sum-y-1', '--data=s1', '--tags', 'summary,summary 1', '--scopes', 'proj'])
    hyp(['knowledge-create', 'sum-y-2', '--data=s2', '--tags', 'summary,summary 1', '--scopes', 'proj'])
    assert.deepEqual(
      JSON.parse(hyp(['knowledge-get', 'sum-y-1']).stdout).content.tags,
      ['summary', 'summary 1'],
    )

    const tier = JSON.stringify({
      '$not-summaried': ['summary 1', ['$contains', 'scopes', 'proj']],
      limit: 16,
    })
    const before = JSON.parse(hyp(['query', tier]).stdout).map((r) => r.name)
    assert.ok(before.includes('sum-y-1') && before.includes('sum-y-2'))

    // Archiving one upward removes it from the tier's unarchived set.
    hyp(['knowledge-create', 'sum2-abc', '--data=t2', '--tags', 'summary,summary 2', '--scopes', 'proj'])
    hyp(['statement-create', 'sum2-abc', 'summary', 'sum-y-1', '--scopes', 'proj'])
    const after = JSON.parse(hyp(['query', tier]).stdout).map((r) => r.name)
    assert.ok(!after.includes('sum-y-1'), 'archived entry leaves the tier')
    assert.ok(after.includes('sum-y-2'), 'the rest stay queued for the next batch')
  })

  await t.test('search and similar return DIFFERENT row shapes', () => {
    // A shared row parser must handle both: `search` gives `key` plus a
    // JSON-encoded content STRING, `similar` gives `name` plus a content OBJECT.
    const rows = JSON.parse(hyp(['search', 'm1', '-c', 'knowledge', '--limit', '2']).stdout)
    assert.ok(rows.length > 0)
    assert.equal(typeof rows[0].key, 'string')
    assert.equal(typeof rows[0].content, 'string', 'search content is an encoded string')
    assert.equal(typeof rows[0].rank, 'number')
    assert.equal(rows[0].name, undefined)
  })

  await t.test('similar fails cleanly on a shelf with no embedding provider', () => {
    // A fresh shelf has no model files. Work-unit dedup and any recall path
    // built on `similar` must degrade to "no candidates" rather than failing the
    // write — this is the error they have to tolerate.
    const result = hyp(['similar', 'm1', '-t', 'knowledge', '--limit', '2'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /model unavailable|no embedding provider/i)
  })

  await t.test('an empty result set is exit 0 with the shared sentinel', () => {
    const empty = hyp(['search', 'zzzznomatchzzzz', '-c', 'knowledge', '--limit', '2'])
    assert.equal(empty.status, 0)
    assert.match(empty.stdout, /No results found\./)
  })
})
