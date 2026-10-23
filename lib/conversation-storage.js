import { lstat, readdir, readFile, writeFile, mkdir, rename, rm, utimes, link } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { decodePackage, encodePackage, fileRecord, fileContent } from './conversation-package.js'

export const COMPRESSED_FILE = '.dsh-conversation.gz'
export const SUMMARY_FILE = '.dsh-conversation.json'

export async function compressedSummary(dir) {
  let entry
  try {
    entry = await lstat(join(dir, COMPRESSED_FILE))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('压缩会话路径不是普通文件')
  if ((await lstat(join(dir, SUMMARY_FILE))).isSymbolicLink()) throw new Error('压缩清单不能是符号链接')
  const summary = JSON.parse(await readFile(join(dir, SUMMARY_FILE), 'utf8'))
  return { ...summary, compressed: true }
}

export function createConversationStorage({ home, assertPath, locate, footprint, readTitle }) {
  async function snapshot(id, workspace) {
    const located = await locate(home, id)
    if (!located) throw Object.assign(new Error('对话不存在'), { status: 404 })
    await assertPath(home, join(located.dir, COMPRESSED_FILE))
    const saved = await compressedSummary(located.dir)
    if (saved) {
      const sessions = await decodePackage(await readFile(join(located.dir, COMPRESSED_FILE)))
      if (sessions.length !== 1 || sessions[0].id !== id) throw new Error('压缩对话 ID 不匹配')
      return sessions[0]
    }
    const before = await footprint(home, located.dir)
    if (before.bytes > 128 * 1024 * 1024) throw Object.assign(new Error('单条对话超过 128 MiB，请先减少附件'), { status: 413 })
    const files = []
    const pending = [located.dir]
    while (pending.length) {
      const dir = pending.pop()
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.dsh-') || entry.name.includes('.tmp-') || entry.name.endsWith('.lock')) continue
        const path = join(dir, entry.name)
        await assertPath(home, path)
        if (entry.isDirectory()) { pending.push(path); continue }
        const details = await lstat(path)
        if (!details.isFile() || details.isSymbolicLink()) throw new Error('对话包含不支持的文件')
        files.push(fileRecord(relative(located.dir, path).replaceAll('\\', '/'), await readFile(path), details.mtimeMs))
      }
    }
    if ((await footprint(home, located.dir)).revision !== before.revision) {
      throw Object.assign(new Error('对话在读取期间发生变化，请重试'), { status: 409 })
    }
    return { id, workspace: workspace || located.slug, title: await readTitle(located.dir) || id,
      files, mtime: before.mtime, sourceRevision: before.revision }
  }

  async function writeFiles(dir, session) {
    const files = [...session.files].sort((a, b) =>
      Number(/^session(?:\.v\d+)?\.jsonl/.test(a.path)) - Number(/^session(?:\.v\d+)?\.jsonl/.test(b.path)))
    for (const file of files) {
      const path = join(dir, ...file.path.split('/'))
      await assertPath(home, path)
      await mkdir(dirname(path), { recursive: true })
      try {
        const existing = await readFile(path)
        if (!existing.equals(fileContent(file))) throw Object.assign(new Error(`恢复路径已有不同内容：${file.path}`), { status: 409 })
        continue
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      const temporary = `${path}.tmp-${randomUUID()}`
      try {
        await writeFile(temporary, fileContent(file), { flag: 'wx' })
        await utimes(temporary, new Date(file.mtime), new Date(file.mtime))
        await link(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
    }
  }

  async function restore(id) {
    const located = await locate(home, id)
    if (!located) return false
    const archive = join(located.dir, COMPRESSED_FILE)
    await assertPath(home, archive)
    if (!await compressedSummary(located.dir)) return false
    const sessions = await decodePackage(await readFile(archive))
    if (sessions.length !== 1 || sessions[0].id !== id) throw new Error('压缩对话 ID 不匹配')
    await writeFiles(located.dir, sessions[0])
    // Keep the archive authoritative until every original file has landed.
    await rm(archive)
    await rm(join(located.dir, SUMMARY_FILE), { force: true })
    await writeFile(join(located.dir, '.dsh-last-access'), String(Date.now()))
    return true
  }

  async function compact(id, workspace, logical, catalog) {
    const located = await locate(home, id)
    if (!located) throw Object.assign(new Error('对话不存在'), { status: 404 })
    if (await compressedSummary(located.dir)) return { ok: true, sessionId: id, alreadyCompressed: true }
    const session = { ...await snapshot(id, workspace), logical }
    const before = await footprint(home, located.dir)
    if (before.revision !== session.sourceRevision) {
      throw Object.assign(new Error('会话在快照后发生变化，请重试'), { status: 409 })
    }
    const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
    await assertPath(home, cacheDir)
    let cacheNames = []
    try { cacheNames = (await readdir(cacheDir)).filter((name) => name === `${id}.json` || name.startsWith(`${id}.json.bak-`)) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    let cacheBytes = 0
    for (const name of cacheNames) {
      const path = join(cacheDir, name)
      await assertPath(home, path)
      const details = await lstat(path)
      if (!details.isFile()) throw new Error('投影缓存不是普通文件')
      cacheBytes += details.size
    }
    const archive = await encodePackage([session])
    // Logs already use zstd. Avoid spending more space on incompressible data.
    const summary = { title: session.title, originalBytes: before.bytes + cacheBytes, mtime: session.mtime, catalog }
    const removableBytes = session.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content, 'base64'), cacheBytes)
    if (archive.length + Buffer.byteLength(JSON.stringify(summary)) >= removableBytes) {
      return { ok: true, sessionId: id, skipped: 'noSpaceSaved' }
    }
    const temporary = join(located.dir, `${COMPRESSED_FILE}.tmp-${randomUUID()}`)
    if ((await footprint(home, located.dir)).revision !== before.revision) {
      throw Object.assign(new Error('会话在压缩期间发生变化，请重试'), { status: 409 })
    }
    try {
      await writeFile(temporary, archive, { flag: 'wx' })
      await writeFile(join(located.dir, SUMMARY_FILE), JSON.stringify(summary))
      await rename(temporary, join(located.dir, COMPRESSED_FILE))
    } finally { await rm(temporary, { force: true }) }
    for (const file of session.files) {
      const path = join(located.dir, ...file.path.split('/'))
      await assertPath(home, path)
      if (!(await readFile(path)).equals(fileContent(file))) {
        throw Object.assign(new Error('会话文件在压缩期间发生变化，已保留压缩包和更改后的文件'), { status: 409 })
      }
      await rm(path)
    }
    for (const name of cacheNames) {
      const path = join(cacheDir, name)
      await assertPath(home, path)
      await rm(path, { force: true })
    }
    return { ok: true, sessionId: id, savedBytes: before.bytes + cacheBytes - (await footprint(home, located.dir)).bytes }
  }

  return { snapshot, restore, compact, writeFiles }
}
