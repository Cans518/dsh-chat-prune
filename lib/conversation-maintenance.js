import { readFile, mkdir, rename, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { decodePackage, encodePackage } from './conversation-package.js'

const originalObject = (value) => value?.[Symbol.for('cordis.original')] ?? value
const originalMethods = new WeakMap()

export function openForMaintenance(persistence, id) {
  const original = originalMethods.get(originalObject(persistence))?.open || persistence.open
  return Reflect.apply(original, persistence, [id, 'write'])
}

export function createConversationMaintenance({
  home, storage, persistence, registry, serialize, list, inspect, assertPath, checkIdle, releaseIdle, compressedRows,
}) {
  const service = originalObject(persistence)
  const originalOpen = service?.open
  const settingsPath = join(home, 'storages', 'dsh-chat-prune-compression.json')
  let disposed = false
  let lastRun = null
  let running = null

  async function settings() {
    await assertPath(home, settingsPath)
    try {
      const value = JSON.parse(await readFile(settingsPath, 'utf8'))
      validateDays(value.afterDays)
      return value
    } catch (error) {
      if (error.code === 'ENOENT') return { afterDays: 0 }
      throw error
    }
  }

  function validateDays(value) {
    if (!Number.isInteger(value) || value < 0 || value > 36500) {
      throw Object.assign(new Error('自动压缩天数须为 0–36500 的整数；0 表示关闭'), { status: 400 })
    }
  }

  async function saveSettings(value) {
    validateDays(value?.afterDays)
    return serialize(async () => {
      await assertPath(home, settingsPath)
      await mkdir(join(home, 'storages'), { recursive: true })
      const temporary = `${settingsPath}.tmp-${randomUUID()}`
      try {
        await writeFile(temporary, JSON.stringify({ afterDays: value.afterDays }))
        await rename(temporary, settingsPath)
      } finally { await rm(temporary, { force: true }) }
      return { ok: true, afterDays: value.afterDays }
    })
  }

  async function owned(id, operation) {
    checkIdle(id)
    await releaseIdle(id)
    checkIdle(id)
    if (typeof originalOpen !== 'function') {
      throw Object.assign(new Error('宿主持久化服务不可用'), { status: 503 })
    }
    // Bypass our read interceptor while already inside the home mutation queue.
    await storage.restore(id)
    let handle
    try { handle = await Reflect.apply(originalOpen, persistence, [id, 'write']) }
    catch (error) {
      if (error.name === 'SessionAlreadyOwnedError') {
        throw Object.assign(new Error('该对话仍有写入者，请释放后重试', { cause: error }), { status: 409 })
      }
      throw error
    }
    try {
      if (handle.header?.id !== id) throw Object.assign(new Error('对话 ID 大小写与存储记录不一致'), { status: 409 })
      return await operation(handle)
    }
    finally { await handle.close() }
  }

  async function action(id, action) {
    if (!/^session-[A-Za-z0-9-]{1,192}$/.test(id || '')) throw Object.assign(new Error('对话 ID 无效'), { status: 400 })
    return serialize(() => owned(id, async (handle) => {
      if (action === 'decompress') return { ok: true, sessionId: id }
      if (action !== 'compress') throw Object.assign(new Error('压缩操作无效'), { status: 400 })
      const row = await inspect(id)
      return compactOwned(id, row?.workspace, handle)
    }))
  }

  async function logicalSession(handle) {
    const { events } = await handle.read()
    return { header: handle.header, inheritedEventCount: handle.inheritedEventCount || 0, events }
  }

  async function compactOwned(id, workspace, handle) {
    const logical = await logicalSession(handle)
    const catalog = typeof service.stat === 'function' ? await Reflect.apply(
      originalMethods.get(service)?.stat || service.stat, persistence, [id]) : { header: handle.header, revision: 'compressed' }
    return storage.compact(id, workspace, logical, catalog)
  }

  async function exportSessions(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || new Set(ids).size !== ids.length) {
      throw Object.assign(new Error('请选择 1–1000 条不同的对话'), { status: 400 })
    }
    for (const id of ids) if (typeof id !== 'string' || !/^session-[A-Za-z0-9-]{1,192}$/.test(id)) {
      throw Object.assign(new Error('对话 ID 无效'), { status: 400 })
    }
    return serialize(async () => {
      const rows = await list()
      const sessions = []
      for (const id of ids) {
        const row = rows.find((row) => row.id === id)
        if (!row || row.missing) throw Object.assign(new Error(`对话不存在：${id}`), { status: 404 })
        const session = row.compressed ? await storage.snapshot(id, row.workspace)
          : await owned(id, async (handle) => ({
            ...await storage.snapshot(id, row.workspace), logical: await logicalSession(handle),
          }))
        sessions.push({ ...session, pinned: row.pinned, archived: row.archived })
      }
      return encodePackage(sessions)
    })
  }

  async function importSessions(archive) {
    const sessions = await decodePackage(archive)
    return serialize(async () => {
      const existing = new Set((await list()).map((row) => row.id.toLowerCase()))
      if (typeof service?.list === 'function') {
        for (const snapshot of await persistence.list()) existing.add(snapshot.header.id.toLowerCase())
      }
      for (const session of sessions) if (existing.has(session.id.toLowerCase())) {
        throw Object.assign(new Error(`对话 ID 已存在，未导入任何记录：${session.id}`), { status: 409 })
      }
      if (typeof registry?.create !== 'function' || typeof persistence?.create !== 'function' ||
          typeof persistence?.locate !== 'function') throw Object.assign(new Error('宿主无法创建导入工作区'), { status: 503 })
      for (const session of sessions) if (session.logical?.header?.id !== session.id ||
          !Array.isArray(session.logical?.events) || !Number.isSafeInteger(session.logical?.inheritedEventCount) ||
          session.logical.inheritedEventCount < 0) {
        throw Object.assign(new Error('对话包缺少可迁移的会话事件'), { status: 400 })
      }
      const imported = []
      // A dedicated local workspace makes old-machine paths portable.
      const workspacePath = join(home, 'imported-conversations')
      await assertPath(home, workspacePath)
      await mkdir(workspacePath, { recursive: true })
      const workspace = await registry.create(workspacePath, '导入的对话')
      for (const session of sessions) {
        try {
          const header = { ...session.logical.header, cwd: workspacePath }
          const location = persistence.locate(header)
          if (location?.kind !== 'jsonl') throw new Error('导入仅支持 JSONL 持久化后端')
          const dir = dirname(location.path)
          await assertPath(home, dir)
          const writer = await persistence.create(header, { inheritedEventCount: session.logical.inheritedEventCount })
          try {
            if (session.logical.events.length) await writer.append(session.logical.events)
            await writer.flush()
          } finally { await writer.close() }
          const reader = await Reflect.apply(originalOpen, persistence, [session.id, 'read'])
          try { await reader.read() }
          finally { await reader.close() }
          await storage.writeFiles(dir, { files: session.files.filter((file) =>
            !/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(file.path)) })
          await workspace.attachSession(session.id)
          if (session.archived) await registry.archiveSession(session.id)
          else if (session.pinned) await registry.pinSession(session.id)
          imported.push(session.id)
        } catch (cause) {
          throw Object.assign(new Error(`导入中断：${cause.message}`, { cause }), {
            transfer: { partial: true, imported, sessionId: session.id },
          })
        }
      }
      return { ok: true, imported, workspaceId: workspace.id }
    })
  }

  async function performAutomatic() {
    const { afterDays } = await settings()
    if (!afterDays || disposed) return { ok: true, compressed: 0, skipped: 0, errors: [] }
    const cutoff = Date.now() - afterDays * 86400000
    const candidates = (await list()).filter((row) =>
      !row.compressed && !row.running && !row.pinned && !row.missing && row.mtime > 0 && row.mtime < cutoff)
    const result = { ok: true, compressed: 0, skipped: 0, errors: [] }
    for (const row of candidates) {
      if (disposed) break
      try {
        const outcome = await serialize(async () => {
          const fresh = await inspect(row.id)
          if (!fresh || fresh.pinned || fresh.running || fresh.compressed || fresh.mtime >= cutoff) return { skipped: true }
          return owned(row.id, (handle) => compactOwned(row.id, row.workspace, handle))
        })
        if (outcome.skipped) result.skipped++
        else result.compressed++
      } catch (error) { result.errors.push({ sessionId: row.id, error: error.message }) }
    }
    lastRun = { ...result, at: Date.now() }
    return result
  }

  function runAutomatic() {
    return running ??= performAutomatic().finally(() => { running = null })
  }

  function install() {
    if (typeof originalOpen !== 'function') return () => {}
    const descriptors = new Map()
    const methods = Object.fromEntries(['open', 'list', 'stat'].map((name) => [name, service[name]]))
    originalMethods.set(service, methods)
    const wrappers = new Map()
    const wrapper = async function (id, ...args) {
      return serialize(async () => {
        await storage.restore(id)
        return Reflect.apply(originalOpen, this, [id, ...args])
      })
    }
    wrappers.set('open', wrapper)
    if (typeof methods.list === 'function') wrappers.set('list', async function (...args) {
      const snapshots = await Reflect.apply(methods.list, this, args)
      const known = new Set(snapshots.map((snapshot) => snapshot.header.id))
      return [...snapshots, ...(await compressedRows()).filter((row) => !known.has(row.id)).map((row) => row.catalog)]
    })
    if (typeof methods.stat === 'function') wrappers.set('stat', async function (id, ...args) {
      return await Reflect.apply(methods.stat, this, [id, ...args]) ||
        (await compressedRows()).find((row) => row.id === id)?.catalog
    })
    for (const [name, wrapped] of wrappers) {
      descriptors.set(name, Object.getOwnPropertyDescriptor(service, name))
      service[name] = wrapped
    }
    return () => {
      disposed = true
      for (const [name, wrapped] of wrappers) {
        if (service[name] !== wrapped) continue
        if (descriptors.get(name)) Object.defineProperty(service, name, descriptors.get(name))
        else delete service[name]
      }
      originalMethods.delete(service)
    }
  }

  return { action, exportSessions, importSessions, settings, saveSettings, runAutomatic, install,
    status: () => lastRun }
}
