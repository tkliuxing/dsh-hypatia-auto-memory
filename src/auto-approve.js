/**
 * Auto-approval for the agent's own `hypatia` calls.
 *
 * This plugin's own writes never need it: they go through the subprocess
 * service as argv arrays, with no shell and no approval in the path. It exists
 * for the other half of the protocol — the agent running `hypatia …` through
 * bash to retrieve, remember or forget — which otherwise stops on an approval
 * prompt every single time and, in practice, stops the agent from retrieving at
 * all.
 *
 * The matcher is narrow on purpose: a bash call whose executable word is a
 * trusted basename AND that contains no shell composition outside quotes. A
 * command that pipes, redirects, chains or substitutes is a command that can do
 * something other than talk to hypatia, so it goes to the human.
 *
 * Ported from `dsh-hypatia`'s auto-approve (same repository, MIT), which this
 * plugin replaces — see README.
 *
 * @module dsh-hypatia-auto-memory/auto-approve
 */

/**
 * True when the command's executable word (after env assignments) is trusted.
 * @param {string} command
 * @param {string[]} binaries - trusted basenames, e.g. `['hypatia']`.
 */
export function invokesTrustedBinary(command, binaries) {
  let rest = command.trimStart()
  // Skip leading KEY=VALUE environment assignments (e.g. HYPATIA_BIN=...).
  for (;;) {
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/.exec(rest)
    if (assignment === null) break
    rest = rest.slice(assignment[0].length).trimStart()
  }
  const word = /^([^\s"']+)/.exec(rest)?.[1]
  if (word === undefined) return false
  return binaries.some((binary) => word === binary || word.endsWith(`/${binary}`))
}

/**
 * True when the command contains shell composition OUTSIDE quotes.
 *
 * Quote tracking matters: a JSE query argument routinely contains `|` or `>`
 * inside a quoted string (`'["$knowledge",[["$gt","x",1]]]'`), and treating
 * those as composition would send every structured query to the human.
 * @param {string} command
 */
export function hasShellComposition(command) {
  let single = false
  let double = false
  let escaped = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (single === false && char === '\\') {
      escaped = true
      continue
    }
    if (double === false && char === "'") {
      single = single === false
      continue
    }
    if (single === false && char === '"') {
      double = double === false
      continue
    }
    if (single || double) continue
    if (char === '&' || char === ';' || char === '|' || char === '<' || char === '>' || char === '`' || char === '\n') {
      return true
    }
    if (char === '$' && command[index + 1] === '(') return true
  }
  return false
}

/**
 * True when this tool execution is a plain call to a trusted binary.
 * @param {{name?: string, arguments?: {command?: unknown}}} exec
 * @param {string[]} binaries
 */
export function isPureTrustedCall(exec, binaries) {
  if (exec?.name !== 'bash') return false
  const command = exec.arguments?.command
  if (typeof command !== 'string') return false
  return invokesTrustedBinary(command, binaries) && hasShellComposition(command) === false
}

/**
 * Answer approval requests for the agent's pure hypatia calls.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - context injecting `approval` and `tools`.
 * @param {{getBinaries: () => string[], status: import('./status.js').StatusLog}} deps
 */
export function createAutoApprove(ctx, { getBinaries, status }) {
  /** callIds of in-flight bash calls that qualify for automatic approval. */
  const pending = new Set()

  const binaries = () => {
    const configured = getBinaries()
    return Array.isArray(configured) && configured.length > 0 ? configured : ['hypatia']
  }

  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      if (isPureTrustedCall(exec, binaries())) pending.add(exec.callId)
    } catch {
      // A matcher bug must never block the tool pipeline; fall through to ask.
    }
    return next()
  })

  // Whether the call asked for approval or not, drop the marker once it settles.
  ctx.on('tools/result', (exec) => {
    pending.delete(exec?.callId)
  })

  // PREPEND: the waterfall runs outermost-first and a handler that skips next()
  // vetoes the rest — the host's api-proxy publishes the approval to the UI and
  // blocks on the human without calling next(), so a plain registration would
  // sit behind it and never run. Non-hypatia calls fall through unchanged.
  ctx.on('approval/request', (request, next) => {
    if (request?.callId !== undefined && pending.delete(request.callId)) {
      status.count('autoApproved')
      return 'allowed-once'
    }
    return next()
  }, { prepend: true })

  return { pendingSize: () => pending.size }
}
