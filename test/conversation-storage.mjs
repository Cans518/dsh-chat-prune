import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { gzipSync } from 'node:zlib'
import { apply, listSessions } from '../lib/index.js'
import { decodePackage, encodePackage, fileRecord } from '../lib/conversation-package.js'

async function fixture(t, ids = ['session-one']) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-compression-'))
  const effects = []
  t.after(async () => {
    for (const dispose of effects.reverse()) dispose?.()
    await rm(home, { recursive: true, force: true })
  })
  const records = new Map()
  const locks = new Set()
  const active = new Set()
  const workspaces = []
  const registry = {
    pinnedSessionIds: [], archivedSessionIds: [],
    list: () => workspaces,
    async create(path, title) {
      const workspace = { id: `workspace-${workspaces.length}`, title, record: { sessionIds: [] },
        async attachSession(id) {
          assert.equal(records.get(id).header.cwd, path)
          this.record.sessionIds.push(id)
        },
        async detachSession(id) { this.record.sessionIds = this.record.sessionIds.filter((value) => value !== id) },
      }
      workspaces.push(workspace)
      return workspace
    },
    async pinSession(id) { this.pinnedSessionIds.push(id) },
    async archiveSession(id) { this.archivedSessionIds.push(id) },
    async unpinSession(id) { this.pinnedSessionIds = this.pinnedSessionIds.filter((value) => value !== id) },
    async unarchiveSession(id) { this.archivedSessionIds = this.archivedSessionIds.filter((value) => value !== id) },
  }
  const persistence = {
    locate: (header) => ({ kind: 'jsonl', path: join(home, 'sessions', 'project', header.id, 'session.v4.jsonl.zstd') }),
    async create(header, options) {
      assert.ok(!records.has(header.id))
      records.set(header.id, { header, events: [], inheritedEventCount: options?.inheritedEventCount || 0 })
      const path = this.locate(header).path
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(header))
      return Reflect.apply(nativeOpen, this, [header.id, 'write'])
    },
    async open(id, access) {
      if (access === 'write' && locks.has(id)) throw Object.assign(new Error('owned'), { name: 'SessionAlreadyOwnedError' })
      await stat(this.locate({ id }).path)
      if (access === 'write') locks.add(id)
      const record = records.get(id)
      return { header: record.header, inheritedEventCount: record.inheritedEventCount,
        async read() { return { events: record.events } },
        async append(events) { record.events.push(...events) },
        async flush() {},
        async close() { locks.delete(id) },
      }
    },
    async stat(id) {
      try {
        const details = await stat(this.locate({ id }).path)
        return { header: records.get(id).header, revision: String(details.mtimeMs), sizeBytes: details.size }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    },
    async list() {
      const entries = await Promise.all([...records.keys()].map((id) => this.stat(id)))
      return entries.filter(Boolean)
    },
  }
  const nativeOpen = persistence.open
  const workspacePath = join(home, 'workspace')
  await mkdir(workspacePath)
  const workspace = await registry.create(workspacePath, '原工作区')
  for (const id of ids) {
    const writer = await persistence.create({ version: 4, id, cwd: workspacePath, createdAt: 1 })
    await writer.append([{ type: 'session/title', seq: 0, data: { title: '完整对话' } }])
    await writer.close()
    await workspace.attachSession(id)
    const dir = dirname(persistence.locate({ id }).path)
    await mkdir(join(dir, 'attachments'))
    await writeFile(join(dir, 'attachments', 'notes.txt'), '完整附件\n'.repeat(30000))
    for (const path of [persistence.locate({ id }).path, join(dir, 'attachments', 'notes.txt')]) {
      await utimes(path, new Date(1), new Date(1))
    }
  }
  let route
  const ctx = { profileContext: { home }, workspaceRegistry: registry, sessionPersistence: persistence,
    sessions: { get: (id) => active.has(id) ? { id } : undefined },
    webServer: { register(value) { route = value; return () => {} } },
    effect(fn) { effects.push(fn()) }, on: () => () => {},
  }
  apply(ctx, {})
  async function request(path, payload, raw, method = 'POST') {
    let status, body
    await route.handler({ method, url: `/dsh-chat-prune/${path}`,
      async *[Symbol.asyncIterator]() { if (raw) yield raw; else if (payload) yield Buffer.from(JSON.stringify(payload)) },
    }, { writeHead(value) { status = value }, end(value) { body = JSON.parse(value) } })
    return { status, body }
  }
  return { home, request, ctx, persistence, registry, active, records, locks,
    restart() {
      for (const dispose of effects.splice(0).reverse()) dispose?.()
      apply(ctx, {})
    },
  }
}

test('manual compression saves space, remains in native list/stat, and restores bytes on concurrent native reads', async (t) => {
  const f = await fixture(t)
  const dir = dirname(f.persistence.locate({ id: 'session-one' }).path)
  const original = await readFile(join(dir, 'attachments', 'notes.txt'))
  const cacheDir = join(f.home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, 'session-one.json'), '{"derived":true}')
  await writeFile(join(cacheDir, 'session-one.json.bak-test'), '{"old":true}')
  const outcome = await f.request('sessions/action', { sessionId: 'session-one', action: 'compress' })
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body))
  assert.ok(outcome.body.savedBytes > 100000)
  await assert.rejects(readFile(join(cacheDir, 'session-one.json')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(cacheDir, 'session-one.json.bak-test')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(dir, 'attachments', 'notes.txt')), { code: 'ENOENT' })
  assert.equal((await listSessions(f.ctx))[0].compressed, true)
  assert.equal((await f.persistence.list())[0].header.id, 'session-one')
  assert.equal((await f.persistence.stat('session-one')).header.id, 'session-one')
  const handles = await Promise.all([f.persistence.open('session-one', 'read'), f.persistence.open('session-one', 'read')])
  for (const handle of handles) await handle.close()
  assert.deepEqual(await readFile(join(dir, 'attachments', 'notes.txt')), original)
  assert.equal((await listSessions(f.ctx))[0].compressed, undefined)
  assert.equal(f.locks.size, 0)
})

test('automatic age policy persists, skips pinned/active/recent records and respects a new read', async (t) => {
  const f = await fixture(t, ['session-one', 'session-pinned', 'session-active', 'session-new'])
  f.registry.pinnedSessionIds.push('session-pinned')
  f.active.add('session-active')
  await writeFile(join(dirname(f.persistence.locate({ id: 'session-new' }).path), 'new'), 'recent')
  assert.equal((await f.request('compression', { afterDays: -1 })).status, 400)
  assert.equal((await f.request('compression', { afterDays: 30 })).status, 200)
  assert.equal(JSON.parse(await readFile(join(f.home, 'storages', 'dsh-chat-prune-compression.json'))).afterDays, 30)
  const result = await f.request('compression/run')
  assert.equal(result.body.compressed, 1, JSON.stringify(result.body))
  const compressed = (await listSessions(f.ctx)).filter((row) => row.compressed).map((row) => row.id)
  assert.deepEqual(compressed, ['session-one'])
  await (await f.persistence.open('session-one', 'read')).close()
  assert.equal((await f.request('compression/run')).body.compressed, 0)
})

test('compressed batch export imports into a fresh environment with events, attachments and flags; conflicts do not overwrite', async (t) => {
  const source = await fixture(t, ['session-one', 'session-two'])
  source.registry.pinnedSessionIds.push('session-one')
  source.registry.archivedSessionIds.push('session-two')
  await source.request('sessions/action', { sessionId: 'session-one', action: 'compress' })
  const exported = await source.request('conversations/export', { sessionIds: ['session-one', 'session-two'] })
  assert.equal(exported.status, 200, JSON.stringify(exported.body))
  assert.equal((await listSessions(source.ctx)).find((row) => row.id === 'session-one').compressed, true)
  const archive = Buffer.from(exported.body.archive, 'base64')
  const sessions = await decodePackage(archive)
  assert.equal(sessions.length, 2)
  const target = await fixture(t, [])
  const imported = await target.request('conversations/import', null, archive)
  assert.equal(imported.status, 200, JSON.stringify(imported.body))
  assert.deepEqual(imported.body.imported, ['session-one', 'session-two'])
  for (const id of imported.body.imported) {
    assert.deepEqual(target.records.get(id).events, source.records.get(id).events)
    assert.equal(target.records.get(id).header.cwd, join(target.home, 'imported-conversations'))
    assert.equal(await readFile(join(dirname(target.persistence.locate({ id }).path), 'attachments', 'notes.txt'), 'utf8'), '完整附件\n'.repeat(30000))
  }
  assert.deepEqual(target.registry.pinnedSessionIds, ['session-one'])
  assert.deepEqual(target.registry.archivedSessionIds, ['session-two'])
  assert.equal((await target.request('conversations/import', null, archive)).status, 409)
  assert.equal(target.records.size, 2)
})

test('active ownership and corrupt or unsafe archives retain original data', async (t) => {
  const f = await fixture(t)
  f.locks.add('session-one')
  assert.equal((await f.request('sessions/action', { sessionId: 'session-one', action: 'compress' })).status, 409)
  assert.ok(await readFile(f.persistence.locate({ id: 'session-one' }).path))
  assert.equal((await f.request('conversations/import', null, Buffer.from('bad'))).status, 400)
  const file = fileRecord('notes', Buffer.from('hello'), 1)
  const session = { id: 'session-safe', title: 'title', workspace: 'work', files: [file] }
  const invalidSessions = [{ ...session, files: [{ ...file, content: Buffer.from('changed').toString('base64') }] }]
  await assert.rejects(encodePackage(invalidSessions), /校验/)
  const corrupt = gzipSync(JSON.stringify({ format: 'dsh-chat-prune', version: 1, sessions: invalidSessions }))
  await assert.rejects(decodePackage(corrupt), /校验/)
  for (const path of ['../escape', 'a\\escape', 'C:/escape', 'NUL', '.DSH-conversation.gz', 'a/SESSION.LOCK']) {
    const archive = gzipSync(JSON.stringify({ format: 'dsh-chat-prune', version: 1, sessions: [{ ...session, files: [{ ...file, path }] }] }))
    await assert.rejects(decodePackage(archive), { status: 400 })
  }
  for (const path of ['.DSH-user-data', 'SESSION.LOCK', 'nested/.DSH-attachment', 'COM¹.txt', 'CONOUT$']) {
    await assert.rejects(encodePackage([{ ...session, files: [{ ...file, path }] }]), { status: 400 })
  }
  await assert.rejects(encodePackage([session, { ...session, id: 'session-SAFE' }]), { status: 400 })
  const tooManyFiles = Array.from({ length: 20001 }, (_, index) => ({ ...file, path: `file-${index}` }))
  await assert.rejects(encodePackage([{ ...session, files: tooManyFiles }]), { status: 400 })
})

test('saved age policy runs on the host timer after a plugin restart', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = await fixture(t)
  await f.request('compression', { afterDays: 30 })
  f.restart()
  t.mock.timers.tick(60000)
  let rows
  for (let attempt = 0; attempt < 200; attempt++) {
    rows = await listSessions(f.ctx)
    if (rows[0].compressed) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(rows[0].compressed, true)
  assert.equal((await f.persistence.list())[0].header.id, 'session-one')
  await (await f.persistence.open('session-one', 'read')).close()
  assert.equal((await listSessions(f.ctx))[0].compressed, undefined)
})

test('interrupted restoration preserves the authoritative package and refuses conflicting files', async (t) => {
  const f = await fixture(t)
  const dir = dirname(f.persistence.locate({ id: 'session-one' }).path)
  await f.request('sessions/action', { sessionId: 'session-one', action: 'compress' })
  const path = join(dir, 'attachments', 'notes.txt')
  await writeFile(path, 'an external edit')
  await assert.rejects(f.persistence.open('session-one', 'read'), { status: 409 })
  assert.equal(await readFile(path, 'utf8'), 'an external edit')
  assert.ok(await readFile(join(dir, '.dsh-conversation.gz')))
  await rm(path)
  await (await f.persistence.open('session-one', 'read')).close()
  assert.equal(await readFile(path, 'utf8'), '完整附件\n'.repeat(30000))
})

test('incompressible small records are retained and compressed records can be deleted without queue deadlocks', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, ['session-one', 'session-small'])
  const smallDir = dirname(f.persistence.locate({ id: 'session-small' }).path)
  await rm(join(smallDir, 'attachments'), { recursive: true })
  await writeFile(join(smallDir, '.dsh-preserved'), 'metadata'.repeat(20000))
  const noSavings = await f.request('sessions/action', { sessionId: 'session-small', action: 'compress' })
  assert.equal(noSavings.body.skipped, 'noSpaceSaved')
  assert.ok(await readFile(join(smallDir, 'session.v4.jsonl.zstd')))
  assert.equal((await stat(join(smallDir, '.dsh-preserved'))).size, 160000)
  assert.equal((await listSessions(f.ctx)).find((row) => row.id === 'session-small').compressed, undefined)
  if (process.platform === 'win32') {
    await f.request('sessions/action', { sessionId: 'session-one', action: 'compress' })
    const row = (await listSessions(f.ctx)).find((row) => row.id === 'session-one')
    const deleted = await f.request('sessions', { sessionId: 'session-one',
      expectedMtime: row.mtime, expectedRevision: row.revision }, null, 'DELETE')
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
    assert.equal((await listSessions(f.ctx)).some((row) => row.id === 'session-one'), false)
  }
})
