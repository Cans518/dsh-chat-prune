/**
 * 检查 host 半的导出面是否符合 loader 期望。
 *
 * 这一层很重要：schema/导出写错不会在 `node --check` 里暴露，
 * 但会让整个 profile 的插件树在 boot 期挂掉 —— 重启一次才发现代价太大。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const mod = await import('../lib/index.js')

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

console.log('\n== dsh-chat-prune 导出面 ==\n')

check('导出 name / inject / apply', () => {
  assert.equal(typeof mod.name, 'string')
  assert.ok(Array.isArray(mod.inject))
  assert.equal(typeof mod.apply, 'function')
})

check('inject 声明路由、工作区和会话服务，等待宿主就绪', () => {
  assert.deepEqual(mod.inject, ['webServer', 'workspaceRegistry', 'sessions', 'sessionPersistence'])
})

check('default export 同形', () => {
  assert.equal(typeof mod.default.apply, 'function')
  assert.equal(mod.default.name, mod.name)
  assert.deepEqual(mod.default.inject, mod.inject)
})

/**
 * 复刻 cordis 的 resolveConfig（从 app.asar 里读出来的原文）：
 *
 *     function resolveConfig(runtime, config) {
 *       if (!runtime.Config) return config;
 *       const result = runtime.Config["~standard"].validate(config);
 *       if ("then" in result) throw new TypeError("Async config validation is not supported");
 *       if (result.issues) throw new ValidationError(result.issues);
 *       else return result.value;
 *     }
 *
 * 之前 Config 写成 `(z) => z.object({...})`，即一个没有 `~standard` 的普通函数，
 * 于是 runtime.Config["~standard"] 是 undefined → undefined.validate(...) →
 * 「Cannot read properties of undefined (reading 'validate')」，插件整个挂不上。
 * 这个测试就是为了把那个错误钉死在测试里。
 */
function cordisResolveConfig(runtime, config) {
  if (!runtime.Config) return config
  const result = runtime.Config['~standard'].validate(config)
  if ('then' in result) throw new TypeError('Async config validation is not supported')
  if (result.issues) throw new Error('ValidationError: ' + JSON.stringify(result.issues))
  return result.value
}

check('Config 暴露 Standard Schema 接口（cordis 靠它取 config）', () => {
  assert.ok(mod.Config, 'Config 缺失')
  const std = mod.Config['~standard']
  assert.ok(std, 'Config["~standard"] 缺失 —— cordis 会报 reading \'validate\' of undefined')
  assert.equal(typeof std.validate, 'function', '~standard.validate 必须是函数')
  assert.equal(std.version, 1, 'Standard Schema 版本应为 1')
})

check('cordis resolveConfig 能跑通，并填上默认值', () => {
  const resolved = cordisResolveConfig({ Config: mod.Config }, {})
  assert.deepEqual(resolved, { backup: false, allowRunning: false, icon: 'trash' })
})

check('config 为 undefined 时也填默认值（不炸）', () => {
  const resolved = cordisResolveConfig({ Config: mod.Config }, undefined)
  assert.deepEqual(resolved, { backup: false, allowRunning: false, icon: 'trash' })
})

check('用户配置覆盖默认值，未给的字段仍取默认', () => {
  const resolved = cordisResolveConfig({ Config: mod.Config }, { backup: false })
  assert.deepEqual(resolved, { backup: false, allowRunning: false, icon: 'trash' })
})

check('类型不对时返回 issues（而不是抛奇怪的 TypeError）', () => {
  const std = mod.Config['~standard']
  const bad = std.validate({ backup: 'nope' })
  assert.ok(Array.isArray(bad.issues) && bad.issues.length > 0, '应报 issues')
  assert.equal(bad.value, undefined)
})

check('没有 Config 的插件也能通过 resolveConfig（对照组）', () => {
  // 确认上面的 helper 本身是对的：无 Config 时原样返回
  const raw = { anything: 1 }
  assert.equal(cordisResolveConfig({}, raw), raw)
})

check('package.json 用独立合法 client 入口声明原生槽模块', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject,
    ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-api-session-controller'])
  assert.equal(pkg.exports['./client'], './client-slot.js')
  assert.ok(pkg.dsh.bundle, 'dsh.bundle 应保留（bundle patch 是挂载入口）')
})

check('host 半保留管理窗口与兼容层的 client.js 注入路由', () => {
  const hostSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(
    hostSrc.includes('webserver/index-inject'),
    '应通过 webserver/index-inject 把 client.js 注入页面',
  )
  assert.ok(hostSrc.includes('/client.js'), '应暴露 client.js 路由')
})

check('路由前缀与 client 半一致', () => {
  // 两边硬编码了同一个前缀，这里钉住，防止单边改漏
  const clientSrc = readFileSync(new URL('../client-core.js', import.meta.url), 'utf8')
  const m = /const API_BASE = '([^']+)'/.exec(clientSrc)
  assert.ok(m, 'client-core.js 里没找到 API_BASE')
  assert.equal(m[1], '/dsh-chat-prune')
  // host 半的路由注册也用同一个前缀
  const hostSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(hostSrc.includes("const ROUTE_PREFIX = '/dsh-chat-prune'"), 'host 前缀不匹配')
})

console.log(`\n== 结果: ${pass} 通过 / ${fail} 失败 ==\n`)
process.exit(fail > 0 ? 1 : 0)
