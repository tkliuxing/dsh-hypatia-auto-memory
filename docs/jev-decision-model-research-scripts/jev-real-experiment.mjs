#!/usr/bin/env node
/**
 * 真实数据裁决实验 —— 读 scripts/jev-real-cases.json（由 extract-real-cases.mjs 生成），
 * 对每条真实 work unit + 真实候选调 Jev，输出 verdict/target/class 供人工判读。
 *
 * 用法：AI_GATEWAY_API_KEY=xxx node scripts/jev-real-experiment.mjs [--dry] [--raw]
 */
import { readFileSync } from 'node:fs'

const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/evaluate'
const MODEL = 'typesafe-ai/jev'
const DELAY_MS = 1000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const MAX_ATTEMPTS = 5
const RETRY_BASE_MS = 2000

async function ask(state, questions, key) {
  let attempt = 0
  while (true) {
    let res = null
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, state, questions }),
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

const VERDICT_CRITERIA = {
  duplicate: '说的是同一件事，重复',
  refines: '是某条已有记忆的更精确表述',
  extends: '在已有记忆上补充新内容，不改变它',
  supersedes: '有意取代某条旧记忆',
  contradicts: '与某条旧记忆矛盾，不能同时为真',
  unrelated: '没有实质关系（不确定时选这个）',
}
const CLASS_CRITERIA = {
  'one-shot': '一次性完成的独立任务记录',
  'correction-chain': '先犯错再纠正，含错误原因与正确做法',
  'bug-fix': '缺陷定位与修复过程',
  'design-decision': '设计取舍与理由',
  exploration: '探索性尝试与结论',
}

function targetCriteria(candidates) {
  const criteria = {}
  candidates.forEach((c, i) => { criteria[`c${i}`] = `${c.title}: ${c.desc}` })
  criteria.none = '以上候选都不相关'
  return criteria
}

function buildState(unit, candidates) {
  const lines = [`新记忆：${unit.title}`, unit.content.slice(0, 800), '', '已有记忆：']
  candidates.forEach((c, i) => lines.push(`${i + 1}. ${c.title}\n   ${c.desc}`))
  return lines.join('\n')
}

const cases = JSON.parse(readFileSync(new URL('./jev-real-cases.json', import.meta.url), 'utf8'))

async function main() {
  const dry = process.argv.includes('--dry')
  const raw = process.argv.includes('--raw')

  if (dry) {
    console.log('--dry：仅打印 state/questions --\n')
    for (const c of cases) {
      console.log(`### ${c.id}  (候选 ${c.candidates.length} 条)`)
      console.log(buildState(c.unit, c.candidates))
      console.log()
    }
    return
  }

  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) { console.error('✗ 请设置 AI_GATEWAY_API_KEY'); process.exit(1) }

  console.log(`===== 真实数据裁决（${cases.length} case，无标注，供人工判读）=====\n`)
  let deferCount = 0

  for (const c of cases) {
    await sleep(DELAY_MS) // 限流：请求间隔 1s
    const questions = {
      verdict: { type: 'choice', instructions: '新记忆与已有记忆最相关的一条是什么关系？', criteria: VERDICT_CRITERIA },
      target: { type: 'choice', instructions: '这条关系指向哪一条已有记忆？无关则选 none。', criteria: targetCriteria(c.candidates) },
      class: { type: 'choice', instructions: '新记忆属于哪一类工作单元？', criteria: CLASS_CRITERIA },
    }
    const data = await ask(buildState(c.unit, c.candidates), questions, key)
    const a = data.answers
    const conf = data.providerMetadata?.typesafe?.confidence ?? {}

    const v = a.verdict.choice
    const vProb = a.verdict.probabilities?.[v] ?? 0
    const vConf = conf.verdict ?? 0
    const t = a.target.choice
    const cls = a.class.choice
    const trust = vConf >= 0.6 && vProb >= 0.6
    if (!trust) deferCount++

    console.log(`[${c.id}]`)
    console.log(`  新记忆 : ${c.unit.title}`)
    c.candidates.forEach((cand, i) => console.log(`    c${i} : ${cand.title}`))
    console.log(`  verdict : ${v} (p=${vProb}, conf=${vConf})${trust ? '' : '  [低置信→会 defer]'}`)
    console.log(`  target  : ${t}`)
    console.log(`  class   : ${cls} (conf=${(conf.class ?? 0).toFixed(2)})`)
    if (raw) console.log(`  raw     : ${JSON.stringify(data)}\n`)
    console.log()
  }
  console.log(`触发 defer: ${deferCount}/${cases.length}`)
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1) })
