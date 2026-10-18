import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trackAgentHandles, canReleaseAgent, releaseIdleAgent } from '../lib/agent-lifecycle.js'
import { deleteSession, listSessions } from '../lib/index.js'

test('idle historical sessions release the original handle before acquiring deletion ownership', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-lifecycle-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const id = 'session-opened', active = 'session-active'
  const entries = new Map(), loaded = new Map(), events = []
  for (const sessionId of [id, active]) {
    await mkdir(join(home, 'sessions', 'workspace', sessionId), { recursive: true })
    await writeFile(join(home, 'sessions', 'workspace', sessionId, 'record'), 'keep')
  }
  const registry = {
    get: (id) => entries.get(id),
    async create({ id }) {
      const agent = { id, status: 'idle' }
      entries.set(id, agent); loaded.set(id, { id })
      return { agent, async dispose() { events.push(`dispose:${id}`); entries.delete(id); loaded.delete(id) } }
    },
    async resume({ id }) { return this.create({ id }) },
  }
  const original = registry.resume
  const dispose = trackAgentHandles(registry)
  t.after(dispose)
  const ctx = { profileContext: { home }, agents: registry, sessions: { get: (id) => loaded.get(id) },
    sessionPersistence: { async open(id, access) {
      assert.equal(loaded.has(id), false)
      assert.equal(access, 'write')
      events.push(`open:${id}`)
      return { async close() { events.push(`close:${id}`) } }
    } } }
  await registry.resume({ id })
  const runningHandle = await registry.create({ id: active })
  runningHandle.agent.status = 'running'
  assert.equal(canReleaseAgent(registry, id), true)
  const rows = await listSessions(ctx)
  assert.equal(rows.find((row) => row.id === id).running, false)
  assert.equal(rows.find((row) => row.id === active).running, true)
  await assert.rejects(() => deleteSession(ctx, active), { status: 409 })
  assert.equal(await readFile(join(home, 'sessions', 'workspace', active, 'record'), 'utf8'), 'keep')
  assert.equal(events.length, 0)
  entries.get(id).status = 'running'
  await assert.rejects(() => deleteSession(ctx, id), { status: 409 })
  assert.equal(events.length, 0, 'An idle preview cannot authorize deleting a newly running agent')
  entries.get(id).status = 'idle'
  await deleteSession(ctx, id)
  assert.deepEqual(events, [`dispose:${id}`, `open:${id}`, `close:${id}`])
  await assert.rejects(() => readFile(join(home, 'sessions', 'workspace', id, 'record')), { code: 'ENOENT' })
  dispose()
  assert.equal(registry.resume, original)
})

test('a new running state or replacement agent invalidates an idle handle', async (t) => {
  const agents = new Map()
  const registry = { get: (id) => agents.get(id), async create({ id }) {
    const agent = { id, status: 'idle' }; agents.set(id, agent)
    return { agent, async dispose() { throw new Error('must not dispose') } }
  }, async resume(args) { return this.create(args) } }
  const dispose = trackAgentHandles(registry)
  t.after(dispose)
  const handle = await registry.create({ id: 'session-one' })
  handle.agent.status = 'running'
  assert.equal(canReleaseAgent(registry, 'session-one'), false)
  handle.agent.status = 'idle'
  agents.set('session-one', { id: 'session-one', status: 'idle' })
  assert.equal(canReleaseAgent(registry, 'session-one'), false)
})

test('Cordis caller proxies share tracking while create and resume retain the caller context', async () => {
  const agents = new Map(), owners = [], originalSymbol = Symbol.for('cordis.original')
  const registry = {
    get: (id) => agents.get(id),
    async create({ id }) {
      owners.push(this.ctx)
      const agent = { id, status: 'idle' }; agents.set(id, agent)
      return { agent, async dispose() { agents.delete(id) } }
    },
    async resume(options) { return this.create(options) },
  }
  const proxy = (ctx) => new Proxy(registry, { get(target, key, receiver) {
    if (key === originalSymbol) return target
    if (key === 'ctx') return ctx
    return Reflect.get(target, key, receiver)
  } })
  const first = proxy('first'), second = proxy('second')
  const stopFirst = trackAgentHandles(first), stopSecond = trackAgentHandles(second)
  await first.create({ id: 'session-one' })
  await second.resume({ id: 'session-two' })
  assert.deepEqual(owners, ['first', 'second'])
  assert.equal(canReleaseAgent(proxy('third'), 'session-one'), true)
  stopFirst(); stopFirst()
  assert.equal(canReleaseAgent(second, 'session-two'), true)
  await releaseIdleAgent(proxy('fourth'), 'session-one')
  assert.equal(agents.has('session-one'), false)
  stopSecond()
  stopFirst()
})
