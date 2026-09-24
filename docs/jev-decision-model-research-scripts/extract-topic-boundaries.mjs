#!/usr/bin/env node
/**
 * 抽取 topic-shift 基准 → scripts/jev-topic-cases.json
 *
 * 每个 case 模拟 consolidation 在一个 turn 边界要问的问题：
 *   state = 上文（上一轮 assistant 的最后发言，截 300 字）+ 新用户消息
 *   label = true(切话题) / false(没切)
 *
 * 从真实 msg-* 消息抽取（只读），外加 2 条合成的明显跨域切换作对照。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const SID = {
  jev: 'msg-session-c0a2e062-3f4f-45d4-bb51-3c3e8d37e852',
  issues: 'msg-session-7f23632f-7d3a-416a-b130-b8ac5aac3f82',
  import: 'msg-session-85b3d446-65d2-4ccd-b025-2de2e7330f17',
  dream: 'msg-session-ef832d10-c28b-473f-b7e9-51d8a2dcbd61',
}

// label: true = 切话题（应开新 span），false = 未切
const CASES = [
  { id: 'F1', label: false, ctx: { sid: SID.jev, ord: 2 }, next: { sid: SID.jev, ord: 3 } },
  { id: 'F2', label: false, ctx: { sid: SID.jev, ord: 6 }, next: { sid: SID.jev, ord: 7 } },
  { id: 'F3', label: false, ctx: { sid: SID.jev, ord: 11 }, next: { sid: SID.jev, ord: 12 } },
  { id: 'F4', label: false, ctx: { sid: SID.jev, ord: 21 }, next: { sid: SID.jev, ord: 22 } },
  { id: 'F5', label: false, ctx: { sid: SID.issues, ord: 7 }, next: { sid: SID.issues, ord: 8 } },
  { id: 'F6', label: false, ctx: { sid: SID.import, ord: 209 }, next: { sid: SID.import, ord: 210 } },
  { id: 'T1', label: true, ctx: { sid: SID.jev, ord: 4 }, next: { sid: SID.jev, ord: 5 } },
  { id: 'T2', label: true, ctx: { sid: SID.import, ord: 219 }, next: { sid: SID.import, ord: 220 } },
  { id: 'T3', label: true, ctx: { sid: SID.dream, ord: 30 }, next: { sid: SID.dream, ord: 31 } },
  { id: 'T4', label: true, ctx: { sid: SID.jev, ord: 29 }, next: { sid: SID.jev, ord: 30 } },
  // 合成对照：明显跨域切换
  {
    id: 'T5', label: true, synthetic: true,
    ctxText: '重试生效了，但结果很干脆地给出了一个负面结论——换问法没用。Jev 零样本做不了细粒度内容差异判断，裁决这条路是死路。',
    nextText: '帮我写一个 Python 爬虫，抓取全国城市天气数据并保存成 CSV。',
  },
  {
    id: 'T6', label: true, synthetic: true,
    ctxText: '艾莫迅导入工具全部完成，质量门通过。下面是交付说明和使用步骤。',
    nextText: '晚上吃什么？帮我推荐一个简单的菜谱。',
  },
]

function content(name) {
  const row = JSON.parse(execFileSync('hypatia', ['knowledge-get', name], { encoding: 'utf8' }))
  const data = row.content?.data ?? ''
  const m = /## Content\n([\s\S]*)/.exec(data)
  return (m ? m[1] : data).replace(/\s+/g, ' ').trim()
}

const out = []
for (const c of CASES) {
  let ctxText, nextText
  if (c.synthetic) {
    ctxText = c.ctxText
    nextText = c.nextText
  } else {
    ctxText = content(`${c.ctx.sid}-${c.ctx.ord}`).slice(0, 300)
    nextText = content(`${c.next.sid}-${c.next.ord}`)
  }
  out.push({ id: c.id, label: c.label, synthetic: !!c.synthetic, ctx: ctxText, next: nextText })
  console.log(`✓ ${c.id} (label=${c.label ? 'SHIFT' : 'NO-SHIFT'})`)
  console.log(`    ctx : ${ctxText.slice(0, 90)}…`)
  console.log(`    next: ${nextText.slice(0, 90)}${nextText.length > 90 ? '…' : ''}\n`)
}

writeFileSync(new URL('./jev-topic-cases.json', import.meta.url), JSON.stringify(out, null, 2))
console.log(`写入 ${out.length} 个 case → scripts/jev-topic-cases.json`)
