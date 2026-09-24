#!/usr/bin/env node
/**
 * Jev 裁决实验 —— 用带人工标注的小基准，测 Jev 在插件 adjudicate 任务上的准确率。
 *
 * 每个 case 模拟 consolidator.adjudicate 的真实输入：一条新记忆 + 最多 3 条候选旧记忆，
 * 问三题（并行）：
 *   - verdict : 6 选 1 关系裁决（duplicate/refines/extends/supersedes/contradicts/unrelated）
 *   - target  : 选指向哪条候选（c0/c1/c2/none）
 *   - class   : 5 选 1 工作单元分类
 *
 * 再用一组独立 case 测 memoryWorthy 门控（boolean）。
 *
 * 用法：AI_GATEWAY_API_KEY=xxx node scripts/jev-adjudication-experiment.mjs [--raw]
 */

const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/evaluate'
const MODEL = 'typesafe-ai/jev'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MAX_ATTEMPTS = 5
const RETRY_BASE_MS = 2000

// —— 采信阈值（可在此调）——
const VERDICT_CONF = 0.6
const VERDICT_PROB = 0.6

const VERDICTS = ['duplicate', 'refines', 'extends', 'supersedes', 'contradicts', 'unrelated']
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

// target 选项用 c0/c1/c2/none，描述里放真实标题
function targetCriteria(candidates) {
  const criteria = {}
  candidates.forEach((c, i) => { criteria[`c${i}`] = `${c.title}: ${c.desc}` })
  criteria.none = '以上候选都不相关'
  return criteria
}

function buildState(unit, candidates) {
  const lines = [`新记忆：${unit.title}`, unit.content, '', '已有记忆：']
  candidates.forEach((c, i) => lines.push(`${i + 1}. ${c.title}\n   ${c.desc}`))
  return lines.join('\n')
}

// ============ 标注数据 ============

// target: 候选下标 0/1/2，null 表示 none
const ADJUDICATION_CASES = [
  {
    id: 'A1',
    label: { verdict: 'duplicate', target: 0 },
    unit: { title: '跨线程共享可变状态', content: '跨线程共享可变状态要用 Arc<Mutex<T>> 包起来。' },
    candidates: [
      { title: '共享可变状态用 Mutex', desc: '跨线程共享可变状态用 Arc<Mutex<T>> 包一层，不用 RefCell<T>。' },
      { title: '错误处理用 anyhow', desc: '应用层错误处理统一用 anyhow，不用到处 unwrap。' },
      { title: '日志用 tracing', desc: '结构化日志用 tracing，不要用 println!。' },
    ],
  },
  {
    id: 'A2',
    label: { verdict: 'refines', target: 0 },
    unit: { title: '连接池用 deadpool-postgres', content: '数据库连接池用 deadpool-postgres，每个请求借用一条连接而不是长期持有。' },
    candidates: [
      { title: '用连接池管理数据库连接', desc: '数据库连接要放到连接池里管理。' },
      { title: 'Redis 缓存设 TTL', desc: 'Redis 做缓存要设置 TTL 防止膨胀。' },
      { title: 'SQL 加 LIMIT', desc: '列表查询要加 LIMIT 防止全表扫。' },
    ],
  },
  {
    id: 'A3',
    label: { verdict: 'extends', target: 0 },
    unit: { title: '连接上加 statement_timeout', content: '除了连接池，还要给连接设 statement_timeout，防止慢查询拖垮整个池。' },
    candidates: [
      { title: '用连接池管理数据库连接', desc: '数据库连接要放到连接池里管理。' },
      { title: 'HTTP 客户端设超时', desc: 'HTTP 客户端要设 connect/read 超时。' },
      { title: '前端组件拆分', desc: '大组件要拆成小组件便于维护。' },
    ],
  },
  {
    id: 'A4',
    label: { verdict: 'supersedes', target: 0 },
    unit: { title: '读多写少改用 RwLock', content: '并发控制改用 tokio::sync::RwLock 替代之前的一把全局 Mutex，读多写少场景 Mutex 是瓶颈。' },
    candidates: [
      { title: '全局状态用一把大 Mutex', desc: '全局可变状态用一把大 Mutex 保护。' },
      { title: '配置用环境变量注入', desc: '配置通过环境变量注入，不硬编码。' },
      { title: '错误向上传播', desc: '底层错误用 ? 向上传播，不吞掉。' },
    ],
  },
  {
    id: 'A5',
    label: { verdict: 'contradicts', target: 0 },
    unit: { title: '跨线程共享状态用 RefCell', content: 'Rust 跨线程共享可变状态应该用 RefCell<T>，因为它比 Mutex 快。' },
    candidates: [
      { title: '共享可变状态用 Mutex', desc: '跨线程共享可变状态用 Arc<Mutex<T>>；RefCell 不是线程安全的。' },
      { title: '迭代器更地道', desc: '优先用迭代器而不是手写循环。' },
      { title: 'String 存储', desc: '拥有的字符串用 String，引用用 &str。' },
    ],
  },
  {
    id: 'A6',
    label: { verdict: 'unrelated', target: null },
    unit: { title: 'CSS 用 flex 布局', content: '布局用 flex 比 float 更省心，配合 gap 控制间距。' },
    candidates: [
      { title: '共享可变状态用 Mutex', desc: '跨线程共享可变状态用 Arc<Mutex<T>>。' },
      { title: '数据库连接池', desc: '数据库连接放连接池管理。' },
      { title: '错误处理用 anyhow', desc: '应用层错误用 anyhow。' },
    ],
  },
]

// gate cases: true = 该存，false = 不该存（闲聊/日志）
const GATE_CASES = [
  { id: 'G1', label: true, state: '修复了登录接口在生产环境 500 的问题：根因是缓存 key 冲突，回滚后恢复。' },
  { id: 'G2', label: true, state: '结论：跨线程共享可变状态用 Arc<Mutex<T>>，不要用 RefCell<T>。' },
  { id: 'G3', label: false, state: '好的，明白了。' },
  { id: 'G4', label: false, state: '收到，我这就去办。' },
]

// ============ 调用与评分 ============

async function evaluate(state, questions, key) {
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

async function main() {
  const raw = process.argv.includes('--raw')
  const dry = process.argv.includes('--dry')

  if (dry) {
    console.log('--dry：仅打印将发送的 state/questions，不发请求 --\n')
    for (const c of ADJUDICATION_CASES) {
      console.log(`### ${c.id} (期望 ${c.label.verdict}→${c.label.target === null ? 'none' : 'c' + c.label.target})`)
      console.log(buildState(c.unit, c.candidates))
      console.log('questions:', JSON.stringify({
        verdict: { type: 'choice', criteria: VERDICT_CRITERIA },
        target: { type: 'choice', criteria: targetCriteria(c.candidates) },
        class: { type: 'choice', criteria: CLASS_CRITERIA },
      }, null, 2))
      console.log()
    }
    for (const g of GATE_CASES) {
      console.log(`### ${g.id} (期望 ${g.label}) state:\n${g.state}\n`)
    }
    return
  }

  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) {
    console.error('✗ 请设置 AI_GATEWAY_API_KEY')
    process.exit(1)
  }

  // ---- 裁决部分 ----
  console.log('===== 裁决基准（verdict + target + class）=====\n')
  let verdictOk = 0, targetOk = 0, bothOk = 0, deferCount = 0

  for (const c of ADJUDICATION_CASES) {
    const questions = {
      verdict: { type: 'choice', instructions: '新记忆与已有记忆最相关的一条是什么关系？', criteria: VERDICT_CRITERIA },
      target: { type: 'choice', instructions: '这条关系指向哪一条已有记忆？无关则选 none。', criteria: targetCriteria(c.candidates) },
      class: { type: 'choice', instructions: '新记忆属于哪一类工作单元？', criteria: CLASS_CRITERIA },
    }
    const data = await evaluate(buildState(c.unit, c.candidates), questions, key)
    const a = data.answers
    const conf = data.providerMetadata?.typesafe?.confidence ?? {}

    const v = a.verdict.choice
    const vProb = a.verdict.probabilities?.[v] ?? 0
    const vConf = conf.verdict ?? 0
    const t = a.target.choice // 'c0'|'c1'|'c2'|'none'
    const tIdx = t === 'none' ? null : Number(t.slice(1))
    const cls = a.class.choice

    const vOK = v === c.label.verdict
    const tOK = tIdx === c.label.target
    const trust = vConf >= VERDICT_CONF && vProb >= VERDICT_PROB
    const effectiveV = trust ? v : '(defer→unrelated)'
    const vEffOK = trust ? vOK : (c.label.verdict === 'unrelated')

    if (vOK) verdictOk++
    if (tOK) targetOk++
    if (vOK && tOK) bothOk++
    if (!trust) deferCount++

    console.log(`[${c.id}] 期望 ${c.label.verdict}→${c.label.target === null ? 'none' : 'c' + c.label.target}`)
    console.log(`   verdict: ${v} (p=${vProb}, conf=${vConf}) ${vOK ? '✓' : '✗'}${trust ? '' : '  [低置信，实际会 defer]'}`)
    console.log(`   target : ${t} ${tOK ? '✓' : '✗'}`)
    console.log(`   class  : ${cls} (conf=${(conf.class ?? 0).toFixed(2)})`)
    if (raw) console.log(`   raw    : ${JSON.stringify(data)}\n`)
    console.log()
  }

  console.log(`verdict 准确: ${verdictOk}/${ADJUDICATION_CASES.length}`)
  console.log(`target  准确: ${targetOk}/${ADJUDICATION_CASES.length}`)
  console.log(`两者全对   : ${bothOk}/${ADJUDICATION_CASES.length}`)
  console.log(`触发 defer : ${deferCount}/${ADJUDICATION_CASES.length}  (低置信回退 unrelated)\n`)

  // ---- 门控部分 ----
  console.log('===== memoryWorthy 门控基准 =====\n')
  let gateOk = 0
  let gateDefer = 0
  for (const g of GATE_CASES) {
    const questions = {
      memoryWorthy: {
        type: 'boolean',
        instructions: '这段内容是否值得作为长期记忆保存（含可复用、具体的技术结论/约定）？',
        criteria: {
          true: '含可复用、具体、非显而易见的技术结论或约定',
          false: '闲聊、寒暄、单纯的确认，或无可复用信息的日志',
        },
      },
    }
    const data = await evaluate(g.state, questions, key)
    const p = data.answers.memoryWorthy.probability
    // 三档：>=0.7 存，<=0.3 不存，中间 defer（不单独计对错）
    const pred = p >= 0.7 ? true : p <= 0.3 ? false : 'defer'
    const ok = pred === g.label
    if (pred === 'defer') gateDefer++
    else if (ok) gateOk++
    console.log(`[${g.id}] 期望 ${g.label}   P(true)=${p}  判定=${pred} ${pred === g.label ? '✓' : pred === 'defer' ? '△(defer)' : '✗'}`)
    console.log(`   state: ${g.state}\n`)
  }
  console.log(`门控（非 defer 且判对）: ${gateOk}/${GATE_CASES.length}，defer ${gateDefer}/${GATE_CASES.length}`)
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1) })
