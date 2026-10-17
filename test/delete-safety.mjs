import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { apply, deleteSession, listSessions } from '../lib/index.js'

const id = 'session-safety-a'
const other = 'session-safety-b'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dshdc-safety-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const dir = join(home, 'sessions', 'workspace', id)
  await mkdir(dir, { recursive: true })
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'record')
  const wsPath = join(home, 'storages', 'workspace.json')
  const doc = {
    global: { pinnedSessionIds: [id], archivedSessionIds: [id] },
    tables: { workspaces: { ws: { sessionIds: [id, other] } } },
  }
  await writeFile(wsPath, JSON.stringify(doc))
  const ctx = { profileContext: { home }, sessions: { get: () => undefined } }
  return { home, dir, wsPath, ctx, doc }
}

test('exported deletion validates identifiers before reading or changing disk', async (t) => {
  const f = await fixture(t)
  await assert.rejects(() => deleteSession(f.ctx, '../workspace', {}), { status: 400 })
  assert.equal(await readFile(join(f.dir, 'session.v4.jsonl.zstd'), 'utf8'), 'record')
})

test('missing session files still clean stale index and backup cache files', async (t) => {
  const f = await fixture(t)
  await rm(f.dir, { recursive: true })
  const cache = join(f.home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cache, { recursive: true })
  await writeFile(join(cache, `${id}.json.bak-old`), '{}')
  const result = await deleteSession(f.ctx, id, { backup: false })
  assert.equal(result.indexPatched, true)
  assert.deepEqual(await readdir(cache), [])
  const doc = JSON.parse(await readFile(f.wsPath, 'utf8'))
  assert.deepEqual(doc.tables.workspaces.ws.sessionIds, [other])
  assert.deepEqual(doc.global.archivedSessionIds, [])
})

test('live registry uses the verified service and owns persistence writes', async (t) => {
  const f = await fixture(t)
  const calls = []
  const entity = {
    record: { sessionIds: [id, other] },
    async detachSession(value) { calls.push(['detach', value]) },
  }
  const registry = {
    list: () => [entity],
    async unpinSession(value) { calls.push(['unpin', value]) },
    async unarchiveSession(value) { calls.push(['unarchive', value]) },
  }
  f.ctx.get = (key) => key === 'workspaceRegistry' ? registry : undefined
  const result = await deleteSession(f.ctx, id, { backup: false })
  assert.equal(result.detached, true)
  assert.deepEqual(calls, [['detach', id], ['unpin', id], ['unarchive', id]])
  // A live storage domain must never race a plugin rewriting its JSON behind it.
  assert.deepEqual(JSON.parse(await readFile(f.wsPath, 'utf8')), f.doc)
})

test('registry captured before disk operations remains the cleanup owner', async (t) => {
  const f = await fixture(t)
  const calls = []
  const registry = {
    list: () => [{ record: { sessionIds: [id] }, async detachSession() { calls.push('detach') } }],
    async unpinSession() { calls.push('unpin') },
    async unarchiveSession() { calls.push('unarchive') },
  }
  let gets = 0
  f.ctx.get = (key) => key === 'workspaceRegistry' && gets++ === 0 ? registry : undefined
  const result = await deleteSession(f.ctx, id, { backup: false })
  assert.equal(result.detached, true)
  assert.deepEqual(calls, ['detach', 'unpin', 'unarchive'])
})

test('Windows deletion holds public write ownership until registry cleanup completes', {
  skip: process.platform !== 'win32' && 'Online ownership deletion is Windows-specific',
}, async (t) => {
  const f = await fixture(t)
  let owned = false
  let released = false
  f.ctx.sessionPersistence = {
    async open(value, access) {
      assert.equal(value, id)
      assert.equal(access, 'write')
      owned = true
      return { async close() { owned = false; released = true } }
    },
  }
  f.ctx.workspaceRegistry = {
    list: () => [{ record: { sessionIds: [id] }, async detachSession() { assert.equal(owned, true) } }],
    async unpinSession() { assert.equal(owned, true) },
    async unarchiveSession() { assert.equal(owned, true) },
  }
  const result = await deleteSession(f.ctx, id, { backup: true })
  assert.equal(result.ok, true)
  assert.equal(released, true)
  assert.equal(owned, false)
})

test('Windows write ownership contention leaves original data intact, including force mode', {
  skip: process.platform !== 'win32' && 'Online ownership deletion is Windows-specific',
}, async (t) => {
  const f = await fixture(t)
  f.ctx.sessionPersistence = {
    async open() {
      const error = new Error('session already owned')
      error.name = 'SessionAlreadyOwnedError'
      throw error
    },
  }
  await assert.rejects(() => deleteSession(f.ctx, id, { allowRunning: true }), { status: 409 })
  assert.equal(await readFile(join(f.dir, 'session.v4.jsonl.zstd'), 'utf8'), 'record')
})

test('Windows write handle is released when backup fails', {
  skip: process.platform !== 'win32' && 'Online ownership deletion is Windows-specific',
}, async (t) => {
  const f = await fixture(t)
  let released = false
  f.ctx.sessionPersistence = { async open() { return { async close() { released = true } } } }
  await writeFile(join(f.home, 'deleted-sessions'), 'blocking file')
  await assert.rejects(() => deleteSession(f.ctx, id, { backup: true }))
  assert.equal(released, true)
})

test('a directory appearing after a missing lookup is never deleted without ownership', async (t) => {
  const f = await fixture(t)
  await rm(f.dir, { recursive: true })
  f.ctx.get = (key) => {
    if (key === 'workspaceRegistry') {
      mkdirSync(f.dir, { recursive: true })
      writeFileSync(join(f.dir, 'session.v4.jsonl.zstd'), 'new record')
    }
    return undefined
  }
  await assert.rejects(() => deleteSession(f.ctx, id, { allowRunning: true }), { status: 409 })
  assert.equal(await readFile(join(f.dir, 'session.v4.jsonl.zstd'), 'utf8'), 'new record')
})

test('Windows combined delete and handle-close failures retain recovery details', {
  skip: process.platform !== 'win32' && 'Online ownership deletion is Windows-specific',
}, async (t) => {
  const f = await fixture(t)
  f.ctx.sessionPersistence = {
    async open() { return { async close() { throw new Error('close failed') } } },
  }
  f.ctx.workspaceRegistry = {
    list: () => [{ record: { sessionIds: [id] }, async detachSession() { throw new Error('index failed') } }],
    async unpinSession() {},
    async unarchiveSession() {},
  }
  await assert.rejects(() => deleteSession(f.ctx, id, { backup: true }), (error) => {
    assert.equal(error.deletion.partial, true)
    assert.ok(error.deletion.backupDir)
    assert.equal(error.errors.length, 2)
    return /index failed/.test(error.message) && /close failed/.test(error.message)
  })
})

test('partial registry failure is visible and missing index rows remain retryable', async (t) => {
  const f = await fixture(t)
  const registry = {
    list: () => [{ record: { sessionIds: [id] }, async detachSession() { throw new Error('index unavailable') } }],
    async unpinSession() {},
    async unarchiveSession() {},
  }
  f.ctx.workspaceRegistry = registry
  await assert.rejects(() => deleteSession(f.ctx, id, { backup: true }), (error) => {
    assert.equal(error.deletion.partial, true)
    assert.ok(error.deletion.backupDir)
    return /index unavailable/.test(error.message)
  })
  const rows = await listSessions(f.ctx)
  assert.equal(rows.find((row) => row.id === id).missing, true)
  registry.list = () => [{ record: { sessionIds: [id] }, async detachSession() {} }]
  const result = await deleteSession(f.ctx, id, { backup: true })
  assert.equal(result.ok, true)
  assert.equal(result.detached, true)
})

test('all cache paths are validated before removing original session records', async (t) => {
  const f = await fixture(t)
  await mkdir(join(f.home, 'storages', 'session_projcache', 'sessions', `${id}.json`), { recursive: true })
  await assert.rejects(() => deleteSession(f.ctx, id, { backup: false }), { status: 409 })
  assert.equal(await readFile(join(f.dir, 'session.v4.jsonl.zstd'), 'utf8'), 'record')
})

test('corrupt offline index fails before irreversible removal', async (t) => {
  const f = await fixture(t)
  await writeFile(f.wsPath, '{broken')
  await assert.rejects(() => deleteSession(f.ctx, id, { backup: false }))
  assert.equal(await readFile(join(f.dir, 'session.v4.jsonl.zstd'), 'utf8'), 'record')
})

test('simultaneous deletions preserve both index changes', async (t) => {
  const f = await fixture(t)
  const dirB = join(f.home, 'sessions', 'workspace', other)
  await mkdir(dirB)
  await writeFile(join(dirB, 'session.v4.jsonl.zstd'), 'b')
  await Promise.all([
    deleteSession(f.ctx, id, { backup: false }),
    deleteSession(f.ctx, other, { backup: false }),
  ])
  const doc = JSON.parse(await readFile(f.wsPath, 'utf8'))
  assert.deepEqual(doc.tables.workspaces.ws.sessionIds, [])
})

test('same id in multiple workspace directories is rejected without removal', async (t) => {
  const f = await fixture(t)
  const duplicate = join(f.home, 'sessions', 'second', id)
  await mkdir(duplicate, { recursive: true })
  await writeFile(join(duplicate, 'session.v4.jsonl.zstd'), 'duplicate')
  await assert.rejects(() => deleteSession(f.ctx, id, { backup: false }), { status: 409 })
  assert.equal(await readFile(join(f.dir, 'session.v4.jsonl.zstd'), 'utf8'), 'record')
})

test('unavailable activity detection refuses destructive deletion', async (t) => {
  const f = await fixture(t)
  delete f.ctx.sessions
  await assert.rejects(() => deleteSession(f.ctx, id, { backup: false }), { status: 503 })
  assert.equal(await readFile(join(f.dir, 'session.v4.jsonl.zstd'), 'utf8'), 'record')
})

test('activity detection errors never masquerade as idle', async (t) => {
  const f = await fixture(t)
  f.ctx.sessions.get = () => { throw new Error('service failed') }
  await assert.rejects(() => deleteSession(f.ctx, id, { backup: false }), { status: 503 })
  assert.equal(await readFile(join(f.dir, 'session.v4.jsonl.zstd'), 'utf8'), 'record')
})

test('backup failure leaves session and index intact', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.home, 'deleted-sessions'), 'blocking file')
  await assert.rejects(() => deleteSession(f.ctx, id, { backup: true }))
  assert.equal(await readFile(join(f.dir, 'session.v4.jsonl.zstd'), 'utf8'), 'record')
  assert.deepEqual(JSON.parse(await readFile(f.wsPath, 'utf8')), f.doc)
})

test('linked session directories are rejected without touching their target', async (t) => {
  const f = await fixture(t)
  const outside = join(f.home, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'sentinel'), 'keep')
  await rm(f.dir, { recursive: true })
  await symlink(outside, f.dir, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(() => deleteSession(f.ctx, id, { backup: false }), { status: 409 })
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep')
})

test('HTTP sessions exposes effective backup config and malformed path is a 400', async (t) => {
  const f = await fixture(t)
  let route
  apply({
    ...f.ctx,
    sessionPersistence: { async open() { return { async close() {} } } },
    webServer: { register(value) { route = value; return () => {} } },
    effect: (fn) => fn(),
    on: () => () => {},
  }, { backup: true })
  async function request(method, url) {
    let status, body
    await route.handler({ method, url, async *[Symbol.asyncIterator]() {} }, {
      writeHead(value) { status = value },
      end(value) { body = JSON.parse(value) },
    })
    return { status, body }
  }
  const list = await request('GET', '/dsh-delete-chat/sessions')
  assert.equal(list.body.config.backup, true)
  assert.equal((await request('DELETE', '/dsh-delete-chat/sessions/%zz')).status, 400)
})

test('HTTP deletion refuses a missing persistence dependency before changing disk', async (t) => {
  const f = await fixture(t)
  let route, status
  apply({
    ...f.ctx,
    webServer: { register(value) { route = value; return () => {} } },
    effect: (fn) => fn(),
    on: () => () => {},
  }, {})
  await route.handler({
    method: 'DELETE', url: '/dsh-delete-chat/sessions',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: id })) },
  }, { writeHead(value) { status = value }, end() {} })
  assert.equal(status, 503)
  assert.equal(await readFile(join(f.dir, 'session.v4.jsonl.zstd'), 'utf8'), 'record')
})
