import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client-slot.js', import.meta.url), 'utf8')

function fixture(refresh = async () => {}) {
  let registered, disposed = false
  const states = []
  const calls = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, (value) => states.push(value)],
  }
  const window = {
    __ModuleLoader__: { load: (value) => { registered = value } },
    dshChatPrune: {
      requestDelete: async (...args) => { calls.push(args) },
      openManager: () => calls.push('manager'),
    },
  }
  const sandbox = { window, navigator: { language: 'zh-CN' }, document: { querySelector: () => null } }
  vm.runInNewContext(source, sandbox)
  const module = registered.factory((name) => { assert.equal(name, 'react'); return React })
  let entry, component
  const cleanups = [], registrations = new Map()
  const effects = []
  const byId = {}
  const ctx = { effect: (effect) => effects.push(effect()), sessions: {
    refresh: () => refresh(byId),
    list: { getSnapshot: () => ({ byId }) },
  }, slots: {
    inject(name, callback) {
      assert.ok(['sidebar.workspaces.session.row.action', 'sidebar.footer.action'].includes(name))
      cleanups.push(callback())
    },
    register(options, value) {
      registrations.set(options.name, value)
      if (options.name === 'sidebar.workspaces.session.row.action') {
        entry = options
        component = value
      }
      return () => { disposed = true }
    },
  } }
  module.apply(ctx)
  return { module, entry, component, window, states, calls, registered, byId, registrations,
    cleanup: () => { cleanups.forEach((dispose) => dispose()); effects.forEach((dispose) => dispose()) }, disposed: () => disposed }
}

test('manager uses the sidebar footer slot in expanded and collapsed layouts', () => {
  const f = fixture()
  const component = f.registrations.get('sidebar.footer.action')
  const wide = component({ wide: true }), collapsed = component({ wide: false })
  assert.equal(wide.props['aria-label'], '管理对话')
  assert.equal(wide.children[1].children[0], '管理对话')
  assert.equal(collapsed.children[1], null)
  collapsed.props.onClick()
  assert.deepEqual(f.calls, ['manager'])
  assert.equal(f.window.__dshChatPruneManagerSlotReady__, true)
  f.cleanup()
  assert.equal(f.window.__dshChatPruneManagerSlotReady__, false)
})

test('native module exports a plugin and registers an actual React component', () => {
  const f = fixture()
  assert.equal(f.registered.id, 'dsh-chat-prune')
  assert.deepEqual(Array.from(f.module.inject), ['slots', 'sessions'])
  assert.equal(f.entry.name, 'sidebar.workspaces.session.row.action')
  assert.equal(typeof f.component, 'function')
  assert.equal(f.window.__dshChatPruneNativeSlotReady__, true)
  f.cleanup()
  assert.equal(f.disposed(), true)
  assert.equal(f.window.__dshChatPruneNativeSlotReady__, false)
  assert.equal(f.window.__dshChatPruneRefreshSessions__, undefined)
})

test('native row action receives exact sessionId and delegates to the shared confirmation flow', async () => {
  const f = fixture()
  const button = {}
  const element = f.component({ sessionId: 'session-native-exact' })
  assert.equal(element.type, 'button')
  assert.equal(element.props['aria-label'], '删除对话')
  let prevented = false, stopped = false
  await element.props.onClick({
    currentTarget: button,
    preventDefault() { prevented = true },
    stopPropagation() { stopped = true },
  })
  assert.equal(prevented && stopped, true)
  assert.deepEqual(f.calls, [['session-native-exact', button]])
  assert.deepEqual(f.states, [true, false])
})

test('native module never submits when its shared client has not initialized', async () => {
  const f = fixture()
  delete f.window.dshChatPrune
  const element = f.component({ sessionId: 'session-native' })
  await element.props.onClick({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(f.calls, [])
  assert.match(f.states[0], /尚未就绪/)
})

test('refresh reconciles the official session catalog after deletion', async () => {
  let pulls = 0
  const f = fixture(async (byId) => { pulls++; delete byId['session-deleted'] })
  f.byId['session-deleted'] = {}
  await f.window.__dshChatPruneRefreshSessions__('session-deleted')
  assert.equal(pulls, 1)
  assert.equal(f.byId['session-deleted'], undefined)
})

test('a stale in-flight baseline is followed by a new pull', async () => {
  let pulls = 0
  const f = fixture(async (byId) => { if (++pulls === 2) delete byId['session-deleted'] })
  f.byId['session-deleted'] = {}
  await f.window.__dshChatPruneRefreshSessions__('session-deleted')
  assert.equal(pulls, 2)
})

test('refresh does not report stale catalog membership as reconciled', async () => {
  const f = fixture()
  f.byId['session-deleted'] = {}
  await assert.rejects(f.window.__dshChatPruneRefreshSessions__('session-deleted'), /still contains/)
})
