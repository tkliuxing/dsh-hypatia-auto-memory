import test from 'node:test'
import assert from 'node:assert/strict'

import { createHypatiaCli } from '../src/hypatia-cli.js'

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
