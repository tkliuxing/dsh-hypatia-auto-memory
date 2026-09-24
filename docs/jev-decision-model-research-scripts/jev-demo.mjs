#!/usr/bin/env node
/**
 * Jev DEMO — 通过 Vercel AI Gateway 试用 TypeSafe AI 的 Jev 决策模型。
 *
 * Jev 不是 chat/completions 模型，不走 /v1/chat/completions；
 * 它走专门的评估接口 /v1/evaluate，输入 state + 一组 typed questions，
 * 返回 choice / score / boolean 三种带概率的答案。
 *
 * 用法：
 *   AI_GATEWAY_API_KEY=xxx node scripts/jev-demo.mjs ["<自定义 state 文本>"]
 *
 * 缺省 state 是一段"自动记忆入库"场景的样例，四个问题分别对应插件里
 * 真实存在的决策点：记忆是否值得存、与已有记忆的关系、工作单元分类、重要程度。
 */

const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/evaluate'
const MODEL = 'typesafe-ai/jev'

// —— 与 dsh-hypatia-auto-memory 真实决策点一一对应的默认问题 ——
const DEFAULT_STATE = [
  '新记忆（work unit）：',
  '"跨线程共享可变状态时用 Arc<Mutex<T>>，不要用 RefCell<T>；',
  ' 异步上下文里才考虑 tokio::sync::Mutex。"',
  '',
  '已有记忆（候选）：',
  '1. "Rust 共享可变状态用 Mutex 包一层"',
  '2. "anyhow 用于应用层错误处理"',
  '3. "tokio::sync::Mutex 比 std::sync::Mutex 更慢，非异步别用"',
].join('\n')

const DEFAULT_QUESTIONS = {
  // Noul / boolean —— 对应"值不值得存"的门控
  memoryWorthy: {
    type: 'boolean',
    instructions: '这条新记忆是否值得作为长期记忆保存（含可复用的具体做法/非显而易见的细节）？',
    criteria: {
      true: '包含可复用、具体、非显而易见的技术结论',
      false: '是闲聊、日志、或无法复用的泛泛而谈',
    },
  },
  // Choice —— 对应 consolidator.adjudicate 的 6 选 1 关系裁决
  relationship: {
    type: 'choice',
    instructions: '这条新记忆与"已有记忆"里最相关的一条是什么关系？',
    criteria: {
      duplicate: '说的是同一件事，重复',
      refines: '是某条已有记忆的更精确表述',
      extends: '在已有记忆之上补充新内容，不改变它',
      supersedes: '有意取代某条旧记忆',
      contradicts: '与某条旧记忆矛盾，两者不能同时为真',
      unrelated: '没有实质关系（不确定时选这个）',
    },
  },
  // Choice —— 对应 consolidationInstruction 里的 5 分类
  classification: {
    type: 'choice',
    instructions: '这条工作单元属于哪一类？',
    criteria: {
      'one-shot': '一次性完成的独立任务记录',
      'correction-chain': '先犯错再纠正，含错误原因与正确做法',
      'bug-fix': '缺陷定位与修复过程',
      'design-decision': '设计取舍与理由',
      exploration: '探索性尝试与结论',
    },
  },
  // Score —— 0-3 有序评分
  importance: {
    type: 'score',
    instructions: '这条记忆的重要程度？',
    criteria: [
      '普通：仅需记录，很少被检索',
      '有用：值得以后检索复用',
      '关键：影响后续决策与做法',
      '核心：项目的基石约定',
    ],
  },
}

function usage() {
  console.error('用法: AI_GATEWAY_API_KEY=xxx node scripts/jev-demo.mjs ["<自定义 state>"]')
  process.exit(2)
}

async function main() {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) {
    console.error('✗ 环境变量 AI_GATEWAY_API_KEY 未设置。')
    console.error('  请先 export AI_GATEWAY_API_KEY=... 再运行，或直接内联到命令前面。')
    process.exit(1)
  }

  const state = process.argv.slice(2).join(' ') || DEFAULT_STATE

  console.log(`→ 调用 ${ENDPOINT}  model=${MODEL}`)
  console.log(`→ state（${state.length} 字符）：\n${state}\n`)

  let res
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, state, questions: DEFAULT_QUESTIONS }),
    })
  } catch (error) {
    console.error(`✗ 请求失败（网络错误）: ${error.message}`)
    process.exit(1)
  }

  const raw = await res.text()
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    data = null
  }

  if (!res.ok) {
    console.error(`✗ HTTP ${res.status} ${res.statusText}`)
    console.error(raw)
    process.exit(1)
  }

  console.log('—— 原始响应 ——')
  console.log(JSON.stringify(data, null, 2))
  console.log('\n—— 解读 ——')

  const answers = data?.answers ?? {}
  const confidence = data?.providerMetadata?.typesafe?.confidence ?? {}

  for (const [qid, q] of Object.entries(DEFAULT_QUESTIONS)) {
    const a = answers[qid]
    if (!a) continue
    if (q.type === 'boolean') {
      const p = a.probability
      console.log(`• ${qid}: P(true)=${p}  →  ${p >= 0.8 ? '是' : p <= 0.2 ? '否' : '不确定'}`)
    } else if (q.type === 'choice') {
      const conf = confidence[qid]
      console.log(`• ${qid}: ${a.choice}  (confidence=${conf ?? 'n/a'})`)
      if (a.probabilities) {
        console.log(`    ${Object.entries(a.probabilities).map(([k, v]) => `${k}=${v}`).join('  ')}`)
      }
    } else if (q.type === 'score') {
      console.log(`• ${qid}: ${a.score}  (0-${q.criteria.length - 1} 标尺)`)
    }
  }

  const usage_ = data?.usage
  if (usage_) {
    console.log(`\ntoken: input=${usage_.inputTokens} output=${usage_.outputTokens}`)
  }
  const cost = data?.providerMetadata?.gateway?.cost
  if (cost) {
    console.log(`cost:  $${cost}`)
  }
}

main().catch((error) => {
  console.error(`✗ 未预期错误: ${error.stack ?? error}`)
  process.exit(1)
})
