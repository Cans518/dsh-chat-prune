/**
 * 用真实的 $DSH_HOME 跑 listSessions，确认：
 *   1. 标题能从 zstd 多帧日志里解出来
 *   2. 可选地与调用者通过 DSH_EXPECTED_TITLES 提供的 JSON 标题数组对照
 *
 * 这是「按钮不出现」的根因修复的验证 —— 客户端靠这个 map 把
 * 只有标题的行反查回 sessionId。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { listSessions } from '../lib/index.js'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')

const ctx = {
  profileContext: { home },
  sessions: {
    get: () => undefined,
    list: { getSnapshot: () => ({ byId: {} }) },
  },
}

console.log('\n== 真实会话日志的标题解析 ==\n')

const rows = await listSessions(ctx)
console.log(`共 ${rows.length} 个会话\n`)

let withTitle = 0
for (const r of rows) {
  if (r.title) withTitle += 1
}

console.log(`\n有标题的: ${withTitle} / ${rows.length}`)

// No personal conversation titles or IDs are embedded or printed.
const observed = JSON.parse(process.env.DSH_EXPECTED_TITLES || '[]')
if (!Array.isArray(observed) || observed.some((title) => typeof title !== 'string')) {
  throw new Error('DSH_EXPECTED_TITLES must be a JSON array of strings')
}
const titles = rows.map((r) => r.title).filter(Boolean)
for (const [index, title] of observed.entries()) {
  const hit = titles.includes(title)
  console.log(`  ${hit ? 'ok  ' : 'MISS'} expected title #${index + 1}`)
  if (!hit) process.exitCode = 1
}

if (withTitle === 0) {
  console.log('\nFAIL —— 一个标题都没解出来，映射不会生效')
  process.exitCode = 1
} else {
  console.log('\nok —— 标题解析可用')
}
