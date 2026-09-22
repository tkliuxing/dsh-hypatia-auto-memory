import test from 'node:test'
import assert from 'node:assert/strict'

import { MAX_DATA_BYTES, fitDataArgument, createHypatiaCli } from '../src/hypatia-cli.js'

/**
 * Minimal subprocess-service stub: captures argv, resolves done with a
 * successful outcome and empty collected streams.
 */
function makeSubprocess() {
  const calls = []
  const ctx = {
    subprocess: {
      spawn({ argv }) {
        calls.push(argv)
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: {
            stdout: { readFrom: () => ({ text: '' }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
        }
      },
    },
  }
  return { ctx, calls }
}

test('knowledgeCreate passes content via --data= so markdown bullets survive clap parsing', async () => {
  const { ctx, calls } = makeSubprocess()
  const cli = createHypatiaCli(ctx, { binaries: ['hypatia'] })
  await cli.knowledgeCreate('sum-s1-0-9', {
    data: '- first bullet\n- second bullet',
    tags: ['summary'],
    scopes: ['demo'],
  })
  assert.equal(calls.length, 1)
  const argv = calls[0]
  const dataArg = argv.find((a) => a.startsWith('--data='))
  assert.ok(dataArg, 'content must be passed as a single --data=<value> argument')
  assert.equal(dataArg, '--data=- first bullet\n- second bullet')
  assert.ok(!argv.includes('-d'), 'space-separated -d must not be used')
})

test('statementCreate passes content via --data= for dash-leading payloads', async () => {
  const { ctx, calls } = makeSubprocess()
  const cli = createHypatiaCli(ctx, { binaries: ['hypatia'] })
  await cli.statementCreate('a', 'extends', 'b', { data: '- carried note' })
  const argv = calls[0]
  assert.ok(argv.includes('--data=- carried note'))
  assert.ok(!argv.includes('-d'))
})

test('fitDataArgument keeps one argv element under the byte ceiling', () => {
  // Content travels as a single argv element: Linux rejects any one argument
  // over 128 KiB with E2BIG, which used to fail the spawn and the task.
  const cjk = '中'.repeat(60_000) // 180,000 bytes of UTF-8
  const out = fitDataArgument(cjk)
  assert.ok(Buffer.byteLength(out, 'utf8') <= MAX_DATA_BYTES)
  assert.ok(!out.includes('\uFFFD'), 'cut on a character boundary')
  assert.match(out, /\[\.\.\.truncated \d+ bytes to fit the command line\]$/)
  assert.equal(fitDataArgument('small'), 'small')
})

/** A subprocess stub whose every call prints `stdout` and exits 0. */
function makeSubprocessPrinting(stdout) {
  return {
    subprocess: {
      spawn() {
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: {
            stdout: { readFrom: () => ({ text: stdout }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
        }
      },
    },
  }
}

/**
 * A subprocess stub answering each argv through `answer(argv)`, which returns
 * `{stdout, exitCode}`; every spawn is recorded.
 */
function makeSubprocessAnswering(answer) {
  const calls = []
  const ctx = {
    subprocess: {
      spawn({ argv }) {
        calls.push(argv.slice(1))
        const { stdout = '', exitCode = 0 } = answer(argv.slice(1))
        return {
          done: Promise.resolve({ exitCode }),
          collected: {
            stdout: { readFrom: () => ({ text: stdout }) },
            stderr: { readFrom: () => ({ text: exitCode === 0 ? '' : 'error: unexpected argument' }) },
          },
        }
      },
    },
  }
  return { ctx, calls }
}

/** `--help` output of a binary with (or without) the flags hypatia #26 and #35 added. */
function helpFor(argv, { current }) {
  const [command] = argv
  if (argv[1] !== '--help') return undefined
  if (command === 'knowledge-create' || command === 'statement-create') {
    return `Create an entry\n\nOptions:\n  -d, --data <DATA>\n${current ? '      --no-embed  Keep this entry out of the vector index\n' : ''}  -s, --shelf <SHELF>\n`
  }
  if (command === 'similar') {
    return `Find semantically similar entries\n\nOptions:\n      --limit <LIMIT>\n${current ? '      --exclude-tags <EXCLUDE_TAGS>\n      --where <JSE>\n' : ''}  -s, --shelf <SHELF>\n`
  }
  return undefined
}

test('on a binary that lists them, writes carry --no-embed and similar carries --exclude-tags', async () => {
  const { ctx, calls } = makeSubprocessAnswering((argv) => ({ stdout: helpFor(argv, { current: true }) ?? '[]' }))
  const cli = createHypatiaCli(ctx, { binaries: ['hypatia'] })

  assert.deepEqual(await cli.features(), { noEmbed: true, similarFilters: true })
  await cli.knowledgeCreate('msg-s1-0', { data: 'x', tags: ['message'], embed: false })
  await cli.statementCreate('msg-s1-0', 'belongTo', 'session-s1', { embed: false })
  await cli.knowledgeCreate('wu-x-1', { data: 'x', tags: ['memory'] })
  await cli.similar('q', { limit: 5, excludeTags: ['message', 'summary'] })
  await cli.similar('q', { limit: 5 })

  const real = calls.filter((argv) => argv[1] !== '--help')
  assert.ok(real[0].includes('--no-embed'), 'knowledge-create opted out')
  assert.ok(real[1].includes('--no-embed'), 'statement-create opted out')
  assert.ok(!real[2].includes('--no-embed'), 'an entry that said nothing is embedded')
  assert.deepEqual(real[3].slice(-2), ['--exclude-tags', 'message,summary'])
  assert.ok(!real[4].includes('--exclude-tags'))
  // The probe ran once — three `--help` spawns — however many calls read it.
  assert.equal(calls.filter((argv) => argv[1] === '--help').length, 3)
})

test('--no-embed is sent only when both write commands list it', async () => {
  // They arrived together (hypatia #26), but the flag gates two commands, and
  // a binary listing it on one alone would fail the other with a usage error.
  const { ctx, calls } = makeSubprocessAnswering((argv) => {
    if (argv[0] === 'statement-create' && argv[1] === '--help') return { stdout: helpFor(argv, { current: false }) }
    return { stdout: helpFor(argv, { current: true }) ?? '[]' }
  })
  const cli = createHypatiaCli(ctx, { binaries: ['hypatia'] })
  assert.deepEqual(await cli.features(), { noEmbed: false, similarFilters: true })
  await cli.knowledgeCreate('msg-s1-0', { data: 'x', embed: false })
  assert.ok(!calls.at(-1).includes('--no-embed'))
})

test('on an older binary the flags are dropped rather than guessed at', async () => {
  // clap answers an unknown flag with a usage error INSTEAD of running the
  // command, so a guessed `--no-embed` would have failed every write.
  const { ctx, calls } = makeSubprocessAnswering((argv) => ({ stdout: helpFor(argv, { current: false }) ?? '[]' }))
  const cli = createHypatiaCli(ctx, { binaries: ['hypatia'] })

  assert.deepEqual(await cli.features(), { noEmbed: false, similarFilters: false })
  await cli.knowledgeCreate('msg-s1-0', { data: 'x', embed: false })
  await cli.similar('q', { limit: 5, excludeTags: ['message'] })
  const real = calls.filter((argv) => argv[1] !== '--help')
  assert.ok(!real[0].includes('--no-embed'))
  assert.ok(!real[1].includes('--exclude-tags'))
})

test('a probe that fails answers "neither" and is asked again next time', async () => {
  let helpWorks = false
  const { ctx, calls } = makeSubprocessAnswering((argv) => {
    if (argv[1] === '--help') return helpWorks ? { stdout: helpFor(argv, { current: true }) } : { exitCode: 2 }
    return { stdout: '[]' }
  })
  const cli = createHypatiaCli(ctx, { binaries: ['hypatia'] })
  assert.deepEqual(await cli.features(), { noEmbed: false, similarFilters: false })
  helpWorks = true
  assert.deepEqual(await cli.features(), { noEmbed: true, similarFilters: true })
  assert.deepEqual(await cli.features(), { noEmbed: true, similarFilters: true })
  assert.equal(calls.filter((argv) => argv[1] === '--help').length, 6, 'failed probe repeated once, then cached')
})

test('a result row that merely contains the empty sentinel is not discarded', async () => {
  // Stored tool output reads "No results found." inside ordinary rows. Testing
  // for the phrase anywhere in stdout threw away the entire result set.
  const row = { name: 'msg-s-1', content: { data: '1. `grep` — ✅ No results found.' }, distance: 0.1 }
  const cli = createHypatiaCli(makeSubprocessPrinting(JSON.stringify([row], null, 2)), { binaries: ['hypatia'] })
  assert.equal((await cli.similar('grep')).length, 1)
  assert.equal((await cli.search('grep')).length, 1)
  assert.equal((await cli.query('["$knowledge"]')).length, 1)
})

test('only the bare sentinel means "no results", for query too', async () => {
  const cli = createHypatiaCli(makeSubprocessPrinting('No results found.\n'), { binaries: ['hypatia'] })
  assert.deepEqual(await cli.similar('x'), [])
  assert.deepEqual(await cli.search('x'), [])
  // `query` used to hand the sentinel to JSON.parse and throw BAD_JSON.
  assert.deepEqual(await cli.query('["$knowledge"]'), [])
})
