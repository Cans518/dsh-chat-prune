/**
 * 一键跑全部测试。
 *   node test/all.mjs
 * 退出码 0 = 全绿。
 *
 * 分两类：
 *   - 纯逻辑：不依赖本机 DSH（smoke / client / exports / boot / bundle / review-*）
 *   - 本机集成：读真实 $DSH_HOME、安装副本（titles-real / installed-preflight / injection-e2e）
 *
 * 后者在别的机器上跑会失败，属正常 —— 它们是「这台机器上装好了没有」的验收。
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

const LOGIC = [
  'smoke.mjs',
  'client-overlay.mjs',
  'exports.mjs',
  'boot-dryrun.mjs',
  'client-bundle.mjs',
  'client-slot.mjs',
  'review-regressions.mjs',
  'delete-safety.mjs',
  'titles-fixture.mjs',
  'pruning-policy.mjs',
  'session-management.mjs',
]

const INTEGRATION = [
  'review-behaviour.mjs',
  'titles-real.mjs',
  'installed-preflight.mjs',
  'injection-e2e.mjs',
]

function run(file) {
  const r = spawnSync(process.execPath, [join(here, file)], {
    encoding: 'utf8',
    timeout: 180000,
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const m = /结果: (\d+) 通过 \/ (\d+) 失败/.exec(out)
  const nodePass = /(?:ℹ|#) pass (\d+)/.exec(out)
  const nodeFail = /(?:ℹ|#) fail (\d+)/.exec(out)
  return {
    file,
    code: r.status,
    pass: m ? Number(m[1]) : nodePass ? Number(nodePass[1]) : null,
    fail: m ? Number(m[2]) : nodeFail ? Number(nodeFail[1]) : null,
    error: r.error,
    out,
  }
}

let totalPass = 0
let totalFail = 0
const broken = []

const groups = [
  ['纯逻辑', LOGIC],
]
if (process.argv.includes('--installed')) groups.push(['本机安装集成（验证安装副本）', INTEGRATION])
if (process.argv.includes('--browser')) groups.push(['Chromium 交互与文件删除集成', ['browser-e2e.mjs', 'manager-e2e.mjs']])
if (process.argv.includes('--host')) groups.push(['真实 DSH Host 与官方前端集成（独立临时 profile）', ['host-e2e.mjs']])
if (process.argv.includes('--install')) groups.push(['真实 DSH CLI 安装、自动启用和卸载（需先 npm pack）', ['install-e2e.mjs']])

for (const group of groups) {
  const [label, files] = group
  console.log(`\n=== ${label} ===`)
  for (const f of files) {
    const r = run(f)
    const ok = r.code === 0
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${f.padEnd(28)} ${r.pass !== null ? `${r.pass} 通过 / ${r.fail} 失败` : `exit=${r.code}`}`)
    if (r.pass !== null) totalPass += r.pass
    if (r.fail !== null) totalFail += r.fail
    if (!ok) {
      broken.push(f)
      const fails = r.out.split('\n').filter((l) => /^\s*(FAIL|  FAIL)/.test(l))
      for (const line of fails.slice(0, 5)) console.log(`         ${line.trim()}`)
      if (r.error) console.log(`         ${r.error.message}`)
      else if (fails.length === 0) console.log(r.out.slice(-2500))
    }
  }
}

console.log(`\n=== 总计: ${totalPass} 通过 / ${totalFail} 失败 ===`)
if (broken.length > 0) {
  console.log(`失败文件: ${broken.join(', ')}`)
  process.exitCode = 1
}
