/**
 * The two Host-side faces of an explicit "summarise this session now".
 *
 * The point of these tests is not that each face works in isolation — it is
 * that both call ONE host action and report its ONE result vocabulary, and that
 * neither can be talked into consolidating a session nobody named.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SUMMARIZE_COMMAND,
  SUMMARIZE_COMMAND_DESCRIPTION,
  SUMMARIZE_DEFINITION_ID,
  SUMMARIZE_TOOL,
  commandResult,
  registerSummarizeCommand,
  registerSummarizeTool,
  sessionIdOf,
  summarizeToolHandler,
  unavailableOutcome,
} from '../src/on-demand.js'
import { SUMMARIZE_REASON } from '../src/consolidator.js'

function makeStatus() {
  const lines = []
  return {
    lines,
    info: (message) => lines.push(['info', message]),
    warn: (message) => lines.push(['warn', message]),
    error: () => {},
    count: () => {},
  }
}

/** A `commands`-injected context double whose `effect` runs its factory now. */
function makeCommandCtx() {
  const registered = []
  const effects = []
  const ctx = {
    commands: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    effect(factory, label) {
      effects.push({ label, dispose: factory() })
      return () => {}
    },
  }
  return { ctx, registered, effects }
}

/** A `tools`-injected context double. */
function makeToolCtx() {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    effect(factory) {
      factory()
      return () => {}
    },
  }
  return { ctx, registered }
}

const CALLING_SESSION = 'session-83f81e10-4e4b-4eaa-8ff1-9af30e5e1caa'

test('the slash command is discoverable and bound to the invoking session', async () => {
  const { ctx, registered, effects } = makeCommandCtx()
  const status = makeStatus()
  const runs = []
  registerSummarizeCommand(ctx, {
    run: async (sessionId) => {
      runs.push(sessionId)
      return { sessionId, queued: true, reason: '', fromSeq: 2, toSeq: 10 }
    },
    status,
  })

  assert.equal(registered.length, 1)
  const definition = registered[0]
  assert.equal(definition.name, SUMMARIZE_COMMAND)
  assert.match(definition.name, /^[a-z][a-z0-9_-]*$/, 'the registry enforces this shape')
  assert.equal(definition.definitionId, SUMMARIZE_DEFINITION_ID)
  assert.equal(definition.description, SUMMARIZE_COMMAND_DESCRIPTION)
  assert.ok(definition.description.includes('立即整理'), 'the / menu shows the Host text verbatim')
  assert.equal(typeof definition.handler, 'function')

  // `invocation.agent` is the exact agent whose UI received the command, so the
  // current session needs no argument and no lookup.
  const result = await definition.handler({ agent: { session: { id: CALLING_SESSION } } })
  assert.deepEqual(runs, [CALLING_SESSION])
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('[2, 10)'), result.text)
  assert.equal(effects.length, 1, 'the registration is owned by an effect that unregisters it')
  assert.equal(status.lines.filter(([level]) => level === 'info').length, 1)
})

test('an invocation with no session is refused rather than guessed at', async () => {
  const { ctx, registered } = makeCommandCtx()
  const runs = []
  registerSummarizeCommand(ctx, {
    run: async (sessionId) => { runs.push(sessionId); return unavailableOutcome(sessionId) },
    status: makeStatus(),
  })
  const result = await registered[0].handler({})
  assert.equal(result.kind, 'error')
  assert.equal(runs.length, 0)
})

test('the command reports a refusal as an error and a no-op as a success', () => {
  assert.equal(commandResult({ sessionId: 's', queued: true, reason: '', fromSeq: 1, toSeq: 2 }).kind, 'success')
  assert.equal(commandResult(unavailableOutcome('s')).kind, 'error')
  assert.equal(commandResult({ sessionId: 's', queued: false, reason: SUMMARIZE_REASON.Disabled, fromSeq: 0, toSeq: 0 }).kind, 'error')
  assert.equal(commandResult({ sessionId: 's', queued: false, reason: SUMMARIZE_REASON.Empty, fromSeq: 0, toSeq: 0 }).kind, 'success')
  assert.equal(commandResult({ sessionId: 's', queued: false, reason: SUMMARIZE_REASON.Busy, fromSeq: 0, toSeq: 0 }).kind, 'success')
})

test('the tool defaults to the calling session, and an explicit id wins', async () => {
  const runs = []
  const execute = summarizeToolHandler({
    run: async (sessionId) => {
      runs.push(sessionId)
      return { sessionId, queued: true, reason: '', fromSeq: 1, toSeq: 4 }
    },
  })

  const value = await execute({}, { agent: { session: { id: CALLING_SESSION } } })
  assert.deepEqual(runs, [CALLING_SESSION])
  assert.deepEqual(
    [value.sessionId, value.queued, value.reason],
    [CALLING_SESSION, true, ''],
  )
  assert.ok(value.message.includes('[1, 4)'), value.message)

  await execute({ sessionId: 'session-other' }, { agent: { session: { id: CALLING_SESSION } } })
  assert.deepEqual(runs, [CALLING_SESSION, 'session-other'])

  await execute({ sessionId: '   ' }, { agent: { session: { id: CALLING_SESSION } } })
  assert.equal(runs.at(-1), CALLING_SESSION, 'blank input is not a session id')
})

test('the tool errors, rather than guessing, when there is no calling session', async () => {
  const execute = summarizeToolHandler({
    run: async () => { throw new Error('must not run') },
  })
  await assert.rejects(execute({}, {}), /no calling session/)
  await assert.rejects(execute({}, { agent: undefined }), /no calling session/)
  await assert.rejects(execute({ sessionId: '' }, { agent: { session: {} } }), /no calling session/)
})

test('a durable header id is read before the detached getter', () => {
  assert.equal(sessionIdOf({ header: { id: 'h1' }, id: 'i1' }), 'h1')
  assert.equal(sessionIdOf({ id: 'i1' }), 'i1')
  assert.equal(sessionIdOf(undefined), '')
})

test('the tool registers under the snake_case name with an optional sessionId', async () => {
  const { ctx, registered } = makeToolCtx()
  const status = makeStatus()
  const runs = []
  await registerSummarizeTool(ctx, {
    run: async (sessionId) => {
      runs.push(sessionId)
      return { sessionId, queued: false, reason: SUMMARIZE_REASON.Empty, fromSeq: 5, toSeq: 5 }
    },
    status,
  })

  assert.equal(registered.length, 1)
  const definition = registered[0]
  assert.equal(definition.name, SUMMARIZE_TOOL)
  assert.equal(definition.name, 'hypatia_summarize', 'DSH tool naming convention')
  assert.equal(definition.parameters.properties.sessionId.type, 'string')
  assert.equal(
    (definition.parameters.required ?? []).includes('sessionId'),
    false,
    'the calling session is the default, so the parameter is optional',
  )
  // Through the registry's own wrapper, which is what the model's call hits:
  // argument validation included.
  const value = await definition.execute({}, { agent: { session: { id: CALLING_SESSION } } })
  assert.deepEqual(runs, [CALLING_SESSION])
  assert.equal(value.reason, SUMMARIZE_REASON.Empty)
  assert.match(value.message, /nothing left to summarise/)
  assert.equal(status.lines.filter(([level]) => level === 'info').length, 1)
})

test('both faces call the one host action', async () => {
  // Criterion 4: the command and the tool are surfaces over one function, so a
  // change to the action's behavior reaches both and the two can never report
  // different reasons for the same state.
  const calls = []
  const run = async (sessionId) => {
    calls.push(sessionId)
    return { sessionId, queued: false, reason: SUMMARIZE_REASON.Disabled, fromSeq: 0, toSeq: 0 }
  }
  const { ctx: commandCtx, registered: commands } = makeCommandCtx()
  const { ctx: toolCtx, registered: tools } = makeToolCtx()
  const status = makeStatus()
  registerSummarizeCommand(commandCtx, { run, status })
  await registerSummarizeTool(toolCtx, { run, status })

  const command = await commands[0].handler({ agent: { session: { id: CALLING_SESSION } } })
  const tool = await tools[0].execute({}, { agent: { session: { id: CALLING_SESSION } } })

  assert.deepEqual(calls, [CALLING_SESSION, CALLING_SESSION])
  assert.equal(command.kind, 'error')
  assert.match(command.text, /turned off/)
  assert.match(tool.message, /turned off/)
})
