/**
 * boot 前演练：用假的 ctx 把 host 半完整 apply 一遍。
 *
 * 这是在重启之前能做的最后一道保险 —— 一次重启代价太高，不能靠运气。
 * 覆盖：路由注册、cfg 合并、effect 的 disposer、以及**index injection 行**
 * （client.js 就靠这一行插进页面；漏了它按钮就不会出现，而日志里悄无声息）。
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

/** 造一个记录调用的 fake ctx。 */
function makeCtx({ home = 'C:\\fake\\home', withOn = true } = {}) {
  const routes = []
  const effects = []
  const listeners = new Map()
  const warns = []

  const ctx = {
    profileContext: { home },
    logger: { warn: (m) => warns.push(m), info() {}, error() {} },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => routes.push({ disposed: route.path })
      },
    },
    effect: (fn, label) => {
      const d = fn()
      effects.push({ label, hasDisposer: typeof d === 'function' })
    },
  }

  if (withOn) {
    ctx.on = (event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    }
  }

  return { ctx, routes, effects, listeners, warns }
}

console.log('\n== boot 演练 ==\n')

// ---- 正常路径 ----
const a = makeCtx()
check('apply 无异常', () => {
  mod.apply(a.ctx, { backup: true, allowRunning: false, icon: 'trash' })
})

check('注册了 prefix 路由 /dsh-chat-prune', () => {
  const r = a.routes.find((x) => x.path)
  assert.ok(r, '没注册任何路由')
  assert.equal(r.kind, 'prefix')
  assert.equal(r.path, '/dsh-chat-prune')
  assert.equal(typeof r.handler, 'function')
})

check('每个 effect 都返回了 disposer', () => {
  assert.ok(a.effects.length > 0, '没注册 effect')
  for (const e of a.effects) {
    assert.ok(e.hasDisposer, `effect "${e.label}" 没返回 disposer —— HMR/卸载会漏`)
  }
})

// ---- index injection：按钮能不能出现在页面上的关键一步 ----
check('订阅了 webserver/index-inject', () => {
  assert.ok(
    a.listeners.has('webserver/index-inject'),
    '没订阅 index injection —— client.js 永远不会被插进页面，按钮不出现',
  )
})

check('向 injection 表推入内联 script 行（不是 script-src）', () => {
  const table = []
  a.listeners.get('webserver/index-inject')(table)
  assert.equal(table.length, 1, `推入了 ${table.length} 行`)
  const row = table[0]
  assert.equal(row.kind, 'script', '必须内联')
  assert.equal(row.placement, 'body')
  assert.equal(typeof row.text, 'string')
  assert.ok(row.text.length > 1000, `内联脚本太短: ${row.text.length}`)
})

check('内联脚本里不含裸 </script（否则提前闭合标签）', () => {
  const table = []
  a.listeners.get('webserver/index-inject')(table)
  assert.equal(/<\/script/i.test(table[0].text), false)
})

check('页面侧对 script 是同步插入，不是 await 网络加载', () => {
  // 真实事故：script-src 在页面侧是 `await n(src)`，onerror 会 reject，
  // 直接把整个页面 boot 拖挂。内联 script 没有 onload/onerror，不可能失败。
  const hostSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.equal(
    /kind:\s*'script-src'/.test(hostSrc),
    false,
    'host 半仍在使用 script-src —— 会让插件有权拖垮宿主 boot',
  )
  assert.ok(/kind:\s*'script'/.test(hostSrc), '应使用 kind:script 内联')
})

check('injection 行每次 emit 都推（宿主每次渲染都新建表）', () => {
  const t1 = []
  const t2 = []
  const fn = a.listeners.get('webserver/index-inject')
  fn(t1)
  fn(t2)
  assert.equal(t1.length, 1)
  assert.equal(t2.length, 1)
})

check('宿主传非数组时不炸（防御性）', () => {
  const fn = a.listeners.get('webserver/index-inject')
  assert.doesNotThrow(() => fn(undefined))
  assert.doesNotThrow(() => fn(null))
  assert.doesNotThrow(() => fn({ not: 'an array' }))
})

check('client.js 路由能吐文件内容', () => {
  // 同步断言形状即可；真正的读文件在 host smoke 的 HTTP 层覆盖
  const r = a.routes.find((x) => x.path)
  assert.equal(typeof r.handler, 'function')
})

// ---- 降级路径 ----
check('config 传 undefined 也不炸', () => {
  const b = makeCtx()
  mod.apply(b.ctx, undefined)
  assert.ok(b.routes.length > 0)
})

check('ctx.on 缺失时只告警，不拖崩 boot', () => {
  const c = makeCtx({ withOn: false })
  assert.doesNotThrow(() => mod.apply(c.ctx, {}), 'ctx.on 缺失不该抛')
  assert.ok(c.routes.length > 0, '路由仍应注册')
  assert.ok(c.warns.length > 0, '应留下一条告警说明按钮注入不可用')
})

check('webServer 缺失时明确失败（不静默挂不上）', () => {
  // inject = ['webServer'] 已经让 cordis 保证该服务存在；
  // 万一没有，apply 应当直接抛（挂不上就是挂不上，不能静默半死），
  // 而不是默默什么都不注册、让用户去猜按钮为什么不出现。
  const ctx3 = {
    profileContext: { home: 'C:\\fake' },
    effect: (f) => f(),
    logger: { warn() {} },
  }
  assert.throws(
    () => mod.apply(ctx3, {}),
    (err) => /webServer|undefined/i.test(String(err && err.message)),
    'webServer 缺失时应抛错',
  )
})

check('package.json 的原生槽模块与普通内联脚本使用不同入口', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './client-slot.js')
  assert.notEqual(pkg.exports['./client'], './client.js')
})

console.log(`\n== 结果: ${pass} 通过 / ${fail} 失败 ==\n`)
process.exit(fail > 0 ? 1 : 0)
