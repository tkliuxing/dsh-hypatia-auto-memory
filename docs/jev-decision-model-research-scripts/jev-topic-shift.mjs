#!/usr/bin/env node
/**
 * topic-shift 检测实验 —— 读 scripts/jev-topic-cases.json，对每个 turn 边界问 Jev：
 * 「新消息是否切换到了一个明显不同的主题/任务？」
 *
 * 用法：AI_GATEWAY_API_KEY=xxx node scripts/jev-topic-shift.mjs [--dry]
 */
import { readFileSync } from 'node:fs'

const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/evaluate'
const MODEL = 'typesafe-ai/jev'
const DELAY_MS = 1000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MAX_ATTEMPTS = 5
const RETRY_BASE_MS = 2000

const cases = JSON.parse(readFileSync(new URL('./jev-topic-cases.json', import.meta.url), 'utf8'))

function buildState(c) {
  return ['上文（上一轮结尾）：', c.ctx, '', '新消息：', c.next].join('\n')
}

const QUESTIONS = {
  topicShift: {
    type: 'boolean',
    instructions: '新消息是否切换到了一个明显不同的主题或任务（相对于上文）？',
    criteria: {
      true: '新消息开始了一个与上文明显不同的新主题、新任务或新领域',
      false: '新消息是上文的自然延续：同一主题的追问、补充、反馈、结果粘贴或细化',
    },
  },
}

async function ask(state, key) {
  let attempt = 0
  while (true) {
    let res = null
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, state, questions: QUESTIONS }),
      })
    } catch {
      res = null
    }
    if (res && res.ok) return res.json()
    const status = res ? res.status : 0
    const retryable = res === null || status === 429 || status === 503 || (status >= 500 && status < 600)
    if (!retryable) {
      const body = res ? await res.text() : 'network error'
      throw new Error(`HTTP ${status}: ${body.slice(0, 200)}`)
    }
    if (++attempt > MAX_ATTEMPTS) {
      throw new Error(`重试 ${MAX_ATTEMPTS} 次仍失败: ${res ? `HTTP ${status}` : '网络错误'}`)
    }
    const delay = RETRY_BASE_MS * 2 ** (attempt - 1)
    console.log(`  ⏳ HTTP ${status || '网络错误'}，${delay / 1000}s 后重试 (${attempt}/${MAX_ATTEMPTS})`)
    await sleep(delay)
  }
}

async function main() {
  if (process.argv.includes('--dry')) {
    console.log('--dry：仅打印 state --\n')
    for (const c of cases) console.log(`### ${c.id} (${c.label ? 'SHIFT' : 'NO-SHIFT'})\n${buildState(c)}\n`)
    return
  }
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) { console.error('✗ 请设置 AI_GATEWAY_API_KEY'); process.exit(1) }

  console.log(`===== topic-shift 检测（${cases.length} case）=====\n`)
  let ok = 0
  let defer = 0
  let wrong = 0

  for (const c of cases) {
    await sleep(DELAY_MS)
    const data = await ask(buildState(c), key)
    const p = data.answers.topicShift.probability
    const pred = p >= 0.7 ? true : p <= 0.3 ? false : 'defer'
    const tag = c.synthetic ? ' [合成]' : ''
    if (pred === 'defer') defer++
    else if (pred === c.label) ok++
    else wrong++

    console.log(`[${c.id}]${tag} 期望=${c.label ? 'SHIFT' : 'NO-SHIFT'}  P(shift)=${p.toFixed(2)} → ${pred === 'defer' ? 'defer' : pred ? 'SHIFT' : 'NO-SHIFT'} ${pred === 'defer' ? '△' : pred === c.label ? '✓' : '✗'}`)
    console.log(`    next: ${c.next.slice(0, 70)}${c.next.length > 70 ? '…' : ''}`)
    if (pred !== 'defer' && pred !== c.label) {
      console.log(`    ctx : ${c.ctx.slice(0, 70)}…`)
    }
    console.log()
  }
  console.log(`判对 ${ok}/${cases.length}，判错 ${wrong}/${cases.length}，defer ${defer}/${cases.length}`)
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1) })
