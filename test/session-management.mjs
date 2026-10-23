import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, deleteSession, listSessions, manageSession } from '../lib/index.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-prune-management-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const dir = join(home, 'sessions', 'project', 'session-one')
  await mkdir(join(dir, 'attachments'), { recursive: true })
  await writeFile(join(dir, 'record'), 'hello')
  await writeFile(join(dir, 'attachments', 'image'), 'picture')
  const registry = {
    pinnedSessionIds: ['session-one'], archivedSessionIds: [],
    list: () => [{
      id: 'workspace-one', title: 'Project One',
      record: { sessionIds: ['session-one', 'session-missing'] },
      // 真实宿主的工作区实体带 detachSession；缺了它 host 会按「服务不兼容」拒绝删除
      async detachSession(value) {
        this.record.sessionIds = this.record.sessionIds.filter((entry) => entry !== value)
      },
    }],
    async archiveSession(id) { this.archivedSessionIds.push(id); this.pinnedSessionIds = this.pinnedSessionIds.filter((value) => value !== id) },
    async unarchiveSession(id) { this.archivedSessionIds = this.archivedSessionIds.filter((value) => value !== id) },
    async pinSession(id) { this.pinnedSessionIds.push(id) },
    async unpinSession(id) { this.pinnedSessionIds = this.pinnedSessionIds.filter((value) => value !== id) },
  }
  const ctx = { profileContext: { home }, workspaceRegistry: registry, sessions: { get: () => undefined } }
  return { home, dir, registry, ctx }
}

test('list exposes workspace identity, pin/archive flags, missing records and nested sizes', async (t) => {
  const f = await fixture(t)
  const rows = await listSessions(f.ctx)
  const row = rows.find((entry) => entry.id === 'session-one')
  assert.equal(row.workspace, 'Project One')
  assert.equal(row.workspaceKey, 'workspace-one')
  assert.equal(row.workspaceSlug, 'project')
  assert.equal(row.bytes, 12)
  assert.equal(row.files, 2)
  assert.equal(row.pinned, true)
  assert.equal(row.archived, false)
  assert.equal(rows.find((entry) => entry.id === 'session-missing').missing, true)
})

test('management invokes durable public methods, returns errors and does not remove records', async (t) => {
  const f = await fixture(t)
  await manageSession(f.ctx, 'session-one', 'archive')
  let row = (await listSessions(f.ctx)).find((entry) => entry.id === 'session-one')
  assert.equal(row.archived, true)
  assert.equal(row.pinned, false)
  await manageSession(f.ctx, 'session-one', 'unarchive')
  await manageSession(f.ctx, 'session-one', 'pin')
  row = (await listSessions(f.ctx)).find((entry) => entry.id === 'session-one')
  assert.equal(row.archived, false)
  assert.equal(row.pinned, true)
  await manageSession(f.ctx, 'session-one', 'unpin')
  assert.deepEqual(f.registry.pinnedSessionIds, [])
  assert.equal(await readFile(join(f.dir, 'record'), 'utf8'), 'hello')
  f.registry.archiveSession = async () => { throw Object.assign(new Error('active'), { name: 'WorkspaceActiveSessionError' }) }
  await assert.rejects(() => manageSession(f.ctx, 'session-one', 'archive'), { status: 409 })
})

test('invalid actions, path IDs, unknown records and unavailable capabilities do not call host methods', async (t) => {
  const f = await fixture(t)
  await assert.rejects(() => manageSession(f.ctx, '../outside', 'archive'), { status: 400 })
  await assert.rejects(() => manageSession(f.ctx, 'session-one', 'constructor'), { status: 400 })
  await assert.rejects(() => manageSession(f.ctx, 'session-one', { toString: 'archive' }), { status: 400 })
  await assert.rejects(() => manageSession(f.ctx, 'session-unknown', 'archive'), { status: 404 })
  delete f.registry.pinSession
  await assert.rejects(() => manageSession(f.ctx, 'session-one', 'pin'), { status: 503 })
})

test('batch guard refuses a record pinned after preview and retains files', async (t) => {
  const f = await fixture(t)
  await assert.rejects(() => deleteSession(f.ctx, 'session-one', { protectPinned: true }), { status: 409 })
  assert.equal(await readFile(join(f.dir, 'record'), 'utf8'), 'hello')
})

test('batch guard refuses updates made after preview, including nested attachments', async (t) => {
  const f = await fixture(t)
  const row = (await listSessions(f.ctx)).find((entry) => entry.id === 'session-one')
  await utimes(join(f.dir, 'attachments', 'image'), new Date(), new Date(Date.now() + 10000))
  await assert.rejects(() => deleteSession(f.ctx, 'session-one', { expectedMtime: row.mtime }), { status: 409 })
  assert.equal(await readFile(join(f.dir, 'record'), 'utf8'), 'hello')
})

test('revision detects removal of an older file even when the maximum timestamp is unchanged', async (t) => {
  const f = await fixture(t)
  const future = new Date(Date.now() + 60000)
  await utimes(join(f.dir, 'record'), future, future)
  const row = (await listSessions(f.ctx)).find((entry) => entry.id === 'session-one')
  await rm(join(f.dir, 'attachments', 'image'))
  const changed = (await listSessions(f.ctx)).find((entry) => entry.id === 'session-one')
  assert.equal(changed.mtime, row.mtime)
  assert.notEqual(changed.revision, row.revision)
  await assert.rejects(() => deleteSession(f.ctx, 'session-one', {
    expectedMtime: row.mtime, expectedRevision: row.revision,
  }), { status: 409 })
  assert.equal(await readFile(join(f.dir, 'record'), 'utf8'), 'hello')
})

test('HTTP exposes capability gating, validates preview timestamp and cannot disable host backups', async (t) => {
  const f = await fixture(t)
  let route
  apply({ ...f.ctx,
    sessionPersistence: { async open() { return { async close() {} } } },
    webServer: { register(value) { route = value; return () => {} } },
    effect: (fn) => fn(), on: () => () => {},
  }, { backup: true, allowRunning: true })
  async function request(method, path, payload) {
    let status, body
    await route.handler({ method, url: `/dsh-chat-prune/${path}`,
      async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(JSON.stringify(payload)) },
    }, { writeHead(value) { status = value }, end(value) { body = JSON.parse(value) } })
    return { status, body }
  }
  assert.deepEqual((await request('GET', 'sessions')).body.actions,
    ['archive', 'unarchive', 'pin', 'unpin', 'compress', 'decompress', 'export'])
  assert.equal((await request('GET', 'sessions')).body.managementVersion, 1)
  assert.equal((await request('POST', 'sessions/action', { sessionId: 'session-one', action: 'archive' })).status, 200)
  assert.equal((await request('DELETE', 'sessions', { sessionId: 'session-one', expectedMtime: -1 })).status, 400)
  assert.equal((await request('DELETE', 'sessions', { sessionId: 'session-one', expectedRevision: 'invalid' })).status, 400)
  // 上一行 archive 会顺带取消置顶，这里显式恢复，才真的测到「置顶保护」
  f.registry.pinnedSessionIds = ['session-one']
  assert.equal((await request('DELETE', 'sessions', { sessionId: 'session-one', protectPinned: true })).status, 409)
  assert.equal(await readFile(join(f.dir, 'record'), 'utf8'), 'hello')
  assert.equal((await request('GET', 'sessions')).body.config.backup, true)
})
