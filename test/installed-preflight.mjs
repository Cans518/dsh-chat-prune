/**
 * 安装副本的预检：完全按 cordis 的方式把插件加载一遍。
 *
 * 这一步存在的理由：前面两次重启都因为「测试全绿但宿主装不上」而失败。
 * 差距在于 —— 单测跑的是 workspace 副本、用的是我自己的桩；
 * 而宿主跑的是安装副本、走的是 cordis 的 import + Standard Schema 校验。
 *
 * 所以这里刻意做三件和宿主一致的事：
 *   1. import 安装路径下的 lib/index.js（不是 workspace 的）
 *   2. 用 cordis 的 resolveConfig 原文逻辑解析 config
 *   3. 把 insert 行里的 config 真的喂进去，再 apply 一遍
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', 'desktop')
const installedDir = join(profileDir, 'node_modules', 'dsh-chat-prune')
const entry = join(installedDir, 'lib', 'index.js')

let pass = 0
let fail = 0
function check(title, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ok   ${title}`)
  } catch (e) {
    fail += 1
    console.log(`  FAIL ${title}\n       ${(e && e.stack) || e}`)
  }
}

/** cordis resolveConfig 原文。 */
function cordisResolveConfig(runtime, config) {
  if (!runtime.Config) return config
  const result = runtime.Config['~standard'].validate(config)
  if ('then' in result) throw new TypeError('Async config validation is not supported')
  if (result.issues) throw new Error('ValidationError: ' + JSON.stringify(result.issues))
  return result.value
}

console.log('\n== 安装副本预检 ==\n')
console.log(`  入口: ${entry}\n`)

const mod = await import(pathToFileURL(entry).href)
const requireProfile = createRequire(join(profileDir, 'package.json'))
const { parse } = requireProfile('yaml')

check('安装副本能 import（schemastery 能解析）', () => {
  assert.ok(mod, 'import 返回空')
  assert.equal(mod.name, 'dsh-chat-prune')
})

check('导出 Config，且带 Standard Schema 的 ~standard', () => {
  assert.ok(mod.Config, 'Config 缺失')
  assert.ok(mod.Config['~standard'], '~standard 缺失 —— cordis 会报 reading validate of undefined')
})

check('cordis resolveConfig 用 patch 里的 config 能跑通', () => {
  // 读插件自己的 bundle patch，取出 insert 行里的 config —— 和宿主合并的完全同源
  const patchText = readFileSync(join(installedDir, 'cordis.patch.yml'), 'utf8')
  const patch = parse(patchText)
  const rawConfig = patch?.flatMap((row) => row.insert || [])
    .find((row) => row.id === 'dsh-chat-prune')?.config
  assert.ok(rawConfig, 'patch 里没找到插件 config')
  const resolved = cordisResolveConfig(mod, rawConfig)
  for (const [key, value] of Object.entries(rawConfig)) assert.deepEqual(resolved[key], value)
})

check('安装副本的运行时代码与当前工作区一致', () => {
  for (const file of ['lib/index.js', 'lib/pruning-policy.js', 'lib/agent-lifecycle.js', 'lib/session-sources.js', 'client-core.js', 'client-manager.js', 'client.js', 'client-slot.js']) {
    const digest = (value) => createHash('sha256').update(value).digest('hex')
    assert.equal(digest(readFileSync(join(installedDir, file))),
      digest(readFileSync(new URL(`../${file}`, import.meta.url))),
      `${file} 安装副本已过期，请重新安装后正常重启宿主`)
  }
})

check('空 config 也能过（走 schema 默认值）', () => {
  const resolved = cordisResolveConfig(mod, undefined)
  assert.deepEqual(resolved, { backup: false, allowRunning: false, icon: 'trash' })
})

check('apply 注册路由与 disposer（服务生命周期由 cordis inject 管理）', () => {
  const routes = []
  const effects = []
  const ctx = {
    profileContext: { home },
    webServer: { register: (r) => (routes.push(r), () => {}) },
    effect: (fn) => {
      const d = fn()
      effects.push(typeof d)
    },
  }
  mod.apply(ctx, cordisResolveConfig(mod, undefined))
  assert.equal(routes.length, 1, `路由数 ${routes.length}`)
  assert.equal(routes[0].path, '/dsh-chat-prune')
  assert.equal(routes[0].kind, 'prefix')
  assert.ok(effects.every((x) => x === 'function'), 'effect 必须返回 disposer')
})

console.log(`\n== 结果: ${pass} 通过 / ${fail} 失败 ==\n`)
process.exit(fail > 0 ? 1 : 0)
