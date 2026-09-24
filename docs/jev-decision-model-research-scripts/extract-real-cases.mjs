#!/usr/bin/env node
/**
 * 从真实 hypatia shelf 抽取裁决基准数据 → scripts/jev-real-cases.json
 *
 * 每个 case：一条真实 wu-* work unit + 通过 `hypatia similar` 挖出的真实候选（≤3，
 * 复刻 writer.findCandidates 的过滤：排除自身、排除 operational 层、distance≤0.45）。
 *
 * 只读、不写 shelf。产出的 JSON 供 scripts/jev-real-experiment.mjs 调 Jev 用。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const UNIT_NAMES = [
  'wu-laya-hypatia-integration-feasibility-2074caf9',
  'wu-adjudication-integration-dc4a3090',
  'wu-建立跨宿主统一memory契约-3571ed41',
  'wu-现场协议资料仍是实施阻塞项-a027babb',
  'wu-s7-200硬件与i-o容量判断-1c91c56b',
  'wu-issue-22-jse-literal-silently-ignored-530c38f6',
  'wu-svg-sanitization-f6efd4d7',
  'wu-sqlite-read-write-sandbox-boundary-bbba387e',
  'wu-lifecycle-via-relations-85a201f4',
  'wu-memory-provider-collision-f12a21cf',
  'wu-修复安全授权与内容脱敏-a419f36d',
  'wu-raster-policy-6617d829',
]

const OPERATIONAL_PREFIXES = ['msg-', 'sum', 'session-', 'hypatia-dream-run-']
const MAX_DISTANCE = 0.45

function sh(cmd) {
  return execFileSync('hypatia', cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function slugFromName(name) {
  // wu-<slug>-<hash8> → <slug>
  return name.replace(/^wu-/, '').replace(/-[0-9a-f]{8}$/, '')
}

function isOperational(name) {
  return OPERATIONAL_PREFIXES.some((p) => name.startsWith(p))
}

function getUnit(name) {
  const row = JSON.parse(sh(['knowledge-get', name]))
  const data = row.content?.data ?? ''
  const title = slugFromName(name)
  return { name, title, content: data }
}

function getCandidates(unit) {
  const query = `${unit.title}\n${unit.content}`.slice(0, 500)
  let rows
  try {
    rows = JSON.parse(sh(['similar', query, '-t', 'knowledge', '--limit', '12',
      '--exclude-tags', 'message,summary,session,hypatia-dream-run']))
  } catch (e) {
    // 老 hypatia 可能不接受 --exclude-tags，退化为不带该 flag
    rows = JSON.parse(sh(['similar', query, '-t', 'knowledge', '--limit', '12']))
  }
  return rows
    .filter((r) => r.name !== unit.name)
    .filter((r) => !isOperational(r.name))
    .filter((r) => typeof r.distance !== 'number' || r.distance <= MAX_DISTANCE)
    .slice(0, 3)
    .map((r) => {
      const body = (r.content?.data ?? '').replace(/\s+/g, ' ')
      return { name: r.name, title: slugFromName(r.name), desc: body.slice(0, 200), full: body.slice(0, 600) }
    })
}

const cases = []
for (const name of UNIT_NAMES) {
  try {
    const unit = getUnit(name)
    const candidates = getCandidates(unit)
    cases.push({ id: slugFromName(name), unit: { name: unit.name, title: unit.title, content: unit.content }, candidates })
    console.log(`✓ ${name} → ${candidates.length} candidates`)
    for (const c of candidates) console.log(`    - ${c.title} (${c.name})`)
  } catch (e) {
    console.log(`✗ ${name}: ${e.message}`)
  }
}

writeFileSync(new URL('./jev-real-cases.json', import.meta.url), JSON.stringify(cases, null, 2))
console.log(`\n写入 ${cases.length} 个 case → scripts/jev-real-cases.json`)
