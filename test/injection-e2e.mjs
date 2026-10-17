/**
 * 用自写 HTML 夹具检查安装副本产出的内联注入表。
 * 实际宿主渲染行为由 host-e2e.mjs 独立验证。
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { renderFixtureInjections as renderIndexInjections } from './helpers/render-injections.mjs'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', 'desktop')

console.log('\n== 安装副本的 index injection 夹具验证 ==\n')

// 2) 用插件真实 apply 产出的行
const plugin = await import(pathToFileURL(join(profileDir, 'node_modules', 'dsh-delete-chat', 'lib', 'index.js')).href)

const listeners = new Map()
const ctx = {
  profileContext: { home },
  logger: { warn() {}, info() {}, error() {} },
  webServer: { register: () => () => {} },
  on: (ev, fn) => {
    listeners.set(ev, fn)
    return () => listeners.delete(ev)
  },
  effect: (fn) => {
    fn()
  },
}
plugin.apply(ctx, undefined)

const emit = listeners.get('webserver/index-inject')
assert.ok(emit, '没订阅 webserver/index-inject')

const table = []
emit(table)
assert.equal(table[0]?.kind, 'script')
assert.equal(table[0]?.placement, 'body')
assert.ok(table[0]?.text?.length > 1000)
console.log('  插件推入的行: kind =', table[0]?.kind, '| placement =', table[0]?.placement,
            '| text 长度 =', typeof table[0]?.text === 'string' ? table[0].text.length : '(无)')

if (typeof renderIndexInjections === 'function') {
  const indexHtml = '<html><head></head><body><div id="root"></div></body></html>'
  const out = renderIndexInjections(indexHtml, table)

  // 只打印首尾，内联脚本有 20KB，全打印会刷屏
  console.log('  渲染结果(首 120):', out.slice(0, 120))
  console.log('  渲染结果(尾 120):', out.slice(-120))

  const checks = [
    ['行类型是内联 script', table[0]?.kind === 'script'],
    ['不是 script-src（会拖垮 boot）', table[0]?.kind !== 'script-src'],
    ['渲染出 <script> 标签', out.includes('<script>')],
    ['不含 src= 外链', !/<script src=/.test(out)],
    ['内联内容里没有裸 </script', !/<\/script[\s\S]*<script>[\s\S]*<\/script>/.test(out.slice(0, -60))],
    ['脚本真的在 body 里', out.indexOf('<script>') > out.indexOf('<body>')],
    ['包含自启动标记', out.includes('__dshDeleteChatInstalled__')],
  ]

  let bad = 0
  for (const [name, ok] of checks) {
    if (ok) console.log(`  ok   ${name}`)
    else {
      console.log(`  FAIL ${name}`)
      bad += 1
    }
  }
  if (bad > 0) process.exitCode = 1
  else console.log('\n  ok   内联注入会被渲染成页面里的 <script>…</script>，不依赖网络与认证')
}

console.log('')
