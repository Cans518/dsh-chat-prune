/**
 * dsh-delete-chat — host half.
 *
 * 职责：把「删掉某个会话」这件事做实，并且做成可回滚的。
 *
 * 数据面（2026-10 的 DSH NEXT 布局，已在机器上核实）：
 *   $DSH_HOME/sessions/<workspaceSlug>/<sessionId>/session.v4.jsonl.zstd   会话日志（zstd 压缩的 jsonl）
 *   $DSH_HOME/sessions/<workspaceSlug>/<sessionId>/                         该会话的整个目录
 *   $DSH_HOME/storages/session_projcache/sessions/<sessionId>.json          投影缓存
 *   $DSH_HOME/storages/session_projcache/sessions/<sessionId>.json.bak-*    投影缓存备份（一并清）
 *   $DSH_HOME/storages/workspace.json                                      工作区索引（sessionIds / archivedSessionIds / pinnedSessionIds）
 *
 * 删除顺序（顺序重要 —— 文件先落地、索引最后落，任何一步失败都能靠索引重建）：
 *   1. 解析 sessionId → 找到所属 workspace 目录 + 会话目录（扫盘，不信任索引）
 *   2. 备份：整目录 copy 到 $DSH_HOME/deleted-sessions/<ISO时间戳>/<sessionId>/
 *   3. 删会话目录
 *   4. 删 projcache 的 <sessionId>.json 及其 .bak-*
 *   5. 从 workspace.json 的 sessionIds / archivedSessionIds / pinnedSessionIds 摘掉该 id（原子替换 + 备份）
 *
 * 幂等：sessionId 已不存在时返回 { ok:true, alreadyGone:true }，不报错。
 *
 * 运行中会话：默认拒绝（allowRunning=false）。原因是宿主对该会话持有 append 句柄，
 * 硬删会让 UI 和持久化层指向一个不存在的文件。要用 allowRunning 自己承担。
 */

import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { randomUUID } from 'node:crypto'
import * as zlib from 'node:zlib'
import z from '@deepseek-ai/schemastery'

/** 本文件所在目录（lib/）。client.js 在它上一级。 */
const here = dirname(fileURLToPath(import.meta.url))
const pluginVersion = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version

export const name = 'dsh-delete-chat'

/**
 * 依赖的宿主服务。
 * - webServer：注册 /dsh-delete-chat/* 路由，并借它的 index injection 表注入 client.js
 * - workspaceRegistry / sessions：等待索引及会话服务就绪，保护仍附着的会话。
 * - sessionPersistence：持有公开 write handle，和宿主 resume 互斥。
 * （事件订阅 `webserver/index-inject` 通过 ctx.on，不需要列在 inject 里 ——
 *  inject 列的是服务名，不是事件名）
 */
export const inject = ['webServer', 'workspaceRegistry', 'sessions', 'sessionPersistence']

/** 路由前缀。改这里必须同步改 client-core.js 里的 API_BASE。 */
const ROUTE_PREFIX = '/dsh-delete-chat'

const DEFAULTS = {
  // 默认不备份：备份是整目录 copy，大会话白占一份等量磁盘。
  // 要留退路就在 cordis.patch.yml 里把 backup 打开。
  backup: false,
  allowRunning: false,
  icon: 'trash',
}

/**
 * 本行的 config schema。
 *
 * 必须是 schemastery 的 schema 对象，**不能**写成 `(z) => z.object({...})` 这种工厂。
 * cordis 的 resolveConfig 走 Standard Schema 接口：
 *
 *     if (!runtime.Config) return config
 *     const result = runtime.Config['~standard'].validate(config)
 *
 * 传一个没有 `~standard` 的普通函数进去，就等于 `undefined.validate(...)`，
 * 报「Cannot read properties of undefined (reading 'validate')」，整个插件挂不上。
 *
 * schemastery 必须用 DSH 自带的那份（@deepseek-ai/schemastery），不能用公共
 * `schemastery` 包：只有 DSH 的构建会在解析 config 时把 `meta.volatile` 字段包成
 * cosmokit 的 Volatile 引用，Loader 的 volatile-commit 路径要顺着这些引用走。
 * 用错了包，写入会「成功」但值永远不生效。
 */
export const Config = z.object({
  backup: z.boolean().default(DEFAULTS.backup),
  allowRunning: z.boolean().default(DEFAULTS.allowRunning),
  icon: z.string().default(DEFAULTS.icon),
})

// ---------------------------------------------------------------- 基础工具

/** DSH home：优先 profileContext，其次 $DSH_HOME，最后 ~/.dsh。 */
function dshHome(ctx) {
  const fromCtx = ctx?.profileContext?.home
  if (typeof fromCtx === 'string' && fromCtx.length > 0) return fromCtx
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** 会话 id 白名单式校验：绝不让外部字符串参与路径拼接。 */
function assertSessionId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
    throw new HttpError(400, 'bad sessionId')
  }
  // 只接受 DSH 真实使用的形态：session-<uuid 或等价片段>
  if (!/^session-[A-Za-z0-9-]+$/.test(id)) {
    throw new HttpError(400, 'bad sessionId: expect session-<id>')
  }
  if (id.includes('..') || id.includes('/') || id.includes('\\')) {
    throw new HttpError(400, 'sessionId contains illegal characters')
  }
  return id
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/** Reject links/junctions at every path component before touching managed data. */
async function assertManagedPath(home, target) {
  const root = resolve(home)
  const rel = relative(root, resolve(target))
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(target) === root) {
    throw new HttpError(400, '目标路径超出 DSH 数据目录')
  }
  let current = root
  for (const part of rel.split(sep)) {
    current = join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new HttpError(409, '目标路径包含符号链接或目录联接，已拒绝删除')
      }
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
  }
}

/** 时间戳目录名：20261016-153210-123，Windows 文件名安全。 */
function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `-${p(d.getMilliseconds(), 3)}`
  )
}

/** ISO 变体，换掉 Windows 非法字符，用于备份目录标签。 */
function isoTag(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-')
}

async function readJson(path) {
  const text = await readFile(path, 'utf8')
  return JSON.parse(text)
}

/** 原子写：先写 .tmp，再 rename 覆盖。before 提供时留一份 .bak-<stamp>。 */
async function writeJsonAtomic(path, value, { backup = false } = {}) {
  const body = JSON.stringify(value, null, 2)
  await mkdir(dirname(path), { recursive: true })
  if (backup && (await exists(path))) {
    await cp(path, `${path}.bak-${stamp()}`, { force: true })
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, path)
}

// ------------------------------------------------------------ 会话定位

/**
 * 在 $DSH_HOME/sessions/<slug>/<sessionId>/ 下定位一个会话目录。
 * 扫盘而不是查索引：索引可能和磁盘不同步（手工删过、或者旧版本布局）。
 */
async function locateSession(home, sessionId) {
  assertSessionId(sessionId)
  const root = join(home, 'sessions')
  await assertManagedPath(home, root)
  if (!(await exists(root))) return null
  const slugs = await readdir(root, { withFileTypes: true })
  let located = null
  for (const entry of slugs) {
    if (entry.isSymbolicLink()) {
      // Even a linked workspace may contain the requested ID; do not guess.
      throw new HttpError(409, '会话工作区包含符号链接或目录联接，请先修复数据目录')
    }
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, sessionId)
    await assertManagedPath(home, candidate)
    if (await exists(candidate)) {
      if (located) throw new HttpError(409, '多个工作区包含相同 sessionId，已拒绝删除')
      if (!(await stat(candidate)).isDirectory()) throw new HttpError(409, '会话路径不是目录')
      located = { slug: entry.name, slugRoot: join(root, entry.name), dir: candidate }
    }
  }
  return located
}

/** 会话目录里的会话文件清单（不含 .tmp 残留）。 */
async function sessionFiles(dir) {
  try {
    const files = await readdir(dir)
    return files.filter((f) => !f.includes('.tmp-'))
  } catch {
    return []
  }
}

// ------------------------------------------------------------ 运行状态

/**
 * 判断会话是否还活着。
 *
 * 早期插件 `inject` 只声明了 webServer，导致 `ctx.sessions` 不存在。
 * 早期版本直接写 `ctx.sessions?.get?.()` 拿到的是 undefined，于是这个函数
 * 恒返回 false —— `allowRunning: false` 等于没写，运行中的会话照样被删，
 * 而宿主还握着它的 append 句柄。这是个静默的致命 bug。
 *
 * 修法：用 `ctx.get('sessions')` 主动取服务（cordis 的 get 不要求声明 inject），
 * 拿不到再退回 `ctx.sessions`。缺失服务时 canDetectRunning=false，默认禁止删除。
 * get() 表示加载/附着而非运行；附着的空闲会话也可能持有持久化句柄，必须保护。
 */
function sessionsService(ctx) {
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined
    if (viaGet) return viaGet
  } catch {
    /* 服务未注册 */
  }
  return ctx?.sessions
}

function isRunning(ctx, sessionId) {
  const sessions = sessionsService(ctx)
  if (!sessions) return false
  try {
    if (typeof sessions.get === 'function' && sessions.get(sessionId)) return true
  } catch {
    throw new HttpError(503, '宿主会话检测失败，已拒绝删除；请检查 sessions 服务后重试')
  }
  try {
    const list = sessions.list?.getSnapshot?.()
    const row = list?.byId?.[sessionId]
    if (row && row.running === true) return true
  } catch {
    throw new HttpError(503, '宿主会话快照读取失败，已拒绝删除')
  }
  return false
}

/** 运行检测是否真的可用（不可用时 allowRunning 的保护是空的）。 */
function canDetectRunning(ctx) {
  const service = sessionsService(ctx)
  return typeof service?.get === 'function' || typeof service?.list?.getSnapshot === 'function'
}

// ------------------------------------------------------------ 核心动作

// Serialize this plugin's read/modify/write operations per home, including retries.
const deletionQueues = new Map()

async function deleteSession(ctx, sessionId, config = {}) {
  assertSessionId(sessionId)
  const key = resolve(dshHome(ctx))
  const previous = deletionQueues.get(key) || Promise.resolve()
  const pending = previous.catch(() => {}).then(() => performDelete(ctx, sessionId, config))
  deletionQueues.set(key, pending)
  try {
    return await pending
  } finally {
    if (deletionQueues.get(key) === pending) deletionQueues.delete(key)
  }
}

function workspaceRegistry(ctx) {
  return (typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined) ??
    ctx?.workspaceRegistry
}

function persistenceService(ctx) {
  return (typeof ctx?.get === 'function' ? ctx.get('sessionPersistence') : undefined) ??
    ctx?.sessionPersistence
}

function requirePersistence(ctx) {
  const persistence = persistenceService(ctx)
  if (typeof persistence?.open !== 'function') {
    throw new HttpError(503, '宿主持久化服务不可用，已拒绝无写入所有权的在线删除')
  }
  return persistence
}

async function performDelete(ctx, sessionId, config) {
  const persistence = persistenceService(ctx)
  const located = await locateSession(dshHome(ctx), sessionId)
  // The host's resume path takes the same public write ownership. Holding it
  // closes the gap between an activity check and filesystem removal on Windows.
  if (!persistence || !located) {
    return performDeleteOwned(ctx, sessionId, config, located)
  }
  if (process.platform !== 'win32') {
    throw new HttpError(501, '当前插件的在线租约删除仅支持 Windows；POSIX 删除锁文件会破坏写入排他性')
  }
  if (config.allowRunning !== true && isRunning(ctx, sessionId)) {
    throw new HttpError(409, '该会话正在运行或仍被宿主加载，已拒绝删除')
  }
  let handle
  try {
    handle = await persistence.open(sessionId, 'write')
  } catch (error) {
    if (error.name === 'SessionAlreadyOwnedError' || error.constructor?.name === 'SessionAlreadyOwnedError') {
      throw new HttpError(409, '该会话仍有写入者，已拒绝删除；请释放该会话后重试')
    }
    throw new HttpError(503, `无法取得会话写入所有权：${error.message || error}`)
  }
  let result
  let deletionFailure
  try {
    result = await performDeleteOwned(ctx, sessionId, config, located)
    return result
  } catch (error) {
    deletionFailure = error
    throw error
  } finally {
    try {
      await handle.close()
    } catch (error) {
      if (deletionFailure) {
        const combined = new AggregateError([deletionFailure, error],
          `删除失败：${deletionFailure.message}；释放写入所有权也失败：${error.message}`)
        combined.deletion = deletionFailure.deletion
        throw combined
      }
      if (result) error.deletion = { sessionId, partial: true, removed: result.removed, backupDir: result.backupDir }
      throw error
    }
  }
}

async function performDeleteOwned(ctx, sessionId, config, located) {
  const home = dshHome(ctx)
  const projPath = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  const wsPath = join(home, 'storages', 'workspace.json')
  await assertManagedPath(home, projPath)
  await assertManagedPath(home, wsPath)
  const registry = workspaceRegistry(ctx)
  if (registry && (typeof registry.list !== 'function' ||
      typeof registry.unpinSession !== 'function' ||
      typeof registry.unarchiveSession !== 'function')) {
    throw new HttpError(503, '宿主工作区服务不兼容，已拒绝删除')
  }
  if (registry) {
    for (const entity of registry.list()) {
      if ((entity.sessionIds?.includes(sessionId) || entity.record?.sessionIds?.includes(sessionId)) &&
          typeof entity.detachSession !== 'function') {
        throw new HttpError(503, '宿主工作区缺少 detachSession，已拒绝删除')
      }
    }
  }
  // Validate the offline index before any irreversible operation.
  const offlineDoc = !registry && await exists(wsPath) ? await readJson(wsPath) : null
  const projDir = dirname(projPath)
  const cacheNames = await exists(projDir) ? (await readdir(projDir)).filter(
    (f) => f === `${sessionId}.json` || f.startsWith(`${sessionId}.json.bak-`),
  ) : []
  for (const file of cacheNames) {
    const path = join(projDir, file)
    await assertManagedPath(home, path)
    if (!(await lstat(path)).isFile()) throw new HttpError(409, '投影缓存路径不是普通文件，已拒绝删除')
  }

  if (located && !canDetectRunning(ctx) && config.allowRunning !== true) {
    throw new HttpError(503, '无法检测会话是否仍被宿主使用，已拒绝删除；请恢复 sessions 服务后重试')
  }
  if (isRunning(ctx, sessionId) && config.allowRunning !== true) {
    throw new HttpError(
      409,
      '该会话正在运行或仍被宿主加载，已拒绝删除。请先关闭该会话后重试',
    )
  }

  const result = {
    ok: true,
    sessionId,
    alreadyGone: !located && cacheNames.length === 0,
    // 两条返回路径都带 message：形状一致比「少写一个字段」重要，
    // 调用方拿到的 schema 不该随分支变化。
    message: null,
    backupDir: null,
    removed: [],
    indexPatched: false,
    detached: false,
  }

  // 1) 备份（先备份，后删除 —— 失败就整个中止，不留半成品）
  if (config.backup === true && located) {
    const backupDir = join(home, 'deleted-sessions', `${isoTag()}-${randomUUID()}`, sessionId)
    await assertManagedPath(home, backupDir)
    await mkdir(dirname(backupDir), { recursive: true })
    await cp(located.dir, backupDir, { recursive: true, force: true })
    await writeFile(
      join(dirname(backupDir), 'restore.json'),
      JSON.stringify(
        {
          sessionId,
          deletedAt: new Date().toISOString(),
          originalPath: located.dir,
          workspaceSlug: located.slug,
          files: await sessionFiles(located.dir),
          restoreHint:
            '把本目录整体移回 originalPath 即可恢复；workspace.json 的 sessionIds 需要手工补回该 id',
        },
        null,
        2,
      ),
      'utf8',
    )
    result.backupDir = backupDir
  }

  let removalAttempted = false
  try {
    // A long backup yields to the host; recheck activity before removing data.
    if (located) {
      await assertManagedPath(home, located.dir)
      if (config.allowRunning !== true && (!canDetectRunning(ctx) || isRunning(ctx, sessionId))) {
        throw new HttpError(409, '备份期间会话状态发生变化，已中止删除；请释放会话后重试')
      }
      removalAttempted = true
      await rm(located.dir, { recursive: true, force: true })
      result.removed.push(located.dir)
    } else if (await locateSession(home, sessionId)) {
      throw new HttpError(409, '检查期间出现了新的会话目录，已中止清理；请刷新后重试')
    }
    for (const f of cacheNames) {
      const target = join(projDir, f)
      await assertManagedPath(home, target)
      await rm(target, { force: true })
      result.removed.push(target)
    }
    // A live registry owns the storage domain and publishes list changes.
    if (registry) {
      result.detached = await detachFromRegistry(registry, sessionId)
      result.indexPatched = result.detached
    } else if (offlineDoc) {
      result.indexPatched = await patchOfflineIndex(wsPath, offlineDoc, sessionId)
    }
    if (result.alreadyGone) result.message = '会话记录已不存在，残留索引已检查清理'
  } catch (error) {
    error.deletion = {
      sessionId,
      partial: removalAttempted || result.removed.length > 0,
      removed: result.removed,
      backupDir: result.backupDir,
    }
    throw error
  }

  return result
}

async function patchOfflineIndex(path, doc, sessionId) {
  let touched = false
  const records = [doc?.global, ...Object.values(doc?.tables?.workspaces || {})]
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    for (const key of ['sessionIds', 'archivedSessionIds', 'pinnedSessionIds']) {
      if (!Array.isArray(record[key])) continue
      const next = record[key].filter((id) => id !== sessionId)
      if (next.length !== record[key].length) {
        record[key] = next
        touched = true
      }
    }
  }
  if (touched) await writeJsonAtomic(path, doc, { backup: true })
  return touched
}

/**
 * 把会话从 workspace registry 的内存表里摘掉。
 *
 * @returns {boolean} 是否真的摘掉了（宿主没有 registry 服务时返回 false，
 *   此时只能靠直接改 workspace.json —— 列表要等下次启动才干净）
 */
async function detachFromRegistry(registry, sessionId) {
  if (!registry || typeof registry.list !== 'function') return false
  let detached = false
  for (const entity of registry.list()) {
    // The filtered getter can omit stale IDs; the persistent record still owns them.
    const inView = Array.isArray(entity?.sessionIds) && entity.sessionIds.includes(sessionId)
    const inRecord = Array.isArray(entity?.record?.sessionIds) && entity.record.sessionIds.includes(sessionId)
    if (!inView && !inRecord) continue
    await entity.detachSession(sessionId)
    detached = true
  }
  const wasPinned = registry.pinnedSessionIds?.includes(sessionId)
  const wasArchived = registry.archivedSessionIds?.includes(sessionId)
  await registry.unpinSession(sessionId)
  await registry.unarchiveSession(sessionId)
  return detached || Boolean(wasPinned || wasArchived)
}

// ------------------------------------------------------------ HTTP 层

async function readBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 16 * 1024) throw new HttpError(413, 'request body exceeds 16 KiB')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  const raw = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString('utf8')
  if (raw.trim().length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'body is not valid JSON')
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

/**
 * 从会话日志里读出它的标题。
 *
 * 标题不是存在某个索引文件里的，而是会话日志内部的一条事件：
 *   {"type":"session/title","seq":17,"data":{"title":"..."}}
 *
 * 日志是 zstd 压缩的**多帧** jsonl（每帧独立一个 28 b5 2f fd 魔数），而
 * node:zlib 的 zstdDecompressSync / createZstdDecompress **只解第一帧就停**
 * （实测 1.6MB 的日志只吐出 197 字节），所以必须自己按帧走。
 *
 * 为什么不用「扫魔数」切帧：zstd 压缩数据里完全可能出现 28 b5 2f fd 这段字节，
 * 一旦误切，那个帧就解不开、内容静默丢失。这里按 zstd 帧头精确计算边界
 * （Frame_Header_Descriptor → window / dict / content size → block 链 → checksum），
 * 切出来的每一段都是真正的帧。
 *
 * 为什么要读标题：UI 的会话列表行（role=treeitem）只暴露标题文本、不暴露
 * sessionId，客户端要靠「标题 → sessionId」反查才知道该删哪一个。
 *
 * 有界快照扫描最新标题；超过上限不返回可能已经过时的旧标题。
 * 按 (路径, 大小, mtime) 缓存；列表通过事件刷新，不做后台轮询。
 */
const TITLE_HEAD_BYTES = 32 * 1024 * 1024
const TITLE_SCAN_FRAMES = 20000
const titleCache = new Map() // logPath -> { size, mtimeMs, title }

/** 一个 zstd 帧的结束偏移；结构非法返回 -1。 */
function zstdFrameEnd(buf, start) {
  if (start + 5 > buf.length) return -1
  if (!(buf[start] === 0x28 && buf[start + 1] === 0xb5 && buf[start + 2] === 0x2f && buf[start + 3] === 0xfd)) {
    return -1
  }
  const fhd = buf[start + 4]
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksumFlag = (fhd >> 2) & 1
  const didFlag = fhd & 3

  let p = start + 5
  if (!singleSegment) p += 1 // Window_Descriptor
  p += [0, 1, 2, 4][didFlag] // Dictionary_ID
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag] // Frame_Content_Size

  // block 链：3 字节小端头 → Last_Block / Block_Type / Block_Size
  for (;;) {
    if (p + 3 > buf.length) return -1
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const last = bh & 1
    const type = (bh >> 1) & 3
    const size = bh >>> 3
    if (type === 3) return -1 // reserved，非法帧
    p += type === 1 ? 1 : size // RLE 块的有效载荷固定 1 字节
    if (last) break
  }
  if (checksumFlag) p += 4
  return p <= buf.length ? p : -1
}

/** 从一段已解开的 jsonl 文本里取最后一条 session/title。 */
function lastTitleFromText(text) {
  let last = null
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('session/title') === -1) continue
    try {
      const ev = JSON.parse(line)
      if (ev && ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string') {
        last = ev.data.title
      }
    } catch {
      /* 被切片截断的半行，跳过 */
    }
  }
  return last
}

async function readSessionTitle(dir) {
  try {
    const files = await sessionFiles(dir)
    const logName = files.find((f) => f.startsWith('session.') && f.includes('jsonl'))
    if (!logName) return null
    const logPath = join(dir, logName)

    let st
    try {
      st = await stat(logPath)
    } catch {
      return null
    }

    const cached = titleCache.get(logPath)
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.title

    // 只读头部：标题就在日志最前面，没必要把整个文件读进内存
    let buf
    const fh = await open(logPath, 'r')
    try {
      const len = Math.min(st.size, TITLE_HEAD_BYTES)
      buf = Buffer.alloc(len)
      let { bytesRead } = await fh.read(buf, 0, len, 0)
      while (bytesRead < len) {
        const next = await fh.read(buf, bytesRead, len - bytesRead, bytesRead)
        if (!next.bytesRead) break
        bytesRead += next.bytesRead
      }
      buf = buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }

    let title = null
    let offset = 0
    let decoded = 0
    const decoder = new StringDecoder('utf8')
    let pending = ''
    for (let i = 0; i < TITLE_SCAN_FRAMES && offset < buf.length; i += 1) {
      const end = zstdFrameEnd(buf, offset)
      if (end < 0) break
      let text = ''
      try {
        if (typeof zlib.zstdDecompressSync !== 'function') break
        text = decoder.write(zlib.zstdDecompressSync(buf.subarray(offset, end), { maxOutputLength: 8 * 1024 * 1024 }))
      } catch {
        // 头部 512KB 可能正好把一个帧截断，解不开就停
        break
      }
      pending += text
      const newline = pending.lastIndexOf('\n')
      const found = newline < 0 ? null : lastTitleFromText(pending.slice(0, newline))
      if (newline >= 0) pending = pending.slice(newline + 1)
      if (found !== null) title = found
      decoded += text.length
      offset = end
      if (decoded > 64 * 1024 * 1024) break
    }
    if (offset < st.size) title = null
    else {
      const finalTitle = lastTitleFromText(pending + decoder.end())
      if (finalTitle !== null) title = finalTitle
    }
    if (titleCache.size >= 1000) titleCache.delete(titleCache.keys().next().value)
    titleCache.set(logPath, { size: st.size, mtimeMs: st.mtimeMs, title })
    return title
  } catch {
    return null
  }
}

/**
 * 列出可删除的会话（带标题、大小、mtime、是否运行），给界面兜底用。
 * 只读，不做任何修改。
 */
async function listSessions(ctx) {
  const home = dshHome(ctx)
  const root = join(home, 'sessions')
  await assertManagedPath(home, root)
  const out = []
  const slugs = await exists(root) ? await readdir(root, { withFileTypes: true }) : []
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    const slugRoot = join(root, slug.name)
    let ids = []
    try {
      ids = await readdir(slugRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const id of ids) {
      if (!id.isDirectory()) continue
      if (!id.name.startsWith('session-')) continue
      const dir = join(slugRoot, id.name)
      await assertManagedPath(home, dir)
      let bytes = 0
      let mtime = 0
      const files = await sessionFiles(dir)
      for (const f of files) {
        try {
          const st = await stat(join(dir, f))
          bytes += st.size
          mtime = Math.max(mtime, st.mtimeMs)
        } catch {
          /* 读不到就跳过 */
        }
      }
      out.push({
        id: id.name,
        workspace: slug.name,
        // 标题：客户端靠它把 UI 的行（只有标题、没有 id）对回 sessionId
        title: await readSessionTitle(dir),
        files: files.length,
        bytes,
        mtime,
        running: isRunning(ctx, id.name),
      })
    }
  }
  // Include index-only rows so a partial deletion can be retried through the UI.
  const known = new Set(out.map((row) => row.id))
  const registry = workspaceRegistry(ctx)
  const addMissing = (ids, workspace) => {
    for (const id of ids || []) {
      if (known.has(id) || typeof id !== 'string' || !/^session-[A-Za-z0-9-]+$/.test(id)) continue
      known.add(id)
      out.push({ id, workspace, title: null, files: 0, bytes: 0, mtime: 0,
        running: isRunning(ctx, id), missing: true })
    }
  }
  if (registry) {
    for (const entity of registry.list()) {
      addMissing(entity.record?.sessionIds || entity.sessionIds, entity.title || entity.id)
    }
    addMissing(registry.pinnedSessionIds, 'pinned')
    addMissing(registry.archivedSessionIds, 'archived')
  } else {
    const path = join(home, 'storages', 'workspace.json')
    await assertManagedPath(home, path)
    if (await exists(path)) {
      const doc = await readJson(path)
      for (const [key, record] of Object.entries(doc?.tables?.workspaces || {})) {
        addMissing(record.sessionIds, record.title || key)
      }
      addMissing(doc?.global?.pinnedSessionIds, 'pinned')
      addMissing(doc?.global?.archivedSessionIds, 'archived')
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const home = dshHome(ctx)
  /** 客户端诊断回传的落盘位置。 */
  const diagLog = join(home, 'logs', 'dsh-delete-chat-client.log')

  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const url = String(req.url || '')
      const method = String(req.method || 'GET').toUpperCase()
      const path = url.split('?')[0].replace(/\/+$/, '') || ROUTE_PREFIX

      try {
        /**
         * 客户端诊断回传。
         *
         * 页面里跑的是普通脚本，出问题时我在宿主侧看不到任何东西
         * （CDP 关着、browser access 也关着）。所以客户端把关键状态
         * POST 过来，宿主落到日志文件，我直接读盘就能定位。
         *
         * 只在安装时、以及前几次 hover 失败时上报，不是常驻心跳。
         */
        if (path === `${ROUTE_PREFIX}/diag` && method === 'POST') {
          try {
            const body = await readBody(req)
            const line = JSON.stringify({
              at: new Date().toISOString(),
              ...(body && typeof body === 'object' ? body : { raw: String(body) }),
            })
            await mkdir(dirname(diagLog), { recursive: true })
            await writeFile(diagLog, line + '\n', { encoding: 'utf8', flag: 'a' })
          } catch {
            /* 诊断失败绝不影响主流程 */
          }
          sendJson(res, 200, { ok: true })
          return
        }

        if (path === `${ROUTE_PREFIX}/ping` && method === 'GET') {
          sendJson(res, 200, {
            ok: true,
            name,
            version: pluginVersion,
            home,
            config: cfg,
            // 运行检测不可用时 allowRunning 的保护是空的，必须让调用方看见
            canDetectRunning: canDetectRunning(ctx),
            usesWriteOwnership: Boolean(ctx.sessionPersistence || ctx.get?.('sessionPersistence')),
          })
          return
        }

        /**
         * 把 client.js 原样吐给浏览器。
         *
         * 管理窗口和兼容悬浮层使用普通内联脚本。
         * 原生会话行按钮由独立 ./client 入口注册合法 React 组件，
         * 两者共享确认及删除流程，不把普通脚本当作 React 组件加载。
         */
        if (path === `${ROUTE_PREFIX}/client.js` && method === 'GET') {
          const file = join(here, '..', 'client.js')
          let body
          try {
            body = await readFile(file, 'utf8')
          } catch (error) {
            sendJson(res, 500, { ok: false, error: `client.js unreadable: ${String(error.message || error)}` })
            return
          }
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': String(Buffer.byteLength(body)),
          })
          res.end(body)
          return
        }

        if (path === `${ROUTE_PREFIX}/sessions` && method === 'GET') {
          sendJson(res, 200, { ok: true, apiVersion: 1, version: pluginVersion,
            config: cfg, canDetectRunning: canDetectRunning(ctx), sessions: await listSessions(ctx) })
          return
        }

        if (path === `${ROUTE_PREFIX}/sessions` && method === 'DELETE') {
          const body = await readBody(req)
          const sessionId = assertSessionId(body?.sessionId)
          requirePersistence(ctx)
          const result = await deleteSession(ctx, sessionId, cfg)
          sendJson(res, 200, result)
          return
        }

        // /sessions/<id> 形式也支持，方便 curl 手测
        if (path.startsWith(`${ROUTE_PREFIX}/sessions/`) && method === 'DELETE') {
          let decoded
          try {
            decoded = decodeURIComponent(path.slice(`${ROUTE_PREFIX}/sessions/`.length))
          } catch {
            throw new HttpError(400, 'bad sessionId encoding')
          }
          const sessionId = assertSessionId(decoded)
          requirePersistence(ctx)
          const result = await deleteSession(ctx, sessionId, cfg)
          sendJson(res, 200, result)
          return
        }

        sendJson(res, 404, { ok: false, error: `no route: ${method} ${path}` })
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        const message = String((error && error.message) || error)
        try {
          sendJson(res, status, { ok: false, error: message, ...error.deletion })
        } catch {
          try {
            res.destroy?.()
          } catch {
            /* ignore */
          }
        }
      }
    },
  })

  ctx.effect(() => dispose, 'dsh-delete-chat: routes')

  /**
   * 把 client.js 挂进页面。
   *
   * 走 webserver 的 index injection 表：宿主渲染页面 / 桌面壳启动时都会
   * 收集这张表（桌面壳走 IPC `injections` → 页面侧 `EM()` 逐行应用）。
   *
   * 用 `kind: 'script'`（内联文本），**不用 `script-src`**。这是踩出来的：
   *
   *   1) 页面 origin 是 `dsh-app://app/`。`script-src` 给绝对地址会绕开
   *      dsh-app 协议的认证转发（`forwardWebRequest` 要求带 nativeToken 和
   *      `x-dsh-desktop-renderer` 头），直连 http://host:port 必然 403。
   *      给相对路径虽然能转发，但端口/前缀一变就碎。
   *   2) 页面侧的 applier 对 `script-src` 是 **await 它的 onload**，失败就
   *      reject —— 也就是「插件脚本取不到」会直接让整个页面 boot 失败。
   *      一个可选插件不该有这种权力。
   *
   * 内联 `script` 不联网、不带认证、不可能失败，最坏情况只是不执行。
   */
  const clientScriptText = () => {
    try {
      // Read each document's injection afresh; a file update must not leave
      // the host serving the first script it ever cached.
      return readFileSync(join(here, '..', 'client.js'), 'utf8').replace(/<\/script/gi, '<\\/script')
    } catch {
      return ''
    }
  }

  const onInject = (table) => {
    // 宿主每次渲染都新建 table 并 emit，契约就是「把当前行推进去」
    if (!Array.isArray(table)) return
    const text = clientScriptText()
    // 读不到就不推：宁可没有按钮，也不往页面里塞一个空脚本
    if (!text) return
    table.push({ kind: 'script', placement: 'body', text })
  }

  /**
   * 订阅 index injection。
   *
   * 用 ctx.on 而不是把事件名塞进 inject —— inject 列的是**服务名**，
   * 事件订阅走 ctx.on。cordis 的 on 返回 disposer。
   *
   * ctx.on 缺失时只记一条告警：按钮注入没了（host 路由仍然可用，能手删），
   * 但不能因此把整个插件树的 boot 拖崩 —— 一个可选能力不该让插件加载失败。
   */
  if (typeof ctx.on !== 'function') {
    ctx.logger?.warn?.(
      'dsh-delete-chat: ctx.on 不可用，无法注入 client.js；删除功能仍可通过 HTTP 路由使用',
    )
    return
  }

  ctx.effect(() => {
    const off = ctx.on('webserver/index-inject', onInject)
    return () => {
      if (typeof off === 'function') off()
    }
  }, 'dsh-delete-chat: index injection')
}

export { apply, deleteSession, locateSession, listSessions, dshHome, canDetectRunning, isRunning, readSessionTitle, zstdFrameEnd }
export default { name, inject, Config, apply }
