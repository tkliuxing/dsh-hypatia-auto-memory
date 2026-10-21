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
 * The matcher is narrow on purpose: a shell call whose executable word is a
 * trusted basename AND that contains no shell composition outside single
 * quotes. A command that pipes, redirects, chains or substitutes is a command
 * that can do something other than talk to hypatia, so it goes to the human.
 * Only single quotes are trusted to make a payload literal: `$(…)` and
 * backticks are expanded inside double quotes, so a double-quoted payload is
 * still a payload that runs.
 *
 * Ported from `dsh-hypatia`'s auto-approve (same repository, MIT), which this
 * plugin replaces — see README.
 *
 * @module dsh-hypatia-auto-memory/auto-approve
 */

/**
 * True when the command's executable word (after env assignments) is trusted.
 *
 * Windows shapes are accepted too — an optional `.exe` suffix and backslash
 * separators, as the pwsh tool produces them on a Windows host
 * (`C:\Users\me\bin\hypatia.exe`, `hypatia.exe`).
 *
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
  // The suffix is tried on both separators and on the bare word, so `hypatia.exe`
  // and `C:/bin/hypatia.exe` match without a second regex.
  return binaries.some((binary) =>
    word === binary
    || word === `${binary}.exe`
    || word.endsWith(`/${binary}`)
    || word.endsWith(`/${binary}.exe`)
    || word.endsWith(`\\${binary}`)
    || word.endsWith(`\\${binary}.exe`))
}

/**
 * True when the command contains shell composition outside SINGLE quotes.
 *
 * Quote tracking matters: a JSE query argument routinely contains `|` or `>`
 * inside a quoted string (`'["$knowledge",[["$gt","x",1]]]'`), and treating
 * those as composition would send every structured query to the human.
 *
 * Double quotes are different, and that difference is the whole point: a shell
 * expands `$(…)` and backticks inside them, so `hypatia query "$(id)"` still
 * runs something else and must reach the human. Only single quotes make a
 * payload literal. Everything else (`|`, `>`, `&&`, `;`) stays non-composition
 * inside double quotes, which is what keeps `--data="a | b"` prompt-free.
 *
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
    if (single) continue
    if (double) {
      // Substitution survives double quoting; nothing else does.
      if (char === '`') return true
      if (char === '$' && command[index + 1] === '(') return true
      continue
    }
    if (char === '&' || char === ';' || char === '|' || char === '<' || char === '>' || char === '`' || char === '\n') {
      return true
    }
    if (char === '$' && command[index + 1] === '(') return true
  }
  return false
}

/**
 * True when this tool execution is a plain call to a trusted binary.
 *
 * `pwsh` and `powershell` qualify because that is how a Windows host runs its
 * shell tool; the command string gets the same conservative scan, so widening
 * this gate changes only which tool name may ask, not what may pass.
 *
 * @param {{name?: string, arguments?: {command?: unknown}}} exec
 * @param {string[]} binaries
 */
export function isPureTrustedCall(exec, binaries) {
  const name = exec?.name
  if (name !== 'bash' && name !== 'pwsh' && name !== 'powershell') return false
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
