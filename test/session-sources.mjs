import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, listSessions } from '../lib/index.js'
import { createSessionSources } from '../lib/session-sources.js'
import { buildPrunePlan, filterSessions, sessionKey } from '../lib/pruning-policy.js'

test('multiple directories merge identical IDs and route mutations to their own host and index', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sources-'))
  const servers = []
  t.after(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })))
    await rm(root, { recursive: true, force: true })
  })
  async function host(name, token) {
    const home = join(root, name), id = 'session-same'
    const dir = join(home, 'sessions', 'workspace', id)
    await mkdir(dir, { recursive: true })
    await mkdir(join(home, 'storages'))
    await writeFile(join(dir, 'record'), name)
    const index = join(home, 'storages', 'workspace.json')
    await writeFile(index, JSON.stringify({ tables: { workspaces: { same: { title: 'Same workspace', sessionIds: [id] } } } }))
    let route, corruptDelete = false
    apply({ profileContext: { home }, sessions: { get: () => undefined },
      sessionPersistence: { async open() { return { async close() {} } } },
      webServer: { register(value) { route = value; return () => {} } },
      effect: (fn) => fn(), on: () => () => {},
    }, {})
    const server = createServer((req, res) => {
      if (token && new URL(req.url, 'http://localhost').searchParams.get('token') !== token) {
        res.writeHead(403); res.end(JSON.stringify({ ok: false, error: 'Authentication required' })); return
      }
      if (req.method === 'DELETE' && corruptDelete) {
        corruptDelete = false
        route.handler(req, {
          writeHead(status) { res.writeHead(status, { 'content-type': 'application/json' }) },
          end() { res.end('{') },
        })
      } else route.handler(req, res)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    return { home, dir, index, url: `http://127.0.0.1:${server.address().port}/${token ? `?token=${token}` : ''}`,
      corruptNextDelete: () => { corruptDelete = true } }
  }
  const a = await host('A'), b = await host('B', 'fixture-secret'), offline = await host('offline')
  async function request(method, route, body) {
    const url = new URL(a.url); url.pathname = `/dsh-chat-prune/${route}`
    const response = await fetch(url, { method, headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, body: await response.json() }
  }
  assert.equal((await request('POST', 'sources', { home: b.home, name: 'B', endpoint: b.url })).status, 200)
  assert.equal((await request('POST', 'sources', { home: offline.home, name: 'Offline' })).status, 200)
  let list = (await request('GET', 'sessions')).body
  assert.equal(list.sessions.length, 3)
  assert.equal(new Set(list.sessions.map(sessionKey)).size, 3)
  assert.equal(JSON.stringify(list).includes('fixture-secret'), false)
  const remote = list.sessions.find((row) => row.sourceName === 'B')
  assert.equal(remote.readOnly, false)
  assert.equal(filterSessions(list.sessions, { source: remote.sourceId }).length, 1)
  assert.equal(filterSessions(list.sessions, { query: b.home }).length, 1)
  assert.equal(buildPrunePlan(list.sessions, list.sessions, { keepRecent: 1, olderDays: 0 }).sessions.length, 0)
  const blocked = list.sessions.find((row) => row.readOnly)
  assert.equal((await request('DELETE', 'sessions', { sessionId: blocked.id, sourceId: blocked.sourceId })).status, 409)
  assert.equal((await request('DELETE', 'sessions', { sessionId: remote.id, sourceId: remote.sourceId, backup: true })).status, 200)
  assert.equal(await readFile(join(a.dir, 'record'), 'utf8'), 'A')
  assert.equal(await readFile(join(offline.dir, 'record'), 'utf8'), 'offline')
  assert.deepEqual(JSON.parse(await readFile(a.index, 'utf8')).tables.workspaces.same.sessionIds, ['session-same'])
  assert.deepEqual(JSON.parse(await readFile(b.index, 'utf8')).tables.workspaces.same.sessionIds, [])
  await assert.rejects(() => readFile(join(b.dir, 'record')), { code: 'ENOENT' })
  list = (await request('GET', 'sessions')).body
  assert.equal(list.sessions.length, 2)
  await mkdir(b.dir, { recursive: true })
  await writeFile(join(b.dir, 'record'), 'again')
  b.corruptNextDelete()
  const unknown = await request('DELETE', 'sessions', { sessionId: remote.id, sourceId: remote.sourceId })
  assert.equal(unknown.status, 502)
  assert.equal(unknown.body.outcomeUnknown, true, 'A lost proxy response cannot be called a definitive failure')
  assert.equal(await readFile(join(a.dir, 'record'), 'utf8'), 'A')
  assert.equal((await request('POST', 'sources', { home: offline.home, endpoint: b.url })).status, 409)
  assert.equal((await request('POST', 'sources', { home: b.home, endpoint: 'http://example.com/' })).status, 400)
  assert.equal((await request('POST', 'sources', { home: a.home })).status, 400)
  assert.equal((await request('DELETE', 'sources', { sourceId: 'local' })).status, 400)
  assert.equal((await request('DELETE', 'sources', { sourceId: remote.sourceId })).status, 200)
  assert.equal((await request('DELETE', 'sessions', { sourceId: remote.sourceId, sessionId: remote.id })).status, 404)
  assert.equal(await readFile(join(offline.dir, 'record'), 'utf8'), 'offline')
  const firstManager = createSessionSources({ home: a.home, listLocal: listSessions })
  const secondManager = createSessionSources({ home: a.home, listLocal: listSessions })
  await Promise.all([
    firstManager.add({ name: 'Restored B', home: b.home, endpoint: b.url }),
    secondManager.add({ name: 'Renamed offline', home: offline.home }),
  ])
  const settings = JSON.parse(await readFile(join(a.home, 'storages', 'dsh-chat-prune-sources.json'), 'utf8'))
  assert.deepEqual(settings.map((entry) => entry.name).sort(), ['Renamed offline', 'Restored B'])
  await firstManager.add({ name: 'Renamed B', home: b.home })
  assert.equal((await secondManager.list()).sources.find((entry) => entry.home === b.home).connected, true,
    'Editing a name without supplying a new URL preserves authentication')
  await writeFile(offline.index, '{')
  const isolated = (await request('GET', 'sessions')).body
  assert.equal(isolated.sessions.some((entry) => entry.sourceId === 'local'), true)
  assert.ok(isolated.sources.find((entry) => entry.home === offline.home).error,
    'An unreadable source reports its own error while preserving healthy records')
})
