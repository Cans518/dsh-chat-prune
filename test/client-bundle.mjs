/**
 * 验证构建产物 client.js 的加载形态。
 *
 * 历史教训（两次真实翻车，都写进断言里了）：
 *   1. 早期版本 client.js 带顶层 import —— 宿主加载报
 *      "dsh-delete-chat: import failed"。
 *   2. 后来改成零 import，但 package.json 仍声明 dsh.client ——
 *      宿主会把一个不存在的 React 组件往 slot 里挂，React 抛 #130
 *      「Element type is invalid」，连带把 shell.overlay slot 整个搞崩。
 *
 * 现在的形态：client.js 是**普通 <script>**（由 host 半通过 webserver 的
 * index injection 表插入 <script src="/dsh-delete-chat/client.js">），
 * 既不引用 __ModuleLoader__，也不注册任何 slot，IIFE 就地自启动。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

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

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 只留代码，去掉注释 —— 说明性注释里提到 __ModuleLoader__ 是允许的。 */
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 造一个够用的最小 DOM 沙箱。 */
function makeSandbox(overrides = {}) {
  const fakeEl = () => ({
    tagName: 'DIV',
    className: '',
    style: {},
    children: [],
    attributes: [],
    dataset: {},
    classList: { contains: () => false, add() {}, remove() {} },
    setAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    removeAttribute() {},
    appendChild(c) {
      this.children.push(c)
      return c
    },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }),
    isConnected: true,
  })

  // client-core 用 `x instanceof Element` 过滤事件目标
  class FakeElement {}
  Object.setPrototypeOf(fakeEl.prototype ?? {}, FakeElement.prototype)

  const sandbox = {
    console,
    Element: FakeElement,
    navigator: { language: 'zh-CN' },
    document: {
      head: fakeEl(),
      body: fakeEl(),
      createElement: () => fakeEl(),
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    getComputedStyle: () => ({ position: 'relative' }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: () => {},
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, apiVersion: 1, sessions: [] }) }),
    ...overrides,
  }
  sandbox.window = sandbox
  return sandbox
}

console.log('\n== client.js 加载形态 ==\n')

check('产物里没有任何顶层 import / export', () => {
  const bad = codeOnly
    .split('\n')
    .map((l, i) => ({ l: l.trim(), i: i + 1 }))
    .filter(({ l }) => /^(import|export)\s/.test(l))
  assert.equal(bad.length, 0, `残留: ${JSON.stringify(bad)}`)
})

check('代码里不引用 __ModuleLoader__（不走 dsh.client 机制）', () => {
  assert.equal(
    codeOnly.includes('__ModuleLoader__'),
    false,
    '仍引用 __ModuleLoader__ —— 这正是当年 import failed 的那条路',
  )
})

check('产物能作为普通 script 解析（vm.Script 不认 ESM 语法）', () => {
  new vm.Script(src)
})

check('无 loader 环境下自启动，并留下安装标记', () => {
  const sandbox = makeSandbox()
  vm.createContext(sandbox)
  assert.doesNotThrow(() => new vm.Script(src).runInContext(sandbox))
  assert.equal(sandbox.window.__dshDeleteChatInstalled__, true, '脚本没自启动')
})

check('自启动后挂上自检手柄 window.dshDeleteChat', () => {
  const sandbox = makeSandbox()
  vm.createContext(sandbox)
  new vm.Script(src).runInContext(sandbox)
  const h = sandbox.window.dshDeleteChat
  assert.ok(h, 'dshDeleteChat 手柄缺失')
  assert.equal(typeof h.status, 'function')
  assert.equal(typeof h.setRowSelectors, 'function')
  assert.equal(typeof h.titleMap, 'function')
  assert.equal(typeof h.probe, 'function')
  const st = h.status()
  assert.equal(st.apiBase, '/dsh-delete-chat')
  assert.equal(st.visible, false, '初始不该显示按钮')
})

check('重复注入同一 script 不重复安装（幂等，防 HMR 重复插）', () => {
  const sandbox = makeSandbox()
  vm.createContext(sandbox)
  new vm.Script(src).runInContext(sandbox)
  assert.doesNotThrow(() => new vm.Script(src).runInContext(sandbox))
})

check('body 尚未就绪时延迟安装，避免永久留下未成功的安装标记', () => {
  const sandbox = makeSandbox()
  const readyBody = sandbox.document.body
  sandbox.document.body = null
  let ready
  sandbox.document.addEventListener = (event, callback) => {
    if (event === 'DOMContentLoaded') ready = callback
  }
  vm.createContext(sandbox)
  new vm.Script(src).runInContext(sandbox)
  assert.notEqual(sandbox.__dshDeleteChatInstalled__, true)
  assert.equal(typeof ready, 'function')
  sandbox.document.body = readyBody
  ready()
  assert.equal(sandbox.__dshDeleteChatInstalled__, true)
  assert.ok(sandbox.dshDeleteChat)
})

check('DOM 缺失时安静退出（不炸页面）', () => {
  const sandbox = makeSandbox()
  delete sandbox.document
  vm.createContext(sandbox)
  assert.doesNotThrow(() => new vm.Script(src).runInContext(sandbox))
})

console.log(`\n== 结果: ${pass} 通过 / ${fail} 失败 ==\n`)
process.exit(fail > 0 ? 1 : 0)
