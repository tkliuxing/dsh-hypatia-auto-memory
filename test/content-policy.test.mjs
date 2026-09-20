import test from 'node:test'
import assert from 'node:assert/strict'

import {
  absolutizeDates,
  blocksToText,
  capAssistant,
  estimateTokens,
  formatDate,
  oneLineError,
  redactSecrets,
  sanitizeSlug,
  projectScope,
  trimLikeHypatia,
} from '../src/content-policy.js'

const NOW = new Date('2025-09-09T12:00:00')

test('redactSecrets masks key shapes', () => {
  assert.equal(redactSecrets('key is sk-abcdef1234567890XYZ end'), 'key is [REDACTED:secret:key] end')
  assert.equal(redactSecrets('Authorization: Bearer abcdef1234567890.token'), 'Authorization: [REDACTED:secret:bearer]')
  assert.equal(redactSecrets('aws AKIAIOSFODNN7EXAMPLE here'), 'aws [REDACTED:secret:aws] here')
  assert.equal(redactSecrets('git ghp_abcdef1234567890 ok'), 'git [REDACTED:secret:github] ok')
  assert.equal(redactSecrets('ci glpat-abcdef123456 ok'), 'ci [REDACTED:secret:gitlab] ok')
  assert.equal(redactSecrets('slack xoxb-123456-abcdefghij ok'), 'slack [REDACTED:secret:slack] ok')
  assert.equal(redactSecrets('apiKey=supersecretvalue here'), 'apiKey=[REDACTED:secret:credential] here')
  const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
  assert.equal(redactSecrets(pem), '[REDACTED:secret:pem]')
})

test('redactSecrets leaves ordinary text alone', () => {
  const text = 'The quick brown fox uses tokenRingBuffer for tokens.'
  assert.equal(redactSecrets(text), text)
})

test('absolutizeDates converts Chinese relative dates', () => {
  assert.equal(absolutizeDates('我们今天的会议', NOW), `我们${formatDate(NOW)}的会议`)
  assert.equal(absolutizeDates('昨天的构建失败', NOW), '2025-09-08的构建失败')
  assert.equal(absolutizeDates('明天发布', NOW), '2025-09-10发布')
  assert.equal(absolutizeDates('3 天前提交的', NOW), '2025-09-06提交的')
  assert.equal(absolutizeDates('2小时后重启', NOW), '2025-09-09 14:00重启')
  assert.equal(absolutizeDates('刚才运行了测试', NOW), '2025-09-09 12:00运行了测试')
  assert.equal(absolutizeDates('本周计划', NOW), 'the week of 2025-09-08计划')
  assert.equal(absolutizeDates('下周迭代', NOW), 'the week of 2025-09-15迭代')
  assert.equal(absolutizeDates('上周回顾', NOW), 'the week of 2025-09-01回顾')
})

test('absolutizeDates converts English relative dates', () => {
  assert.equal(absolutizeDates('do it today please', NOW), `do it ${formatDate(NOW)} please`)
  assert.equal(absolutizeDates('it broke yesterday', NOW), 'it broke 2025-09-08')
  assert.equal(absolutizeDates('2 days ago committed', NOW), '2025-09-07 committed')
  assert.equal(absolutizeDates('ship in 3 days', NOW), 'ship 2025-09-12')
  assert.equal(absolutizeDates('5 hours ago deployed', NOW), '2025-09-09 07:00 deployed')
  assert.equal(absolutizeDates('10 minutes ago started', NOW), '2025-09-09 11:50 started')
})

test('absolutizeDates leaves non-date text untouched', () => {
  const text = '明天见 means see you tomorrow — careful with 前天 too.'
  const out = absolutizeDates(text, NOW)
  assert.match(out, /2025-09-10见/)
  assert.match(out, /see you 2025-09-10/)
  // 前天 is not a handled shape; it must pass through unchanged.
  assert.ok(out.includes('前天'))
  assert.ok(out.includes('careful'))
})

test('oneLineError strips stack traces', () => {
  const err = [
    'Error: connect ECONNREFUSED 127.0.0.1:5432',
    '    at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16)',
    '    at processTicksAndRejections (internal/process/task_queues.js:93:5)',
  ].join('\n')
  assert.equal(oneLineError(err), 'Error: connect ECONNREFUSED 127.0.0.1:5432')
})

test('oneLineError keeps first and last meaningful lines', () => {
  const err = 'Traceback (most recent call last):\n  File "x.py", line 3\nValueError: bad input'
  assert.equal(oneLineError(err), 'ValueError: bad input')
})

test('oneLineError caps length', () => {
  const long = 'x'.repeat(500)
  assert.equal(oneLineError(long).length, 200)
})

test('sanitizeSlug normalizes names', () => {
  assert.equal(sanitizeSlug('Fix Login Bug!'), 'fix-login-bug')
  assert.equal(sanitizeSlug('Rust Arc<Mutex> 模式'), 'rust-arc-mutex-模式')
  assert.equal(sanitizeSlug('---'), 'memory')
  assert.equal(sanitizeSlug(''), 'memory')
  assert.equal(sanitizeSlug('a'.repeat(100)).length, 60)
})

test('capAssistant truncates with marker', () => {
  const text = 'y'.repeat(9000)
  const out = capAssistant(text, 8000)
  assert.ok(out.endsWith('[...truncated 1000 chars]'))
  assert.equal(out.length, 8000 + '\n\n[...truncated 1000 chars]'.length)
  assert.equal(capAssistant('short', 8000), 'short')
})

test('estimateTokens uses chars/4', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
})

test('blocksToText flattens content blocks', () => {
  const blocks = [
    { type: 'text', text: 'hello' },
    { type: 'image' },
    { type: 'thinking', text: 'hmm' },
    { type: 'other' },
  ]
  const out = blocksToText(blocks)
  assert.ok(out.includes('hello'))
  assert.ok(out.includes('[image]'))
  assert.ok(out.includes('[thinking: hmm]'))
  assert.ok(out.includes('[other]'))
})

const NEL = String.fromCharCode(0x85)
const BOM = String.fromCharCode(0xfeff)

test('trimLikeHypatia strips what Rust str::trim strips, not what String.trim does', () => {
  // hypatia trims each scope with Rust's `str::trim` (Unicode White_Space).
  assert.equal(trimLikeHypatia(`${NEL}nel${NEL}`), 'nel', 'U+0085 is White_Space; String.trim keeps it')
  assert.equal(trimLikeHypatia(`${BOM}bom`), `${BOM}bom`, 'U+FEFF is not White_Space; String.trim strips it')
  const wide = [0x3000, 0x2029, 0xa0, 0x1680, 0x2000, 0x200a, 0x202f, 0x205f].map((c) => String.fromCharCode(c)).join('')
  assert.equal(trimLikeHypatia(`${wide} \t项目\n${wide}`), '项目')
  assert.equal(trimLikeHypatia('a b'), 'a b', 'inner whitespace stays')
})

test('projectScope keeps a name hypatia already stored as given, even at the Unicode edges', () => {
  // A BOM-led name was written and queried consistently before; String.trim
  // would have moved it and stranded what it wrote.
  assert.equal(projectScope(`${BOM}bom`), `${BOM}bom`)
  // A NEL-ended name was stored trimmed, so its queries must be trimmed too.
  assert.equal(projectScope(`nel${NEL}`), 'nel')
  assert.equal(projectScope(String.fromCharCode(0xa0)), '/', 'whitespace only is the root name')
})
