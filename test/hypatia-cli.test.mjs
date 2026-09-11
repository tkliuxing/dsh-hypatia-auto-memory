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
