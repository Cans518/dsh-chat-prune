/**
 * 构建产物新鲜度检查：仓库里提交的 client.js 必须等于「现在重新构建」的结果。
 *
 * 为什么需要它：
 *   GitHub 直装（`dsh plugin add github:owner/repo`）不会跑 prepack，
 *   用户拿到的是**仓库里那个 client.js**。一旦它和源码不同步，
 *   用户装到的就是旧代码，而且没有任何提示。
 *
 *   曾经试过用 `prepare` 在 git 安装时自动重建 —— 结果 pnpm 11 直接拒绝：
 *     ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED ... not in the "allowBuilds" allowlist
 *   把唯一的安装路径弄挂了。所以改成：产物照样提交，用这个检查防止漂移。
 *
 * 用法：node test/client-fresh.mjs   （CI 与发布前都该跑）
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const artifact = join(root, 'client.js')

const before = readFileSync(artifact, 'utf8')

const run = spawnSync(process.execPath, [join(root, 'scripts', 'build-client.mjs')], {
  encoding: 'utf8',
  cwd: root,
  timeout: 60000,
})

const after = readFileSync(artifact, 'utf8')

if (before !== after) {
  // 还原，避免检查本身改动工作区
  writeFileSync(artifact, before, 'utf8')
  console.log('FAIL  client.js 与源码不同步 —— 先跑 `npm run build` 并提交产物')
  console.log(`      已提交版本 ${before.length} 字符，重新构建 ${after.length} 字符`)
  process.exit(1)
}

assert.equal(run.status, 0, `构建失败：${run.stderr || run.stdout}`)
console.log(`  ok   client.js 与源码同步（${after.length} 字符）`)
