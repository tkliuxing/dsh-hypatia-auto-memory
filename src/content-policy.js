/**
 * Write-time content policy — pure functions, fully unit-testable.
 *
 * Implements the hypatia-memory protocol's write transforms:
 * secret redaction, relative-to-absolute dates, assistant-message capping,
 * error one-lining, slug sanitizing, and the chars/4 token estimator.
 *
 * @module dsh-hypatia-auto-memory/content-policy
 */

/**
 * One redaction rule: pattern plus the label used in the placeholder.
 *
 * `keepKey` rules capture four groups — (key)(separator)(quote)(value) — so the
 * replacement can keep the readable key and any quoting while masking only the
 * value. The `(?!\[REDACTED)` guard on those values stops a later rule from
 * re-masking a placeholder an earlier rule already wrote.
 */
const SECRET_RULES = [
  { label: 'secret:key', re: /\bsk-[A-Za-z0-9_-]{8,}\b/g },
  // JWTs: three base64url segments, the first always starting `eyJ` ('{"').
  { label: 'secret:jwt', re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g },
  { label: 'secret:bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi },
  // Catch-all for the schemes `secret:bearer` does not cover (Basic, Token, …).
  // The value runs to end of line, not to the first space: stopping at `\S+`
  // would mask only the scheme word and leave the credential itself in place.
  // Runs after `secret:bearer` so the more specific label wins, and the
  // `(?!\[REDACTED)` guard then makes this a no-op on what that rule wrote.
  { label: 'secret:authorization', re: /\b(Authorization)(\s*:\s*)()((?!\[REDACTED)[^\s\n][^\n]{3,})/gi, keepKey: true },
  { label: 'secret:aws', re: /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g },
  { label: 'secret:github', re: /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g },
  { label: 'secret:gitlab', re: /\bglpat-[A-Za-z0-9_-]{8,}\b/g },
  { label: 'secret:slack', re: /\bxox[baprs]-[A-Za-z0-9-]{6,}\b/g },
  // Accepts `=` or `:` and an optional matching quote pair, so `password="s3cret"`
  // and `token: s3cret` redact as readily as the bare `token=s3cret` form.
  // The lookbehind is load-bearing: placeholders are spelled
  // `[REDACTED:secret:<label>]`, and without it this rule matches the `secret:`
  // inside one an earlier rule already wrote, nesting placeholders.
  {
    label: 'secret:credential',
    re: /(?<!\[REDACTED:)\b(apiKey|api_key|password|passwd|pwd|token|secret|access_token|refresh_token|client_secret)(\s*[=:]\s*)(["']?)((?!\[REDACTED)[^\s&'",;]{4,})\3/gi,
    keepKey: true,
  },
  { label: 'secret:pem', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
]

/**
 * Redact known credential shapes. Replaces each match with a labeled
 * placeholder so the surrounding text stays readable and the redaction is
 * itself auditable. Pure: returns a new string.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let out = text
  for (const rule of SECRET_RULES) {
    const placeholder = `[REDACTED:${rule.label}]`
    out = rule.keepKey === true
      ? out.replace(rule.re, (_match, key, separator, quote) => `${key}${separator}${quote}${placeholder}${quote}`)
      : out.replace(rule.re, placeholder)
  }
  return out
}

const pad = (n) => String(n).padStart(2, '0')

/** YYYY-MM-DD in local time. */
export function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** YYYY-MM-DD HH:mm in local time. */
export function formatDateTime(d) {
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

/**
 * The moment an event happened, as the base for resolving relative dates in it.
 *
 * "明天" means the day after the message was SENT, not the day after it was
 * written to memory. The two differ by minutes when a span waits for its turn
 * to end, and by days when a task is deferred until its session is reopened —
 * absolutizing against write time would then record the wrong date outright.
 *
 * @param {{time?: number} | undefined} event
 * @param {Date} fallback - used when the event carries no usable timestamp.
 * @returns {Date}
 */
export function eventDate(event, fallback) {
  return typeof event?.time === 'number' && Number.isFinite(event.time) ? new Date(event.time) : fallback
}

/** Monday of the ISO week containing `d`. */
function weekMonday(d) {
  const copy = new Date(d.getTime())
  copy.setHours(0, 0, 0, 0)
  copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7))
  return copy
}

function dayOffset(now, days, withTime) {
  const d = new Date(now.getTime() + days * DAY_MS)
  return withTime ? formatDateTime(d) : formatDate(d)
}

function unitOffset(now, count, unitMs, withTime) {
  return formatDateTime(new Date(now.getTime() + count * unitMs))
}

/**
 * Convert relative date/time expressions to absolute ones against `now`.
 * Conservative: only rewrites high-confidence shapes; unknown phrasings pass
 * through untouched. Handles both Chinese and English expressions.
 *
 * @param {string} text
 * @param {Date} now - the write time everything is absolutized against.
 * @returns {string}
 */
export function absolutizeDates(text, now) {
  const thisMonday = weekMonday(now)
  const monday = (weeks) => formatDate(new Date(thisMonday.getTime() + weeks * 7 * DAY_MS))
  let out = text

  out = out
    .replace(/今天/g, formatDate(now))
    .replace(/昨天/g, () => dayOffset(now, -1))
    .replace(/明天/g, () => dayOffset(now, 1))
    .replace(/上周/g, () => `the week of ${monday(-1)}`)
    .replace(/本周|这周/g, () => `the week of ${monday(0)}`)
    .replace(/下周/g, () => `the week of ${monday(1)}`)
    .replace(/刚才|现在/g, () => formatDateTime(now))
    .replace(/(\d{1,4})\s*天\s*(前)/g, (_m, n) => formatDate(new Date(now.getTime() - Number(n) * DAY_MS)))
    .replace(/(\d{1,4})\s*天\s*(后)/g, (_m, n) => formatDate(new Date(now.getTime() + Number(n) * DAY_MS)))
    .replace(/(\d{1,4})\s*小时\s*(前)/g, (_m, n) => unitOffset(now, -Number(n), HOUR_MS))
    .replace(/(\d{1,4})\s*小时\s*(后)/g, (_m, n) => unitOffset(now, Number(n), HOUR_MS))
    .replace(/(\d{1,4})\s*分钟\s*(前)/g, (_m, n) => unitOffset(now, -Number(n), MINUTE_MS))
    .replace(/(\d{1,4})\s*分钟\s*(后)/g, (_m, n) => unitOffset(now, Number(n), MINUTE_MS))
    .replace(/\btoday\b/gi, () => formatDate(now))
    .replace(/\byesterday\b/gi, () => dayOffset(now, -1))
    .replace(/\btomorrow\b/gi, () => dayOffset(now, 1))
    .replace(/\b(\d{1,4})\s+days?\s+ago\b/gi, (_m, n) => formatDate(new Date(now.getTime() - Number(n) * DAY_MS)))
    .replace(/\bin\s+(\d{1,4})\s+days?\b/gi, (_m, n) => formatDate(new Date(now.getTime() + Number(n) * DAY_MS)))
    .replace(/\b(\d{1,4})\s+hours?\s+ago\b/gi, (_m, n) => unitOffset(now, -Number(n), HOUR_MS))
    .replace(/\b(\d{1,4})\s+minutes?\s+ago\b/gi, (_m, n) => unitOffset(now, -Number(n), MINUTE_MS))

  return out
}

/** Stack-trace line prefixes stripped by oneLineError. */
const STACK_LINE = /^\s*(at\s|Traceback|File ".*", line \d+|stack backtrace:|note:|Caused by:|===\s*$|\.\.\.\s*$)/

/**
 * Collapse an error/tool output to a single-line description: drop stack
 * frames, keep the first meaningful line, cap the length.
 *
 * @param {string} text
 * @param {number} [cap] - maximum length of the result.
 * @returns {string}
 */
export function oneLineError(text, cap = 200) {
  const lines = String(text).split(/\r?\n/)
  let first = ''
  let last = ''
  for (const line of lines) {
    if (STACK_LINE.test(line)) continue
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (first === '') first = trimmed
    last = trimmed
  }
  const chosen = first === last || last === '' ? first : `${first} → ${last}`
  return chosen.length > cap ? `${chosen.slice(0, cap - 1)}…` : chosen
}

/**
 * Sanitize a model-proposed or derived entry name: lowercase, collapse
 * non-alphanumeric (keeping CJK) runs to single dashes, trim, cap length.
 *
 * @param {string} name
 * @param {number} [cap]
 * @returns {string}
 */
export function sanitizeSlug(name, cap = 60) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, cap)
    .replace(/-+$/, '')
  return slug === '' ? 'memory' : slug
}

/**
 * Cap assistant message text at `maxChars`, leaving an explicit truncation
 * marker so later readers know the entry is partial.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function capAssistant(text, maxChars) {
  if (text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n\n[...truncated ${omitted} chars]`
}

/** The protocol's agent-side token estimator: chars / 4, rounded up. */
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 4)
}

/**
 * Flatten a session ContentBlock[] to plain text for logging: text blocks
 * verbatim, images marked, tool-call blocks dropped, other block types
 * summarized by their type name.
 *
 * `tool-result` blocks nest the real payload one level down (a ToolResultBlock
 * carries its own ContentBlock[]), so they are recursed into rather than
 * summarized — reading only the outer level yields the empty string for every
 * tool outcome, which is what the ledger and the consolidation transcript used
 * to record.
 *
 * @param {readonly any[]} blocks
 * @returns {string}
 */
export function blocksToText(blocks) {
  const parts = []
  for (const block of blocks ?? []) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'thinking') parts.push(`[thinking: ${String(block.text ?? '').slice(0, 200)}]`)
    else if (block.type === 'tool-result') parts.push(blocksToText(block.content ?? []))
    // A tool-call block is the model asking for a tool, not something it said.
    // Rendered as `[tool-call]` it filled the content of half the stored
    // assistant entries with placeholders; the ledger already lists the calls.
    else if (block.type === 'tool-call') continue
    else parts.push(`[${block.type}]`)
  }
  return parts.join('\n')
}

/**
 * Model-facing text of one `tool/result` event. The payload is a
 * ToolResultMessage whose single `tool-result` block wraps the tool's own
 * blocks; `blocksToText` unwraps that nesting.
 *
 * @param {any} event - a `tool/result` session event.
 * @returns {string}
 */
export function flattenToolResult(event) {
  return blocksToText(event?.data?.message?.content ?? [])
}
