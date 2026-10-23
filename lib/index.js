/**
 * dsh-chat-prune — host half.
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
import { createHash, randomUUID } from 'node:crypto'
import * as zlib from 'node:zlib'
import z from '@deepseek-ai/schemastery'
import { createSessionSources } from './session-sources.js'
import { trackAgentHandles, canReleaseAgent, releaseIdleAgent } from './agent-lifecycle.js'
import { createConversationStorage, compressedSummary } from './conversation-storage.js'
import { createConversationMaintenance, openForMaintenance } from './conversation-maintenance.js'
import { MAX_PACKAGE_BYTES } from './conversation-package.js'

/** 本文件所在目录（lib/）。client.js 在它上一级。 */
const here = dirname(fileURLToPath(import.meta.url))
const pluginVersion = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version

export const name = 'dsh-chat-prune'

/**
 * 依赖的宿主服务。
 * - webServer：注册 /dsh-chat-prune/* 路由，并借它的 index injection 表注入 client.js
 * - workspaceRegistry / sessions：等待索引及会话服务就绪，保护仍附着的会话。
 * - sessionPersistence：持有公开 write handle，和宿主 resume 互斥。
 * （事件订阅 `webserver/index-inject` 通过 ctx.on，不需要列在 inject 里 ——
 *  inject 列的是服务名，不是事件名）
 */
export const inject = ['webServer', 'workspaceRegistry', 'sessions', 'sessionPersistence']

/** 路由前缀。改这里必须同步改 client-core.js 里的 API_BASE。 */
const ROUTE_PREFIX = '/dsh-chat-prune'

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

async function sessionFootprint(home, dir) {
  let bytes = 0, mtime = 0, files = 0
  const manifest = []
  const pending = [dir]
  while (pending.length) {
    const current = pending.pop()
    await assertManagedPath(home, current)
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name.includes('.tmp-')) continue
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) throw new HttpError(409, '会话记录包含符号链接，请修复后刷新')
      if (entry.isDirectory()) { pending.push(path); continue }
      const details = await lstat(path)
      if (details.isSymbolicLink()) throw new HttpError(409, '会话记录包含符号链接，请修复后刷新')
      if (!details.isFile()) continue
      bytes += details.size
      mtime = Math.max(mtime, details.mtimeMs)
      files++
      manifest.push([relative(dir, path), details.size, details.mtimeMs, details.ctimeMs])
    }
  }
  manifest.sort((a, b) => a[0].localeCompare(b[0]))
  const revision = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
  return { bytes, mtime, files, revision }
}

// ------------------------------------------------------------ 运行状态

/**
 * 宿主里的 agent 登记表（`agents` 服务）。
 *
 * 判断「这个会话是不是正在跑」只有它可靠：
 *   agents.get(sessionId) -> agent
 *   agent.status === 'running'   // dsh-agent-loop: phase.kind 不是 idle/maintenance
 *
 * 用 `ctx.get` 主动取（cordis 的 get 不要求写进 inject）。
 */
function agentsService(ctx) {
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
    if (viaGet) return viaGet
  } catch {
    /* 服务未注册 */
  }
  return ctx?.agents
}

/** Agent activity is advisory; online deletion must also acquire write ownership. */
function isRunning(ctx, sessionId) {
  const agents = agentsService(ctx)
  if (!agents) return false
  try {
    const agent = typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    return agent?.status === 'running'
  } catch {
    // 登记表半销毁时不该把删除路由带崩；交给写入所有权兜底
    return false
  }
}

/** 运行检测是否可用（不可用时只能靠持久化写入所有权兜底）。 */
function canDetectRunning(ctx) {
  return typeof agentsService(ctx)?.get === 'function'
}

/** Loaded sessions can retain writers and in-memory projections even while idle. */
function isSessionInUse(ctx, sessionId) {
  try {
    const sessions = ctx?.sessions ?? ctx?.get?.('sessions')
    const loaded = Boolean(sessions?.get?.(sessionId))
    if (!loaded) return isRunning(ctx, sessionId)
    const agents = agentsService(ctx)
    // A retained read projection has no writer. Its stale catalog entry is
    // reconciled after deletion; actual ownership is still checked by open().
    if (typeof agents?.get === 'function' && !agents.get(sessionId)) return false
    return isRunning(ctx, sessionId) ||
      !canReleaseAgent(agents, sessionId)
  } catch {
    // An unavailable service is allowed; a failing registered service is unknown.
    return true
  }
}

function checkSessionUse(ctx, sessionId, config) {
  if ((config.protectPinned || config.allowRunning !== true) && isSessionInUse(ctx, sessionId)) {
    throw new HttpError(409, '该会话正在运行或仍被宿主加载，已拒绝删除；请释放该会话后重试')
  }
}

// ------------------------------------------------------------ 核心动作

// Serialize this plugin's read/modify/write operations per home, including retries.
const deletionQueues = new Map()

async function deleteSession(ctx, sessionId, config = {}) {
  assertSessionId(sessionId)
  return withHomeMutation(ctx, () => performDelete(ctx, sessionId, config))
}

async function withHomeMutation(ctx, operation) {
  const key = resolve(dshHome(ctx))
  const previous = deletionQueues.get(key) || Promise.resolve()
  const pending = previous.catch(() => {}).then(operation)
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
  await checkPruningGuards(ctx, sessionId, config, located)
  checkSessionUse(ctx, sessionId, config)
  if (canReleaseAgent(agentsService(ctx), sessionId)) {
    await releaseIdleAgent(agentsService(ctx), sessionId)
    if (isSessionInUse(ctx, sessionId)) throw new HttpError(409, '宿主尚未完全释放该会话，请刷新后重试')
  }
  // The host's resume path takes the same public write ownership. Holding it
  // closes the gap between an activity check and filesystem removal on Windows.
  if (!persistence || !located) {
    return performDeleteOwned(ctx, sessionId, config, located)
  }
  if (await conversationStorage(ctx).restore(sessionId)) {
    const restored = await sessionFootprint(dshHome(ctx), located.dir)
    config = { ...config,
      expectedMtime: config.expectedMtime === undefined ? undefined : restored.mtime,
      expectedRevision: config.expectedRevision === undefined ? undefined : restored.revision }
  }
  if (process.platform !== 'win32') {
    throw new HttpError(501, '当前插件的在线租约删除仅支持 Windows；POSIX 删除锁文件会破坏写入排他性')
  }
  checkSessionUse(ctx, sessionId, config)
  let handle
  try {
    handle = await openForMaintenance(persistence, sessionId)
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

  checkSessionUse(ctx, sessionId, config)

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
      checkSessionUse(ctx, sessionId, config)
      await checkPruningGuards(ctx, sessionId, config, located)
      if (config.protectPinned && workspaceRegistry(ctx)?.pinnedSessionIds?.includes(sessionId)) {
        throw new HttpError(409, '该会话已置顶，批量修剪已跳过')
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

async function readBytes(req, limit) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > limit) throw new HttpError(413, `request body exceeds ${limit} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))))
}

async function readBody(req, limit = 16 * 1024) {
  const raw = (await readBytes(req, limit)).toString('utf8')
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
      let footprint
      try {
        footprint = await sessionFootprint(home, dir)
      } catch (error) {
        // A rotating file or concurrent deletion invalidates this row's snapshot.
        if (error.code === 'ENOENT') continue
        throw error
      }
      out.push({
        id: id.name,
        workspace: slug.name,
        // 标题：客户端靠它把 UI 的行（只有标题、没有 id）对回 sessionId
        title: await readSessionTitle(dir),
        ...footprint,
        running: isSessionInUse(ctx, id.name),
      })
      const summary = await compressedSummary(dir)
      if (summary) {
        Object.assign(out[out.length - 1], summary, { mtime: summary.mtime, title: summary.title })
      }
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
        running: isSessionInUse(ctx, id), missing: true })
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
  const index = await sessionIndex(ctx)
  for (const row of out) {
    const workspace = index.workspaces.get(row.id)
    row.workspaceSlug = row.workspace
    row.workspaceKey = workspace?.id || `disk:${row.workspace}`
    row.workspace = workspace?.title || row.workspace
    row.pinned = index.pinned.has(row.id)
    row.archived = index.archived.has(row.id)
    row.releasable = canReleaseAgent(agentsService(ctx), row.id)
  }
  return out
}

async function sessionIndex(ctx) {
  const registry = workspaceRegistry(ctx)
  let workspaces, pinned, archived
  if (registry) {
    workspaces = registry.list().map((entity) => ({
      id: entity.id, title: entity.title || entity.id,
      sessionIds: entity.record?.sessionIds || entity.sessionIds || [],
    }))
    pinned = registry.pinnedSessionIds
    archived = registry.archivedSessionIds
  } else {
    const path = join(dshHome(ctx), 'storages', 'workspace.json')
    await assertManagedPath(dshHome(ctx), path)
    const doc = await exists(path) ? await readJson(path) : {}
    workspaces = Object.entries(doc.tables?.workspaces || {}).map(([id, record]) => ({ ...record, id }))
    pinned = doc.global?.pinnedSessionIds
    archived = doc.global?.archivedSessionIds
  }
  const membership = new Map()
  for (const workspace of workspaces) {
    for (const id of workspace.sessionIds || []) {
      membership.set(id, { id: workspace.id, title: workspace.title || workspace.id })
    }
  }
  return { workspaces: membership, pinned: new Set(pinned || []), archived: new Set(archived || []) }
}

async function checkPruningGuards(ctx, sessionId, config, located) {
  if ((config.expectedMtime !== undefined || config.expectedRevision !== undefined) && located) {
    let footprint
    try {
      footprint = await sessionFootprint(dshHome(ctx), located.dir)
    } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(409, '会话文件在预览后发生变化，请刷新并重新预览')
      throw error
    }
    const summary = await compressedSummary(located.dir)
    const mtime = summary?.mtime ?? footprint.mtime
    if ((config.expectedMtime !== undefined && mtime !== config.expectedMtime) ||
        (config.expectedRevision !== undefined && footprint.revision !== config.expectedRevision)) {
      throw new HttpError(409, '会话在预览后发生变化，请刷新并重新预览')
    }
  }
  if (config.protectPinned && (await sessionIndex(ctx)).pinned.has(sessionId)) {
    throw new HttpError(409, '该会话已置顶，批量修剪已跳过；取消置顶后再选择')
  }
}

const SESSION_ACTIONS = {
  archive: 'archiveSession', unarchive: 'unarchiveSession',
  pin: 'pinSession', unpin: 'unpinSession',
}

function conversationStorage(ctx) {
  return createConversationStorage({ home: dshHome(ctx), assertPath: assertManagedPath,
    locate: locateSession, footprint: sessionFootprint, readTitle: readSessionTitle })
}

async function inspectConversation(ctx, id) {
  const located = await locateSession(dshHome(ctx), id)
  if (!located) return null
  const footprint = await sessionFootprint(dshHome(ctx), located.dir)
  const summary = await compressedSummary(located.dir)
  const index = await sessionIndex(ctx)
  return { id, ...footprint, ...summary,
    workspace: index.workspaces.get(id)?.title || located.slug,
    pinned: index.pinned.has(id), running: isSessionInUse(ctx, id) }
}

async function manageSession(ctx, sessionId, action) {
  assertSessionId(sessionId)
  if (typeof action !== 'string' || !Object.hasOwn(SESSION_ACTIONS, action)) {
    throw new HttpError(400, '不支持的会话管理操作')
  }
  return withHomeMutation(ctx, async () => {
    const registry = workspaceRegistry(ctx)
    const method = SESSION_ACTIONS[action]
    if (typeof registry?.[method] !== 'function') throw new HttpError(503, '当前宿主不支持此管理操作')
    const index = await sessionIndex(ctx)
    if (!await locateSession(dshHome(ctx), sessionId) && !index.workspaces.has(sessionId) &&
        !index.pinned.has(sessionId) && !index.archived.has(sessionId)) {
      throw new HttpError(404, '会话已不存在，请刷新列表')
    }
    try {
      await registry[method](sessionId)
    } catch (error) {
      if (error.name === 'WorkspaceActiveSessionError') throw new HttpError(409, '会话有活动任务，归档已被宿主拒绝')
      if (error.name === 'WorkspaceArchivedSessionPinError') throw new HttpError(409, '请先取消归档，再置顶')
      if (error.name === 'WorkspaceUnknownSessionError') throw new HttpError(404, '宿主找不到该会话，请刷新列表')
      throw error
    }
    return { ok: true, sessionId, action }
  })
}

function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const home = dshHome(ctx)
  const sources = createSessionSources({ home, listLocal: listSessions })
  const maintenance = createConversationMaintenance({
    home, storage: conversationStorage(ctx), persistence: persistenceService(ctx), registry: workspaceRegistry(ctx),
    serialize: (operation) => withHomeMutation(ctx, operation), list: () => listSessions(ctx),
    inspect: (id) => inspectConversation(ctx, id),
    compressedRows: async () => (await listSessions(ctx)).filter((row) => row.compressed),
    assertPath: assertManagedPath,
    checkIdle: (id) => checkSessionUse(ctx, id, { allowRunning: false }),
    releaseIdle: (id) => releaseIdleAgent(agentsService(ctx), id),
  })
  ctx.effect(() => maintenance.install(), 'dsh-chat-prune: compressed conversation reads')
  ctx.effect(() => {
    const run = () => maintenance.runAutomatic().catch((error) =>
      ctx.logger?.warn?.(`自动压缩失败：${error.message}`))
    const timer = setInterval(run, 60 * 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'dsh-chat-prune: automatic compression')
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agents'], (agentCtx) => {
      agentCtx.effect(() => trackAgentHandles(agentsService(agentCtx)), 'dsh-chat-prune: agent handles')
    })
  } else {
    ctx.effect(() => trackAgentHandles(agentsService(ctx)), 'dsh-chat-prune: agent handles')
  }
  /** 客户端诊断回传的落盘位置。 */
  const diagLog = join(home, 'logs', 'dsh-chat-prune-client.log')

  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const url = String(req.url || '')
      const method = String(req.method || 'GET').toUpperCase()
      const path = url.split('?')[0].replace(/\/+$/, '') || ROUTE_PREFIX
      const localOnly = new URL(url, 'http://localhost').searchParams.get('local') === '1'

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
          const localRows = await listSessions(ctx)
          const merged = localOnly ? { sources: [], sessions: [] } : await sources.list()
          sendJson(res, 200, { ok: true, apiVersion: 1, managementVersion: 1, version: pluginVersion,
            config: cfg, canDetectRunning: canDetectRunning(ctx),
            compression: { ...await maintenance.settings(), lastRun: maintenance.status() },
            actions: [...Object.keys(SESSION_ACTIONS).filter((action) =>
              typeof workspaceRegistry(ctx)?.[SESSION_ACTIONS[action]] === 'function'),
            ...(persistenceService(ctx)?.open ? ['compress', 'decompress', 'export'] : [])],
            sources: [{ id: 'local', name: '当前数据目录', home, connected: true }, ...merged.sources],
            sessions: [...localRows.map((row) => ({ ...row, key: row.id, sourceId: 'local', sourceHome: home })), ...merged.sessions] })
          return
        }

        if (path === `${ROUTE_PREFIX}/compression` && method === 'POST') {
          sendJson(res, 200, await maintenance.saveSettings(await readBody(req)))
          return
        }
        if (path === `${ROUTE_PREFIX}/compression/run` && method === 'POST') {
          sendJson(res, 200, await maintenance.runAutomatic())
          return
        }
        if (path === `${ROUTE_PREFIX}/conversations/export` && method === 'POST') {
          const body = await readBody(req, 256 * 1024)
          if (body?.sourceId && body.sourceId !== 'local') {
            sendJson(res, 200, await sources.forward(body.sourceId, 'conversations/export', 'POST', body))
            return
          }
          const archive = await maintenance.exportSessions(body?.sessionIds)
          sendJson(res, 200, { ok: true, filename: 'dsh-conversations.dsh-chat.gz', archive: archive.toString('base64') })
          return
        }
        if (path === `${ROUTE_PREFIX}/conversations/import` && method === 'POST') {
          sendJson(res, 200, await maintenance.importSessions(await readBytes(req, MAX_PACKAGE_BYTES)))
          return
        }
        if (path === `${ROUTE_PREFIX}/sources` && method === 'POST') {
          sendJson(res, 200, { ok: true, source: await sources.add(await readBody(req)) })
          return
        }
        if (path === `${ROUTE_PREFIX}/sources` && method === 'DELETE') {
          await sources.remove((await readBody(req))?.sourceId)
          sendJson(res, 200, { ok: true })
          return
        }

        if (path === `${ROUTE_PREFIX}/sessions/action` && method === 'POST') {
          const body = await readBody(req)
          if (body?.sourceId && body.sourceId !== 'local') {
            sendJson(res, 200, await sources.forward(body.sourceId, 'sessions/action', 'POST', body))
            return
          }
          sendJson(res, 200, ['compress', 'decompress'].includes(body?.action)
            ? await maintenance.action(body?.sessionId, body.action)
            : await manageSession(ctx, body?.sessionId, body?.action))
          return
        }

        if (path === `${ROUTE_PREFIX}/sessions` && method === 'DELETE') {
          const body = await readBody(req)
          const sessionId = assertSessionId(body?.sessionId)
          if (body?.sourceId && body.sourceId !== 'local') {
            sendJson(res, 200, await sources.forward(body.sourceId, 'sessions', 'DELETE', body))
            return
          }
          requirePersistence(ctx)
          if (body?.expectedMtime !== undefined && (!Number.isFinite(body.expectedMtime) || body.expectedMtime < 0)) {
            throw new HttpError(400, 'bad expectedMtime')
          }
          if (body?.expectedRevision !== undefined && !/^[a-f0-9]{64}$/.test(body.expectedRevision)) {
            throw new HttpError(400, 'bad expectedRevision')
          }
          const result = await deleteSession(ctx, sessionId, {
            ...cfg, backup: cfg.backup || body?.backup === true,
            allowRunning: body?.protectPinned === true ? false : cfg.allowRunning,
            protectPinned: body?.protectPinned === true, expectedMtime: body?.expectedMtime,
            expectedRevision: body?.expectedRevision,
          })
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
        const status = error.status || 500
        const message = String((error && error.message) || error)
        try {
          sendJson(res, status, { ok: false, error: message, ...error.deletion, ...error.transfer,
            outcomeUnknown: error.outcomeUnknown === true })
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

  ctx.effect(() => dispose, 'dsh-chat-prune: routes')

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
      'dsh-chat-prune: ctx.on 不可用，无法注入 client.js；删除功能仍可通过 HTTP 路由使用',
    )
    return
  }

  ctx.effect(() => {
    const off = ctx.on('webserver/index-inject', onInject)
    return () => {
      if (typeof off === 'function') off()
    }
  }, 'dsh-chat-prune: index injection')
}

export { apply, deleteSession, manageSession, locateSession, listSessions, dshHome, canDetectRunning, isRunning, readSessionTitle, zstdFrameEnd }
export default { name, inject, Config, apply }
