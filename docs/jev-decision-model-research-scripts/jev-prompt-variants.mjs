#!/usr/bin/env node
/**
 * 提问方式对照实验 —— 同一批真实 case，两种提问策略各问一遍，对比是否打破
 * "extends 塌缩 + target=c0" 的偏差。
 *
 * V-A 原子化：拆成独立布尔（isDuplicate / contradicts / isUnrelated）+ 窄选择（relKind），
 *             在代码里按优先级组合成最终 verdict。
 * V-B 完整上下文：喂完整候选正文（600 字）+ 显式"宁可缺边不可错边"指令 + related 布尔门。
 *
 * 用法：AI_GATEWAY_API_KEY=xxx node scripts/jev-prompt-variants.mjs [--raw]
 */
import { readFileSync } from 'node:fs'

const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/evaluate'
const MODEL = 'typesafe-ai/jev'
const DELAY_MS = 1000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MAX_ATTEMPTS = 5
const RETRY_BASE_MS = 2000

const cases = JSON.parse(readFileSync(new URL('./jev-real-cases.json', import.meta.url), 'utf8'))

function targetCriteria(candidates) {
  const c = {}
  candidates.forEach((x, i) => { c[`c${i}`] = `${x.title}: ${x.desc}` })
  c.none = '以上候选都不相关'
  return c
}

// 短上下文（baseline 同款）：候选只带 200 字
function stateShort(unit, candidates) {
  const lines = [`新记忆：${unit.title}`, unit.content.slice(0, 800), '', '已有记忆：']
  candidates.forEach((c, i) => lines.push(`${i + 1}. ${c.title}\n   ${c.desc}`))
  return lines.join('\n')
}

// 完整上下文：候选带 600 字
function stateFull(unit, candidates) {
  const lines = [`新记忆：${unit.title}`, unit.content.slice(0, 1200), '', '已有记忆（完整）：']
  candidates.forEach((c, i) => lines.push(`### ${i + 1}. ${c.title}\n${c.full}`))
  return lines.join('\n')
}

// ---- V-A 原子化问题 ----
function questionsAtomic(candidates) {
  return {
    isDuplicate: {
      type: 'boolean',
      instructions: '新记忆是否与某条候选记忆说的是同一件事（核心结论近乎重复）？',
      criteria: { true: '核心结论与某条候选同义，只是措辞不同', false: '没有任何候选与新记忆重复' },
    },
    contradicts: {
      type: 'boolean',
      instructions: '新记忆是否与某条候选记忆明确矛盾（两者不能同时为真）？',
      criteria: { true: '新记忆的结论与某条候选直接冲突', false: '没有矛盾' },
    },
    isUnrelated: {
      type: 'boolean',
      instructions: '新记忆是否与所有候选记忆都没有实质关系？',
      criteria: { true: '主题或内容不同，不该连边', false: '与至少一条候选有实质关系' },
    },
    relKind: {
      type: 'choice',
      instructions: '（若非重复、非矛盾、非无关）新记忆与最相关候选的关系是？',
      criteria: { refines: '更精确、更具体的表述，不改变结论', extends: '补充新的独立信息，不改变原结论', supersedes: '明确取代某条旧结论' },
    },
    target: { type: 'choice', instructions: '若相关，最相关的是哪一条？都无关选 none。', criteria: targetCriteria(candidates) },
  }
}

// ---- V-B 完整上下文 + 反连边指令 ----
function questionsFullContext(candidates) {
  return {
    related: {
      type: 'boolean',
      instructions: '新记忆与任一候选是否有值得建立边的实质关系？不确定或关系弱就回答 false。',
      criteria: { true: '有明确、实质的语义关系，值得连边', false: '关系弱、模糊或无关（宁可缺边，不可错边）' },
    },
    verdict: {
      type: 'choice',
      instructions: '新记忆与最相关候选的关系。不确定就选 unrelated——错连边比缺边更糟。',
      criteria: {
        duplicate: '核心结论相同，仅措辞不同，内容实质重复',
        refines: '把某条候选说得更精确/更具体，且不改变其结论',
        extends: '在候选基础上补充新的、独立的信息，不改变原结论',
        supersedes: '明确宣布取代某条旧结论（旧的作废）',
        contradicts: '结论与某条候选直接冲突，不能同时为真',
        unrelated: '没有实质关系；不确定时选这个',
      },
    },
    target: { type: 'choice', instructions: '这条关系指向哪一条？无关选 none。', criteria: targetCriteria(candidates) },
  }
}

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
      res = null // 网络错误，按可重试处理
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

const BOOL_YES = 0.7

function combineAtomic(a, conf) {
  const d = a.isDuplicate?.probability ?? 0
  const c = a.contradicts?.probability ?? 0
  const u = a.isUnrelated?.probability ?? 0
  const rel = a.relKind?.choice ?? ''
  if (c >= BOOL_YES) return `contradicts(contra=${c.toFixed(2)})`
  if (d >= BOOL_YES) return `duplicate(dup=${d.toFixed(2)})`
  if (u >= BOOL_YES) return `unrelated(unrel=${u.toFixed(2)})`
  return `${rel}(dup=${d.toFixed(2)},contra=${c.toFixed(2)},unrel=${u.toFixed(2)})`
}

async function main() {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) { console.error('✗ 请设置 AI_GATEWAY_API_KEY'); process.exit(1) }

  console.log(`===== 提问方式对照（${cases.length} case，V-A 原子化 vs V-B 完整上下文）=====\n`)
  for (const c of cases) {
    await sleep(DELAY_MS)
    const ra = await ask(stateShort(c.unit, c.candidates), questionsAtomic(c.candidates), key)
    await sleep(DELAY_MS)
    const rb = await ask(stateFull(c.unit, c.candidates), questionsFullContext(c.candidates), key)

    const aA = ra.answers
    const aB = rb.answers
    const confA = ra.providerMetadata?.typesafe?.confidence ?? {}
    const confB = rb.providerMetadata?.typesafe?.confidence ?? {}

    const verdictA = combineAtomic(aA, confA)
    const relB = aB.related?.probability ?? 0
    const verdictB = relB < 0.5 ? 'unrelated(related-gate)' : aB.verdict?.choice

    console.log(`[${c.id}]`)
    console.log(`  V-A 原子   : ${verdictA} → target ${aA.target?.choice} (relConf=${(confA.relKind ?? 0).toFixed(2)})`)
    console.log(`  V-B 上下文 : related=${relB.toFixed(2)}  verdict=${verdictB} (p=${(aB.verdict?.probabilities?.[aB.verdict?.choice] ?? 0).toFixed(2)}, conf=${(confB.verdict ?? 0).toFixed(2)}) → target ${aB.target?.choice}`)
    console.log()
  }
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1) })
