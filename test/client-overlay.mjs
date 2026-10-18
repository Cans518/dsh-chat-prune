/**
 * client 半测试（悬浮层模型）。
 *
 * 上一版是「往 React 行节点里插按钮」，那套测试也跟着行节点走。
 * 改成悬浮层之后，被测对象变成两件事：
 *   1. 纯逻辑：标题规范化 / sessionId 反查 / 行识别（不需要 DOM）
 *   2. 交互：hover 时按钮出现在被悬停行的右端，离开时隐藏
 *
 * 这里用最小 DOM 桩把 2 也跑起来 —— 因为「按钮到底出不出来」正是
 * 上一轮翻车的地方，只测纯逻辑没有意义。
 */

import assert from 'node:assert/strict'

// ---------------------------------------------------------------- DOM 桩

class El {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.ownerDocument = doc
    this.children = []
    this.parentElement = null
    this.attributes = []
    this.dataset = {}
    this.style = { cssText: '' }
    this._class = ''
    this._text = ''
    this._listeners = {}
    this._rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }
    this.isConnected = true
  }
  get className() {
    return this._class
  }
  set className(v) {
    this._class = String(v || '')
  }
  // 真实 DOM 里 `el.id = x` 会同步到属性；桩必须照做，否则 getElementById 找不到
  get id() {
    return this.getAttribute('id') || ''
  }
  set id(v) {
    this.setAttribute('id', String(v))
  }
  get classList() {
    const self = this
    return {
      contains: (c) => String(self._class).split(/\s+/).includes(c),
      add: (c) => {
        self._class = `${self._class} ${c}`.trim()
      },
      remove: (c) => {
        self._class = String(self._class)
          .split(/\s+/)
          .filter((x) => x && x !== c)
          .join(' ')
      },
    }
  }
  get textContent() {
    return this._text || this.children.map((c) => c.textContent).join('')
  }
  set textContent(v) {
    this._text = String(v ?? '')
    this.children = []
  }
  set innerHTML(v) {
    this._html = String(v || '')
  }
  get innerHTML() {
    return this._html || ''
  }
  setAttribute(n, v) {
    const s = String(v)
    const f = this.attributes.find((a) => a.name === n)
    if (f) f.value = s
    else this.attributes.push({ name: n, value: s })
    if (n.startsWith('data-')) {
      this.dataset[n.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = s
    }
  }
  getAttribute(n) {
    const f = this.attributes.find((a) => a.name === n)
    return f ? f.value : null
  }
  hasAttribute(n) {
    return this.attributes.some((a) => a.name === n)
  }
  removeAttribute(n) {
    this.attributes = this.attributes.filter((a) => a.name !== n)
  }
  appendChild(c) {
    c.parentElement = this
    this.children.push(c)
    return c
  }
  /** 真实 DOM 的 insertBefore(node, ref)；ref 为空等价 appendChild。 */
  insertBefore(node, ref) {
    node.parentElement = this
    const index = ref ? this.children.indexOf(ref) : -1
    if (index < 0) this.children.push(node)
    else this.children.splice(index, 0, node)
    return node
  }
  contains(node) {
    if (node === this) return true
    return this.children.some((c) => c.contains?.(node))
  }
  remove() {
    if (!this.parentElement) return
    const s = this.parentElement.children
    const i = s.indexOf(this)
    if (i >= 0) s.splice(i, 1)
    this.parentElement = null
    this.isConnected = false
  }
  getBoundingClientRect() {
    return this._rect
  }
  setRect(r) {
    this._rect = { top: r.top, bottom: r.top + r.height, left: r.left, right: r.left + r.width, width: r.width, height: r.height }
    return this
  }
  closest(sel) {
    let cur = this
    while (cur) {
      if (matchSel(cur, sel)) return cur
      cur = cur.parentElement
    }
    return null
  }
  /** 只支持 `.class` / `[attr]` 这种单段选择器，够本项目用。 */
  querySelector(sel) {
    const walk = (n) => {
      for (const c of n.children) {
        if (matchSel(c, sel)) return c
        const hit = walk(c)
        if (hit) return hit
      }
      return null
    }
    return walk(this)
  }
  querySelectorAll(sel) {
    const out = []
    const walk = (n) => {
      for (const c of n.children) {
        if (matchSel(c, sel)) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
  addEventListener(t, fn) {
    ;(this._listeners[t] ||= []).push(fn)
  }
  dispatch(t, ev) {
    for (const fn of this._listeners[t] || []) fn(ev)
  }
}

/** 只支持本项目真实用到的选择器形态（含后代组合子）。 */
function matchSel(el, sel) {
  return sel.split(',').map((s) => s.trim()).filter(Boolean).some((group) => {
    const parts = group.split(/\s+/).filter(Boolean)
    if (!parts.length) return false
    if (!matchSimple(el, parts[parts.length - 1])) return false
    let want = parts.length - 2
    let cur = el.parentElement
    while (cur && want >= 0) {
      if (matchSimple(cur, parts[want])) want -= 1
      cur = cur.parentElement
    }
    return want < 0
  })
}

function matchSimple(el, sel) {
  const m = /^\[([a-zA-Z0-9_-]+)(?:\s*(\*=|\^=|=)\s*"([^"]*)")?\s*(i)?\]$/.exec(sel)
  if (m) {
    const [, name, op, want, ci] = m
    if (!el.hasAttribute(name)) return false
    if (!op) return true
    let actual = el.getAttribute(name) ?? ''
    let needle = want ?? ''
    if (ci) {
      actual = actual.toLowerCase()
      needle = needle.toLowerCase()
    }
    return op === '=' ? actual === needle : op === '^=' ? actual.startsWith(needle) : actual.includes(needle)
  }
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1))
  if (sel.startsWith('a[')) return matchSimpleOfTag(el, sel.slice(1), 'A')
  return el.tagName === sel.toUpperCase()
}

function matchSimpleOfTag(el, sel, tag) {
  if (el.tagName !== tag) return false
  return matchSimple(el, sel)
}

class Doc {
  constructor() {
    this.body = new El('body', this)
    this.head = new El('head', this)
    this._listeners = {}
    this.children = [this.head, this.body]
  }
  createElement(tag) {
    return new El(tag, this)
  }
  getElementById(id) {
    const find = (n) => {
      if (n.getAttribute?.('id') === id) return n
      for (const c of n.children) {
        const hit = find(c)
        if (hit) return hit
      }
      return null
    }
    return find(this.body)
  }
  addEventListener(t, fn) {
    ;(this._listeners[t] ||= []).push(fn)
  }
  removeEventListener(t, fn) {
    this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== fn)
  }
  dispatch(t, ev) {
    for (const fn of this._listeners[t] || []) fn(ev)
  }
}

const doc = new Doc()
const win = {
  _listeners: {},
  confirm: () => true,
  addEventListener(t, fn) {
    ;(this._listeners[t] ||= []).push(fn)
  },
  removeEventListener(t, fn) {
    this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== fn)
  },
}

// 让 `x instanceof Element` 成立
class Element extends El {}
globalThis.Element = Element
// 把桩里的元素改成 Element 实例
const origCreate = doc.createElement.bind(doc)
doc.createElement = (tag) => new Element(tag, doc)
doc.body = new Element('body', doc)
doc.head = new Element('head', doc)
doc.children = [doc.head, doc.body]

globalThis.document = doc
globalThis.window = win
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) {
    return this._m.has(k) ? this._m.get(k) : null
  },
  setItem(k, v) {
    this._m.set(k, String(v))
  },
  removeItem(k) {
    this._m.delete(k)
  },
}
// node 里 navigator 是只读 getter，用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN' },
  configurable: true,
  writable: true,
})
let frameId = 0
const frames = new Map()
globalThis.requestAnimationFrame = (fn) => {
  frames.set(++frameId, fn)
  return frameId
}
globalThis.cancelAnimationFrame = (id) => frames.delete(id)
function flushFrames() {
  const pending = [...frames.values()]
  frames.clear()
  for (const fn of pending) fn()
}

let fetchRows = []
let deleteCalls = []
let deleteReply = { ok: true, status: 200, data: { ok: true, alreadyGone: false } }
let onDelete = null
let onList = null
let listFailure = false
let apiVersion = 1
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (init?.method === 'DELETE') {
    deleteCalls.push(JSON.parse(init.body))
    if (onDelete) await onDelete()
    return { ok: deleteReply.ok, status: deleteReply.status, json: async () => deleteReply.data }
  }
  if (u.endsWith('/sessions')) {
    if (onList) return onList()
    if (listFailure) throw new Error('list unavailable')
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, apiVersion, sessions: fetchRows, config: { backup: false } }),
      text: async () => JSON.stringify({ ok: true, sessions: fetchRows }),
    }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{"ok":true}' }
}

const core = await import('../client-core.js')
const T = core.__test__

// ---------------------------------------------------------------- 脚手架

let pass = 0
let fail = 0
async function test(title, fn) {
  try {
    await new Promise((resolve) => setImmediate(resolve))
    doc.body.children = []
    doc._listeners = {}
    win._listeners = {}
    localStorage._m.clear()
    fetchRows = []
    deleteCalls = []
    deleteReply = { ok: true, status: 200, data: { ok: true, alreadyGone: false } }
    onDelete = null
    onList = null
    listFailure = false
    apiVersion = 1
    win.confirm = () => true
    win.__dshChatPruneNativeSlotReady__ = false
    T.setTitleMap({ byTitle: new Map(), fetchedAt: 0 })
    frames.clear()
    await fn()
    pass += 1
    console.log(`  ok   ${title}`)
  } catch (e) {
    fail += 1
    console.log(`  FAIL ${title}\n       ${(e && e.stack) || e}`)
  }
}

const SID_A = 'session-11111111-2222-3333-4444-555555555555'
const SID_B = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

/** 造一个真实形态的会话行：role=treeitem，只有标题。 */
function makeRow(title, { top = 100, height = 32, width = 240 } = {}) {
  const tree = doc.createElement('div')
  tree.setAttribute('role', 'tree')
  doc.body.appendChild(tree)
  const row = doc.createElement('div')
  row.setAttribute('role', 'treeitem')
  row.textContent = title
  row.setRect({ top, left: 0, width, height })
  tree.appendChild(row)
  return row
}

function mount() {
  const cleanups = []
  const ctx = {
    locale: undefined,
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') cleanups.push(d)
    },
  }
  core.apply(ctx)
  const layer = doc.getElementById('dshdc-layer')
  const btn = layer?.children.find((c) => c.tagName === 'BUTTON')
  return {
    layer,
    btn,
    hover: (el) => { doc.dispatch('mouseover', { target: el, relatedTarget: null }); flushFrames() },
    leave: (el) => { doc.dispatch('mouseout', { target: el, relatedTarget: null }); flushFrames() },
    status: () => win.dshChatPrune.status(),
    probe: (el) => win.dshChatPrune.probe(el),
    unmount: () => cleanups.forEach((f) => f()),
  }
}

// ---------------------------------------------------------------- 纯逻辑

console.log('\n== 标题规范化 ==\n')

await test('剥掉「进行中」前缀与尾部时长', () => {
  assert.equal(T.normalizeTitle('进行中 插件开发讨论 3分钟'), '插件开发讨论')
  assert.equal(T.normalizeTitle('整理项目文档 1小时'), '整理项目文档')
  assert.equal(T.normalizeTitle('  多个   空格  '), '多个 空格')
})

console.log('\n== 标题反查 ==\n')

await test('精确命中', async () => {
  T.setTitleMap({ byTitle: new Map([['甲', SID_A]]), fetchedAt: Date.now() })
  assert.equal(T.sessionIdByTitle('甲'), SID_A)
})

await test('带装饰也能命中（包含匹配）', async () => {
  T.setTitleMap({ byTitle: new Map([['插件开发讨论', SID_A]]), fetchedAt: Date.now() })
  assert.equal(T.sessionIdByTitle('进行中 插件开发讨论 3分钟'), SID_A)
})

await test('取最长命中，短标题不抢戏', async () => {
  T.setTitleMap({
    byTitle: new Map([
      ['整理', SID_A],
      ['整理项目文档', SID_B],
    ]),
    fetchedAt: Date.now(),
  })
  assert.equal(T.sessionIdByTitle('整理项目文档 1小时'), SID_B)
})

await test('对不上就返回 null（绝不乱删）', async () => {
  T.setTitleMap({ byTitle: new Map([['别的', SID_A]]), fetchedAt: Date.now() })
  assert.equal(T.sessionIdByTitle('完全无关的标题'), null)
})

await test('重复标题不猜测目标；更长未知标题不借用短标题的 ID', async () => {
  fetchRows = [
    { id: SID_A, title: '同名' },
    { id: SID_B, title: '同名' },
    { id: 'session-third', title: '同名' },
  ]
  await T.refreshTitleMap(true)
  assert.equal(T.sessionIdByTitle('同名'), null)
  T.setTitleMap({ byTitle: new Map([['清除', SID_A]]), fetchedAt: Date.now() })
  assert.equal(T.sessionIdByTitle('清除另一项目'), null)
})

await test('真实宿主 data-row-key 直接提供 ID，不依赖标题名单或匹配文本', async () => {
  const h = mount()
  T.setTitleMap({ byTitle: new Map(), fetchedAt: Date.now() })
  const row = makeRow('进行中 任意新标题 刚刚')
  row.setAttribute('data-row-key', `session:${SID_A}`)
  h.hover(row)
  assert.equal(h.btn.dataset.dshdcVisible, '1')
  assert.equal(h.btn.dataset.dshdcFor, SID_A)
  assert.equal(h.btn.style.left, `${240 - 54}px`, '应给宿主原生菜单留位置')
  h.unmount()
})

await test('工作区行与退出动画克隆不能当作可删除会话', async () => {
  const h = mount()
  T.setTitleMap({ byTitle: new Map([['匹配标题', SID_A]]), fetchedAt: Date.now() })
  const workspace = makeRow('匹配标题')
  workspace.setAttribute('data-row-key', 'workspace:workspace-id')
  h.hover(workspace)
  assert.equal(h.btn.dataset.dshdcVisible, '0')
  const clone = makeRow('匹配标题')
  clone.setAttribute('inert', '')
  h.hover(clone)
  assert.equal(h.btn.dataset.dshdcVisible, '0')
  h.unmount()
})

await test('原生槽就绪时关闭兼容悬浮按钮，防止两个删除入口重叠', async () => {
  const h = mount()
  const row = makeRow('任意标题')
  row.setAttribute('data-row-key', `session:${SID_A}`)
  win.__dshChatPruneNativeSlotReady__ = true
  h.hover(row)
  assert.equal(h.btn.dataset.dshdcVisible, '0')
  win.__dshChatPruneNativeSlotReady__ = false
  h.hover(row)
  assert.equal(h.btn.dataset.dshdcVisible, '1')
  h.unmount()
})

// ---------------------------------------------------------------- 交互

console.log('\n== 悬浮按钮 ==\n')

await test('apply 后 body 上出现悬浮层，且不往 React 节点里插东西', () => {
  const h = mount()
  assert.ok(h.layer, '悬浮层没创建')
  assert.ok(h.btn, '按钮没创建')
  assert.match(h.layer.style.cssText, /width:0;height:0/, '根容器不能铺满视口拦截宿主输入')
  // 关键回归：行里不能多出我们插的子节点
  const row = makeRow('某个对话')
  h.hover(row)
  assert.equal(row.children.length, 0, '行节点被插入了东西 —— 这会搅乱 React')
  h.unmount()
})

await test('hover 到会话行 → 按钮出现在该行右端', async () => {
  fetchRows = [{ id: SID_A, title: '某个对话', workspace: '--w--' }]
  const h = mount()
  await T.refreshTitleMap(true)
  const row = makeRow('某个对话', { top: 200, height: 30, width: 240 })
  h.hover(row)

  assert.equal(h.btn.dataset.dshdcVisible, '1', '按钮没显示')
  assert.equal(h.btn.dataset.dshdcFor, SID_A, '反查出的 id 不对')
  assert.equal(h.btn.style.top, `${200 + 15 - 11}px`, '垂直位置不对')
  assert.equal(h.btn.style.left, `${240 - 26}px`, '水平位置不对')
  h.unmount()
})

await test('hover 到非会话行 → 按钮隐藏', async () => {
  const h = mount()
  const other = doc.createElement('div')
  other.textContent = '别的东西'
  doc.body.appendChild(other)
  h.hover(other)
  assert.equal(h.btn.dataset.dshdcVisible, '0')
  h.unmount()
})

await test('标题对不上任何会话 → 不显示按钮', async () => {
  fetchRows = [{ id: SID_A, title: '已知对话', workspace: '--w--' }]
  const h = mount()
  await T.refreshTitleMap(true)
  const row = makeRow('未知对话')
  h.hover(row)
  assert.equal(h.btn.dataset.dshdcVisible, '0', '不该显示')
  h.unmount()
})

await test('点击按钮阻止默认操作和事件冒泡，发出正确 DELETE', async () => {
  fetchRows = [{ id: SID_A, title: 'x' }]
  const h = mount()
  await T.refreshTitleMap(true)
  h.hover(makeRow('x'))
  let prevented = false, stopped = false
  h.btn.dispatch('click', {
    preventDefault() { prevented = true },
    stopPropagation() { stopped = true },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(prevented, true)
  assert.equal(stopped, true)
  assert.deepEqual(deleteCalls, [{ sessionId: SID_A }])
  assert.equal(h.btn.disabled, false)
  h.unmount()
})

await test('取消确认不发送删除且按钮可继续使用', async () => {
  fetchRows = [{ id: SID_A, title: 'x' }]
  const h = mount()
  win.confirm = () => false
  assert.equal(await T.askThenDelete(SID_A, h.btn), false)
  assert.deepEqual(deleteCalls, [])
  assert.equal(h.btn.disabled, false)
  h.unmount()
})

await test('客户端发现宿主仍是旧版时提示完整重启，并拒绝提交删除', async () => {
  fetchRows = [{ id: SID_A, title: '甲' }]
  const h = mount()
  apiVersion = undefined
  assert.equal(await T.askThenDelete(SID_A, h.btn), false)
  assert.deepEqual(deleteCalls, [])
  assert.match(doc.getElementById('dshdc-notice').textContent, /旧版.*正常退出 DSH/)
  h.unmount()
})

await test('连续删除两个目标，按钮不会在第一次成功后永久禁用', async () => {
  fetchRows = [{ id: SID_A, title: '甲' }, { id: SID_B, title: '乙' }]
  const h = mount()
  assert.equal(await T.askThenDelete(SID_A, h.btn), true)
  h.hover(makeRow('乙'))
  assert.equal(h.btn.dataset.dshdcFor, SID_B)
  assert.equal(h.btn.disabled, false)
  assert.equal(await T.askThenDelete(SID_B, h.btn), true)
  assert.deepEqual(deleteCalls, [{ sessionId: SID_A }, { sessionId: SID_B }])
  h.unmount()
})

await test('正在删除时防重入且不把悬浮按钮换成另一个目标', async () => {
  fetchRows = [{ id: SID_A, title: '甲' }, { id: SID_B, title: '乙' }]
  const h = mount()
  await T.refreshTitleMap(true)
  h.hover(makeRow('甲'))
  let release
  onDelete = () => new Promise((resolve) => { release = resolve })
  const pending = T.askThenDelete(SID_A, h.btn)
  await new Promise((resolve) => setImmediate(resolve))
  h.hover(makeRow('乙'))
  assert.equal(h.btn.dataset.dshdcFor, SID_A)
  assert.equal(await T.askThenDelete(SID_A, h.btn), false)
  release()
  await pending
  assert.equal(deleteCalls.length, 1)
  h.unmount()
})

await test('卸载后返回的删除结果不会覆盖重装实例的提示', async () => {
  fetchRows = [{ id: SID_A, title: '甲' }]
  const first = mount()
  let release
  onDelete = () => new Promise((resolve) => { release = resolve })
  const pending = T.askThenDelete(SID_A, first.btn)
  await new Promise((resolve) => setImmediate(resolve))
  first.unmount()
  const second = mount()
  win.dshChatPrune.notify('新实例的提示', { tone: 'busy' })
  release()
  await pending
  assert.match(doc.getElementById('dshdc-notice').textContent, /新实例的提示/)
  second.unmount()
})

await test('重装实例不复用旧名单请求，旧回包不覆盖新名单和备份设置', async () => {
  let release
  onList = () => new Promise((resolve) => { release = resolve })
  const first = mount()
  const oldRefresh = T.refreshTitleMap(true)
  first.unmount()
  onList = null
  fetchRows = [{ id: SID_B, title: '新名单' }]
  const second = mount()
  try {
    const newRefresh = T.refreshTitleMap(true)
    release({ ok: true, status: 200, json: async () => ({
      ok: true, apiVersion: 1, sessions: [{ id: SID_A, title: '旧名单' }], config: { backup: true },
    }) })
    const map = await newRefresh
    await oldRefresh
    assert.deepEqual(map.sessions, fetchRows)
    assert.deepEqual(T.titleMap().sessions, fetchRows)
    assert.equal(win.__dshdcBackupOn, false)
  } finally {
    second.unmount()
  }
})

await test('服务端拒绝时给出可见原因，按钮恢复可重试', async () => {
  fetchRows = [{ id: SID_A, title: '甲' }]
  deleteReply = { ok: false, status: 409, data: { ok: false, error: '该会话正在运行' } }
  const h = mount()
  assert.equal(await T.askThenDelete(SID_A, h.btn), false)
  assert.match(doc.getElementById('dshdc-notice').textContent, /正在运行/)
  assert.equal(h.btn.disabled, false)
  h.unmount()
})

await test('删除完成后名单刷新失败不谎报删除失败', async () => {
  fetchRows = [{ id: SID_A, title: '甲' }]
  const h = mount()
  onDelete = () => { listFailure = true }
  assert.equal(await T.askThenDelete(SID_A, h.btn), true)
  assert.equal(h.btn.dataset.dshdcState, 'done')
  assert.match(doc.getElementById('dshdc-notice').textContent, /删除已完成.*刷新失败/)
  assert.equal(h.btn.disabled, false)
  h.unmount()
})

await test('请求超时明确显示结果待确认，而不是让用户盲目重删', async () => {
  fetchRows = [{ id: SID_A, title: '甲' }]
  const h = mount()
  onDelete = () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  }
  assert.equal(await T.askThenDelete(SID_A, h.btn), false)
  assert.match(doc.getElementById('dshdc-notice').textContent, /结果尚未确认.*刷新/)
  assert.equal(h.btn.disabled, false)
  h.unmount()
})

await test('部分删除失败说明重试清理并保留可见备份位置', async () => {
  fetchRows = [{ id: SID_A, title: '甲' }]
  const h = mount()
  deleteReply = { ok: false, status: 500, data: {
    ok: false, error: 'index failed', partial: true, backupDir: 'fixture-backup',
  } }
  assert.equal(await T.askThenDelete(SID_A, h.btn), false)
  assert.match(doc.getElementById('dshdc-notice').textContent, /删除可能已部分完成/)
  assert.match(doc.getElementById('dshdc-notice').textContent, /fixture-backup/)
  h.unmount()
})

await test('鼠标离开行和按钮后隐藏，快速跨行使用最后一个目标', async () => {
  fetchRows = [{ id: SID_A, title: '甲' }, { id: SID_B, title: '乙' }]
  const h = mount()
  await T.refreshTitleMap(true)
  const a = makeRow('甲'), b = makeRow('乙')
  doc.dispatch('mouseover', { target: a })
  doc.dispatch('mouseover', { target: b })
  flushFrames()
  assert.equal(h.btn.dataset.dshdcFor, SID_B)
  h.leave(b)
  assert.equal(h.btn.dataset.dshdcVisible, '0')
  h.unmount()
})

await test('卸载会移除悬浮层与样式，不留脏 DOM', () => {
  const h = mount()
  assert.ok(doc.getElementById('dshdc-layer'))
  h.unmount()
  assert.equal(doc.getElementById('dshdc-layer'), null, '悬浮层没清掉')
  assert.equal(doc.getElementById('dshdc-style'), null, '样式没清掉')
})

await test('不再注册 MutationObserver / 定时器（旧版拖垮输入的原因）', () => {
  const src = core.apply.toString() + (globalThis.__dshdcSrc || '')
  assert.equal(/MutationObserver/.test(src), false, '又用回 MutationObserver 了')
  assert.equal(/setInterval/.test(src), false, '又加定时器了')
})

console.log('\n== 文本兜底识别（宿主改 DOM 也能用）==\n')

await test('行不是 role=treeitem 时，靠标题文本仍能认出来', () => {
  fetchRows = [{ id: SID_A, title: '某个对话', workspace: '--w--' }]
  const h = mount()
  return (async () => {
    await T.refreshTitleMap(true)
    // 完全自定义的结构：没有 role、没有 data-*，只有一个 div 套着标题
    const row = doc.createElement('div')
    row.className = 'weird-row'
    const label = doc.createElement('span')
    label.textContent = '某个对话'
    row.appendChild(label)
    row.setRect({ top: 300, left: 0, width: 200, height: 28 })
    doc.body.appendChild(row)

    h.hover(label) // 悬停在内部文本上
    assert.equal(h.btn.dataset.dshdcVisible, '1', '纯文本兜底没生效')
    assert.equal(h.btn.dataset.dshdcFor, SID_A)
    h.unmount()
  })()
})

await test('兜底取最深的那个祖先，不会误抓到整棵列表', () => {
  fetchRows = [{ id: SID_A, title: '甲对话', workspace: '--w--' }]
  const h = mount()
  return (async () => {
    await T.refreshTitleMap(true)
    const tree = doc.createElement('div')
    tree.className = 'list-wrap'
    const row = doc.createElement('div')
    row.className = 'row'
    const label = doc.createElement('span')
    label.textContent = '甲对话'
    row.appendChild(label)
    tree.appendChild(row)
    doc.body.appendChild(tree)
    row.setRect({ top: 100, left: 0, width: 200, height: 30 })
    tree.setRect({ top: 0, left: 0, width: 200, height: 800 })

    h.hover(label)
    // 位置应来自 row（height 30），不是 tree（height 800）
    assert.equal(h.btn.style.top, `${100 + 15 - 11}px`, `取错祖先了: ${h.btn.style.top}`)
    h.unmount()
  })()
})

await test('名单为空时 hover 不抛错、按钮仍隐藏（重试是异步的）', () => {
  fetchRows = [{ id: SID_B, title: '乙对话', workspace: '--w--' }]
  T.setTitleMap({ byTitle: new Map(), fetchedAt: Date.now() })
  const h = mount()
  const row = makeRow('乙对话')
  h.hover(row)
  assert.equal(h.btn.dataset.dshdcVisible, '0')
  h.unmount()
})

console.log('\n== 提示条：必须能消失 ==\n')

await test('提示条带关闭按钮，点一下立刻消失', () => {
  const h = mount()
  win.dshChatPrune.notify('删除失败: 该会话正在运行', { tone: 'error' })
  const notice = doc.getElementById('dshdc-notice')
  assert.ok(notice, '提示条没创建')
  assert.equal(notice.hidden, false)

  const close = notice.querySelector('.dshdc-notice-close')
  assert.ok(close, '缺少关闭按钮')
  close.dispatch('click', { preventDefault() {}, stopPropagation() {} })
  assert.equal(notice.hidden, true, '点关闭后应当消失')
  h.unmount()
})

await test('失败提示会自动消失（不再永久钉住）', () => {
  const h = mount()
  // 用一个很短的超时验证定时器真的挂了
  win.dshChatPrune.notify('删除失败: 该会话正在运行', { tone: 'error', timeout: 15 })
  const notice = doc.getElementById('dshdc-notice')
  assert.equal(notice.hidden, false)
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        assert.equal(notice.hidden, true, '超时后提示条应自动消失')
        h.unmount()
        resolve()
      } catch (e) {
        reject(e)
      }
    }, 60)
  })
})

await test('新提示会顶掉旧提示，不会堆叠或残留', () => {
  const h = mount()
  win.dshChatPrune.notify('删除中…', { tone: 'busy' })
  win.dshChatPrune.notify('已删除', { tone: 'done' })
  // 桩不支持 #id 选择器，手动数一遍
  const count = (node) => {
    let n = node.getAttribute?.('id') === 'dshdc-notice' ? 1 : 0
    for (const child of node.children || []) n += count(child)
    return n
  }
  const total = count(doc.body)
  assert.equal(total, 1, `提示条不应堆叠，实际 ${total} 个`)
  assert.match(doc.getElementById('dshdc-notice').textContent, /已删除/)
  h.unmount()
})

await test('忙碌状态的提示在结果到来前不会自己消失', () => {
  const h = mount()
  win.dshChatPrune.notify('删除中…', { tone: 'busy' })
  const notice = doc.getElementById('dshdc-notice')
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        assert.equal(notice.hidden, false, 'busy 提示不该被定时清掉')
        h.unmount()
        resolve()
      } catch (e) {
        reject(e)
      }
    }, 60)
  })
})

console.log(`\n== 结果: ${pass} 通过 / ${fail} 失败 ==\n`)
process.exit(fail > 0 ? 1 : 0)
