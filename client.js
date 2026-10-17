/**
 * dsh-delete-chat — client 入口（构建产物，勿手改）。
 *
 * 由 scripts/build-client.mjs 从 client-core.js 生成。
 * 改逻辑请改 client-core.js，然后重跑：
 *     node scripts/build-client.mjs
 *
 * 加载方式：宿主渲染 index.html 时读 webserver 的 index injection 表，
 * 我们通过 host 半推一行 { kind: 'script', placement: 'body', text }，
 * 本文件以内联普通 <script> 被加载。
 *
 * 因此它不是 ESM（没有 import/export，也没走 __ModuleLoader__），
 * 而是一段直接执行的自包含脚本：定义完函数就地启动。
 * 此入口负责管理窗口与兼容层；原生 React 槽入口为 client-slot.js。
 */
(function () {
  "use strict";
  if (typeof document === "undefined") return;
  // 防重复注入（HMR / 路由重渲染可能多次插入同一 script）
  if (window.__dshDeleteChatInstalled__) return;
  window.__dshDeleteChatBuildVersion__ = "0.2.2";

// ---------- begin client-core.js ----------
/**
 * dsh-delete-chat — client half.
 *
 * 形态：鼠标移到会话列表某一行上时，在该行右端浮出一个垃圾桶按钮；
 * 点击 → 确认 → 调 host 的 DELETE /dsh-delete-chat/sessions → 列表自己消失。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么是「悬浮层」而不是「往行里插按钮」
 *
 * 上一版把 <button> appendChild 进 role=treeitem 的行节点，还改它的
 * style.position / paddingRight。那是 React 管理的 DOM —— React 用子节点索引
 * 做 reconciliation，凭空多出来的节点会打乱它的假设；再叠加一个
 * MutationObserver 把「我刚插入的东西」又当成本地变更触发下一轮扫描，
 * 宿主界面被持续搅动，最直接的症状就是**输入框打不进字**。
 *
 * 现在：只在 document.body 上挂一个 pointer-events:none 的固定层，
 * 里面一个按钮按被悬停行的 getBoundingClientRect 定位。
 * 不碰 React 的节点、不改它们的样式、不装 MutationObserver、不轮询。
 * 空闲时零成本。
 * ─────────────────────────────────────────────────────────────
 */

const name = 'dsh-delete-chat'

const NS = 'settings.dsh-delete-chat'

const API_BASE = '/dsh-delete-chat'

const LAYER_ID = 'dshdc-layer'
const BTN_CLASS = 'dshdc-del'

/** 会话 ID 格式示例：session-11111111-2222-4333-8444-555555555555 */
const SESSION_ID_RE = /session-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/

const zh = {
  'btn.title': '删除这个对话',
  'btn.aria': '删除对话',
  'confirm.title': '删除对话',
  'confirm.body': '将删除该会话的本地记录（{id}）。此操作不可撤销。',
  'confirm.bodyBackup': '将删除该会话的本地记录（{id}）。已开启备份，可从 deleted-sessions 目录恢复。',
  'state.deleting': '删除中…',
  'state.done': '已删除',
  'state.failed': '删除失败',
  'state.gone': '该对话已不存在',
  'state.running': '正在运行中，已拒绝删除',
  'state.hostOutdated': '宿主仍在运行旧版删除插件。请正常退出 DSH 后重新打开，再尝试删除。',
  'state.timeout': '请求超时，结果尚未确认。请刷新列表检查后再重试。',
  'state.refreshFailed': '删除已完成，但列表刷新失败。请点击刷新列表。',
  'state.partial': '删除可能已部分完成。请修复上述错误后重试以清理残留索引。',
  'manage.title': '管理对话',
  'manage.search': '搜索标题、工作区或会话 ID',
  'manage.refresh': '刷新列表',
  'manage.close': '关闭',
  'manage.empty': '没有匹配的对话',
  'manage.loading': '正在读取对话…',
  'manage.untitled': '无标题对话',
  'manage.running': '正在运行或已加载',
  'manage.cancel': '取消',
  'manage.delete': '确认删除',
  'manage.backup': '备份位置：',
  'manage.unknown': '无法检测运行状态，删除已禁用。请检查宿主服务后刷新。',
  'manage.missing': '本地记录已缺失，可清理残留索引',
  'manage.count': '{count} 个对话',
  'confirm.missing': '将从会话列表清理 {id} 的残留索引。本地记录已不存在。',
}

const en = {
  'btn.title': 'Delete this conversation',
  'btn.aria': 'Delete conversation',
  'confirm.title': 'Delete conversation',
  'confirm.body': 'This removes the local record of {id}. It cannot be undone.',
  'confirm.bodyBackup': 'This removes the local record of {id}. Backup is on; restore from deleted-sessions.',
  'state.deleting': 'Deleting…',
  'state.done': 'Deleted',
  'state.failed': 'Delete failed',
  'state.gone': 'This conversation is already gone',
  'state.running': 'Session is running; deletion refused',
  'state.hostOutdated': 'The host still runs the old deletion plugin. Quit DSH normally and reopen it before deleting.',
  'state.timeout': 'Request timed out; the result is unknown. Refresh the list before retrying.',
  'state.refreshFailed': 'Deletion completed, but refreshing failed. Refresh the list to check.',
  'state.partial': 'Deletion may have partly completed. Fix the error and retry to clean up remaining entries.',
  'manage.title': 'Manage conversations',
  'manage.search': 'Search title, workspace or session ID',
  'manage.refresh': 'Refresh list',
  'manage.close': 'Close',
  'manage.empty': 'No matching conversations',
  'manage.loading': 'Loading conversations…',
  'manage.untitled': 'Untitled conversation',
  'manage.running': 'Running or loaded',
  'manage.cancel': 'Cancel',
  'manage.delete': 'Delete conversation',
  'manage.backup': 'Backup location: ',
  'manage.unknown': 'Activity detection is unavailable. Restore the host service and refresh.',
  'manage.missing': 'Local record missing; remove stale list entries',
  'manage.count': '{count} conversations',
  'confirm.missing': 'Remove stale list entries for {id}. The local record is already missing.',
}

/** 会话列表行的候选选择器，按优先级。实测 treeitem 是真实形态。 */
const BUILTIN_ROW_SELECTORS = [
  '[data-row-key^="session:"]',
  '[data-session-id]',
  '[data-sessionlist-item], [data-session-list-item]',
  '[role="tree"] [role="treeitem"]',
  'a[href*="session-"][draggable="true"]',
  '[class*="session" i][class*="item" i]',
  '[class*="conversation" i][role="listitem"]',
]

const OVERRIDE_KEY = 'dshdc.rowSelectors'

function readSelectorOverrides() {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const clean = parsed.filter((s) => typeof s === 'string' && s.trim().length > 0)
    return clean.length > 0 ? clean : null
  } catch {
    return null
  }
}

function activeSelectors() {
  const override = readSelectorOverrides()
  return override
    ? { source: 'override', selectors: override }
    : { source: 'builtin', selectors: BUILTIN_ROW_SELECTORS }
}

// ---------------------------------------------------------------- i18n

function pickDict() {
  try {
    const lang = String(navigator.language || '')
    if (lang && !/^zh/i.test(lang)) return en
  } catch {
    /* 非浏览器环境 */
  }
  return zh
}

let dict = pickDict()
let currentT = (key) => dict[key] || zh[key] || key

// ---------------------------------------------------------------- 标题映射

/** 规范化标题：剥掉「进行中」前缀和尾部相对时间。 */
function normalizeTitle(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/^进行中\s*/, '')
    .replace(/\s*(\d+\s*(秒|分钟|小时|天|周|个月|月|年)|刚刚|片刻前)\s*$/, '')
    .trim()
}

let titleMap = { byTitle: new Map(), fetchedAt: 0, sessions: [], config: {} }
const TITLE_MAP_TTL_MS = 5000
let titleRequest = null

async function requestJson(url, init = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30000)
  try {
    const response = await fetch(url, {
      credentials: 'same-origin', cache: 'no-store', ...init, signal: ctrl.signal,
    })
    const data = await response.json()
    if (!response.ok || data?.ok !== true) {
      const error = new Error(data?.error || `${response.status} ${response.statusText || ''}`)
      error.status = response.status
      error.partial = data?.partial
      error.backupDir = data?.backupDir
      throw error
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

async function refreshTitleMap(force = false) {
  const now = Date.now()
  if (!force && titleMap.byTitle.size > 0 && now - titleMap.fetchedAt < TITLE_MAP_TTL_MS) {
    return titleMap
  }
  if (titleRequest) return titleRequest
  titleRequest = (async () => {
    const data = await requestJson(`${API_BASE}/sessions`)
    if (data.apiVersion !== 1) throw new Error(currentT('state.hostOutdated'))
    const rows = Array.isArray(data?.sessions) ? data.sessions : []
    const backupOn = data?.config ? data.config.backup === true : undefined
    if (backupOn !== undefined) window.__dshdcBackupOn = backupOn
    const byTitle = new Map()
    for (const row of rows) {
      if (!row?.id || !row.title) continue
      const key = normalizeTitle(row.title)
      // Duplicates remain explicitly ambiguous, including the third occurrence.
      byTitle.set(key, byTitle.has(key) ? null : row.id)
    }
    titleMap = { byTitle, fetchedAt: now, sessions: rows, config: data.config || {},
      canDetectRunning: data.canDetectRunning, hostVersion: data.version }
    return titleMap
  })()
  try {
    return await titleRequest
  } finally {
    titleRequest = null
  }
}

/** Only exact normalized, unique titles are safe identifiers. */
function sessionIdByTitle(title) {
  const norm = normalizeTitle(title)
  if (!norm) return null
  return titleMap.byTitle.get(norm) || null
}

// ---------------------------------------------------------------- 行识别

function rowTitleOf(el) {
  const aria = el.getAttribute?.('aria-label')
  if (aria && aria.trim()) return aria.trim()
  return (el.textContent || '').trim()
}

/** 从行元素上挖 sessionId；挖不到就用标题反查。 */
function sessionIdOf(el) {
  const rowKey = el.getAttribute?.('data-row-key')
  if (rowKey?.startsWith('session:')) {
    const id = rowKey.slice('session:'.length)
    return /^session-[A-Za-z0-9-]+$/.test(id) ? id : null
  }
  if (rowKey?.startsWith('workspace:')) return null
  const attrs = ['data-session-id', 'data-sessionid', 'data-id', 'data-key']
  for (const attr of attrs) {
    const v = el.getAttribute?.(attr)
    if (v && /^session-[A-Za-z0-9-]+$/.test(v)) return v
  }
  if (el.tagName === 'A') {
    const href = el.getAttribute?.('href') || ''
    const match = SESSION_ID_RE.exec(href)
    if (match) return match[0]
  }

  return sessionIdByTitle(rowTitleOf(el))
}

/** 从任意元素往上找「看起来是会话行」的那个。 */
function findRow(el) {
  if (!el || typeof el.closest !== 'function') return null
  if (el.closest('[inert], [aria-hidden="true"]')) return null
  const { selectors } = activeSelectors()
  for (const sel of selectors) {
    try {
      const hit = el.closest(sel)
      if (hit) return hit
    } catch {
      /* 选择器写坏，跳过 */
    }
  }
  return null
}

/**
 * 纯文本兜底识别：不依赖任何选择器。
 *
 * 从被悬停的元素往上走，把路径上「文本能对上某个已知标题」的祖先都收集起来，
 * 再按几何挑一个最像**行**的：
 *   - 太矮或太窄的（里面那层 span）跳过；
 *   - 太高的（整棵列表容器）跳过；
 *   - 剩下的取最宽的 —— 行的宽度通常铺满列表，而标题那层是短的。
 *
 * 只靠文本会选到最内层的 span（0×0 或一小段），按钮就会贴到字尾上；
 * 加上几何约束才稳。
 */
function findRowByTitle(el, maxDepth = 8) {
  let best = null
  let cur = el
  for (let depth = 0; cur && depth < maxDepth; depth += 1, cur = cur.parentElement) {
    const norm = normalizeTitle(rowTitleOf(cur))
    if (!norm || norm.length > 200) continue
    const id = sessionIdByTitle(norm)
    if (!id) continue

    let rect
    try {
      rect = cur.getBoundingClientRect()
    } catch {
      continue
    }
    if (rect.height < 14 || rect.width < 40) continue // 里面那层文字，不是行
    if (rect.height > 72) continue // 太高，是一整块列表容器

    if (!best || rect.width > best.width || (rect.width === best.width && rect.height < best.height)) {
      best = { row: cur, id, width: rect.width, height: rect.height }
    }
  }
  return best ? { row: best.row, id: best.id } : null
}

/**
 * 解析一次 hover：先按选择器找行，行上拿不到 id 就退回文本匹配。
 * @returns {{row: object, id: string} | null}
 */
function resolveRow(el) {
  if (el?.closest?.('[inert], [aria-hidden="true"]')) return null
  if (el?.closest?.('[data-row-key^="workspace:"]')) return null
  const bySelector = findRow(el)
  if (bySelector) {
    const id = sessionIdOf(bySelector)
    if (id) return { row: bySelector, id }
  }
  return findRowByTitle(el)
}

// ---------------------------------------------------------------- 悬浮层

function ensureLayer() {
  let layer = document.getElementById(LAYER_ID)
  if (layer) return layer
  layer = document.createElement('div')
  layer.id = LAYER_ID
  // 整层不吃事件，只有里面的按钮吃 —— 所以不会挡住宿主任何交互
  // A zero-area root cannot intercept the host even when a skin overrides
  // pointer-events. Only our fixed controls and native dialogs have hit areas.
  layer.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483000;'
  document.body.appendChild(layer)

  const style = document.createElement('style')
  style.id = 'dshdc-style'
  style.textContent = `
.${BTN_CLASS} {
  all: unset;
  position: absolute;
  box-sizing: border-box;
  display: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: var(--dsh-color-text-secondary, #8b8b8b);
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
  transition: background-color .12s ease, color .12s ease;
}
.${BTN_CLASS}[data-dshdc-visible="1"] { display: inline-flex; }
.${BTN_CLASS}:hover {
  background: var(--dsh-color-fill-hover, rgba(255,255,255,.10));
  color: var(--dsh-color-danger, #ff6b6b);
}
.${BTN_CLASS}:focus-visible {
  outline: 2px solid var(--dsh-color-accent, #4d9fff);
  outline-offset: 1px;
}
.${BTN_CLASS}[data-dshdc-state="deleting"] { opacity: .5; pointer-events: none; }
.${BTN_CLASS}[data-dshdc-state="done"] { color: var(--dsh-color-success, #4ec97a); }
.${BTN_CLASS}[data-dshdc-state="failed"] { color: var(--dsh-color-danger, #ff6b6b); }
.dshdc-native-del:hover { color:var(--dsh-color-danger, #ed5263) !important; background:#8882 !important; }
.dshdc-native-del:focus-visible { outline:2px solid #579aff; outline-offset:2px; }
.dshdc-native-del:disabled { opacity:.5; cursor:wait !important; }
#dshdc-manage { all:unset; position:fixed; right:16px; bottom:16px; pointer-events:auto;
  padding:10px 14px; border:1px solid #8886; border-radius:8px; cursor:pointer;
  background:var(--dsh-color-bg, Canvas); color:var(--dsh-color-text, CanvasText); font:14px system-ui; }
.dshdc-dialog { color-scheme:light dark; box-sizing:border-box; width:min(640px, calc(100vw - 32px));
  max-height:80vh; padding:24px; border:1px solid #8886; border-radius:12px;
  background:var(--dsh-color-bg, Canvas); color:var(--dsh-color-text, CanvasText);
  font:16px/1.5 system-ui; overflow:auto; pointer-events:auto; }
.dshdc-dialog::backdrop { background:#0008; }
.dshdc-dialog h2 { font-size:20px; margin:0 0 16px; }
.dshdc-dialog input { box-sizing:border-box; width:100%; min-height:44px; padding:8px; margin:12px 0; font:inherit; }
.dshdc-dialog button { min-height:44px; padding:8px 16px; border:1px solid #8886;
  border-radius:6px; cursor:pointer; font:inherit; }
.dshdc-dialog button:disabled { opacity:.55; cursor:wait; }
.dshdc-dialog button:focus-visible, #dshdc-manage:focus-visible { outline:2px solid #579aff; outline-offset:3px; }
.dshdc-actions { display:flex; justify-content:flex-end; gap:12px; flex-wrap:wrap; margin-top:20px; }
#dshdc-manager > .dshdc-actions { position:sticky; top:-24px; padding:12px 0;
  background:var(--dsh-color-bg, Canvas); z-index:1; margin-top:0; }
.dshdc-danger { background:#ac2430; color:white; }
.dshdc-record { display:flex; align-items:center; gap:16px; padding:16px 0; border-bottom:1px solid #8884; }
.dshdc-record-text { flex:1; min-width:0; overflow-wrap:anywhere; white-space:pre-wrap; }
#dshdc-notice { position:fixed; right:16px; bottom:72px; max-width:min(480px, calc(100vw - 32px));
  padding:12px 16px; border:1px solid #8886; border-radius:8px; background:Canvas; color:CanvasText;
  font:14px/1.5 system-ui; white-space:pre-wrap; overflow-wrap:anywhere; pointer-events:auto; }
@media (prefers-reduced-motion:reduce) { .${BTN_CLASS} { transition:none; } }
@media (pointer:coarse) { .${BTN_CLASS} { width:44px; height:44px; transform:translate(-22px,-11px); } }
`
  document.head.appendChild(style)
  return layer
}

const SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M6.5 1.75a.75.75 0 0 0-.712.513L5.35 3H3.25a.75.75 0 0 0 0 1.5h.44l.616 8.007A2.25 2.25 0 0 0 6.55 14.5h2.9a2.25 2.25 0 0 0 2.244-1.993L12.31 4.5h.44a.75.75 0 0 0 0-1.5h-2.1l-.438-1.237A.75.75 0 0 0 9.5 1.75h-3Zm-.997 2.75h.997a.75.75 0 0 0 .692-.463L7.42 3h1.16l.228.637A.75.75 0 0 0 9.5 4.5h.997l-.6 7.8a.75.75 0 0 1-.747.7h-2.9a.75.75 0 0 1-.747-.7l-.6-7.8Z"/>' +
  '<path fill="currentColor" d="M6.75 6.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-1 0V7a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-1 0V7a.5.5 0 0 1 .5-.5Z"/>' +
  '</svg>'

/** 创建（或复用）那唯一一个按钮。 */
function ensureButton(layer, onClick) {
  let btn = layer.querySelector(`.${BTN_CLASS}`)
  if (btn) return btn
  btn = document.createElement('button')
  btn.type = 'button'
  btn.className = BTN_CLASS
  btn.innerHTML = SVG
  btn.addEventListener('click', (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    const id = btn.dataset.dshdcFor
    if (id && !btn.disabled) onClick(id, btn)
  })
  layer.appendChild(btn)
  return btn
}

// ---------------------------------------------------------------- 删除

function notify(message) {
  let notice = document.getElementById('dshdc-manager-notice') || document.getElementById('dshdc-notice')
  if (!notice) {
    notice = document.createElement('div')
    notice.id = 'dshdc-notice'
    notice.setAttribute('role', 'status')
    notice.setAttribute('aria-live', 'polite')
    document.getElementById(LAYER_ID)?.appendChild(notice)
  }
  notice.textContent = message
}

function createDialog(title) {
  const dialog = document.createElement('dialog')
  dialog.className = 'dshdc-dialog'
  const heading = document.createElement('h2')
  heading.id = `dshdc-heading-${++dialogCount}`
  heading.textContent = title
  dialog.setAttribute('aria-labelledby', heading.id)
  dialog.appendChild(heading)
  document.getElementById(LAYER_ID).appendChild(dialog)
  return dialog
}

let dialogCount = 0
let confirmation = null
const pendingDeletes = new Set()

function confirmDeletion(sessionId, row) {
  const t = currentT
  const backupOn = titleMap.config?.backup === true
  const body = (row?.missing ? t('confirm.missing') : backupOn ? t('confirm.bodyBackup') : t('confirm.body')).replace('{id}', sessionId)
  const dialog = createDialog(t('confirm.title'))
  if (typeof dialog.showModal !== 'function') {
    dialog.remove()
    return Promise.resolve(window.confirm(`${t('confirm.title')}\n\n${row?.title || ''}\n${body}`))
  }
  const detail = document.createElement('p')
  detail.textContent = [row?.title || t('manage.untitled'), row?.workspace, body].filter(Boolean).join('\n')
  dialog.appendChild(detail)
  const actions = document.createElement('div')
  actions.className = 'dshdc-actions'
  const cancel = document.createElement('button')
  cancel.textContent = t('manage.cancel')
  cancel.autofocus = true
  const confirm = document.createElement('button')
  confirm.className = 'dshdc-danger'
  confirm.textContent = t('manage.delete')
  actions.appendChild(cancel)
  actions.appendChild(confirm)
  dialog.appendChild(actions)
  return new Promise((resolve) => {
    let settled = false
    const finish = (answer) => {
      if (settled) return
      settled = true
      confirmation = null
      dialog.close()
      dialog.remove()
      resolve(answer)
    }
    confirmation = () => finish(false)
    cancel.addEventListener('click', () => finish(false))
    confirm.addEventListener('click', () => finish(true))
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false) })
    dialog.addEventListener('close', () => finish(false))
    dialog.showModal()
    cancel.focus()
  })
}

async function refreshSessionLists(deletedId) {
  await window.__dshDeleteChatRefreshSessions__?.(deletedId)
  return refreshTitleMap(true)
}

async function askThenDelete(sessionId, btn) {
  const t = currentT
  if (pendingDeletes.size || confirmation) return false
  pendingDeletes.add(sessionId)
  btn.disabled = true
  try {
    // Revalidate the target and effective backup setting before confirmation.
    const map = await refreshTitleMap(true)
    const row = map.sessions?.find((item) => item.id === sessionId)
    if (map.canDetectRunning === false && !row?.missing && map.config?.allowRunning !== true) {
      throw new Error(t('manage.unknown'))
    }
    if (!await confirmDeletion(sessionId, row)) return false
    btn.dataset.dshdcState = 'deleting'
    btn.title = t('state.deleting')
    notify(t('state.deleting'))
    const data = await requestJson(`${API_BASE}/sessions`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    btn.dataset.dshdcState = 'done'
    btn.title = data && data.alreadyGone ? t('state.gone') : t('state.done')
    notify(`${btn.title}${data.backupDir ? `\n${t('manage.backup')}${data.backupDir}` : ''}`)
    try {
      await refreshSessionLists(sessionId)
    } catch {
      notify(t('state.refreshFailed'))
    }
    btn.dataset.dshdcVisible = '0'
    return true
  } catch (error) {
    const msg = String((error && error.message) || error)
    btn.dataset.dshdcState = 'failed'
    btn.title = error.name === 'AbortError' ? t('state.timeout') : `${t('state.failed')}: ${msg}`
    notify(`${btn.title}${error.partial ? `\n${t('state.partial')}` : ''}${error.backupDir ? `\n${t('manage.backup')}${error.backupDir}` : ''}`)
    return false
  } finally {
    pendingDeletes.delete(sessionId)
    btn.disabled = false
  }
}

function openManager() {
  const existing = document.getElementById('dshdc-manager')
  if (existing) { existing.focus?.(); return }
  const t = currentT
  const dialog = createDialog(t('manage.title'))
  dialog.id = 'dshdc-manager'
  const search = document.createElement('input')
  search.type = 'search'
  search.placeholder = t('manage.search')
  search.setAttribute('aria-label', t('manage.search'))
  const message = document.createElement('p')
  message.id = 'dshdc-manager-notice'
  message.setAttribute('role', 'status')
  const records = document.createElement('div')
  const actions = document.createElement('div')
  actions.className = 'dshdc-actions'
  const refresh = document.createElement('button')
  refresh.textContent = t('manage.refresh')
  const close = document.createElement('button')
  close.textContent = t('manage.close')
  actions.appendChild(refresh)
  actions.appendChild(close)
  for (const child of [actions, search, message, records]) dialog.appendChild(child)
  let rows = []
  let closed = false
  const render = () => {
    records.textContent = ''
    const query = search.value?.trim().toLocaleLowerCase() || ''
    const filtered = rows.filter((row) => `${row.title || t('manage.untitled')} ${row.workspace} ${row.id}`.toLocaleLowerCase().includes(query))
    message.textContent = filtered.length ? t('manage.count').replace('{count}', filtered.length) : t('manage.empty')
    for (const row of filtered) {
      const item = document.createElement('div')
      item.className = 'dshdc-record'
      const label = document.createElement('div')
      label.className = 'dshdc-record-text'
      label.textContent = `${row.title || t('manage.untitled')}\n${row.workspace}\n${row.id}${row.running ? `\n${t('manage.running')}` : ''}${row.missing ? `\n${t('manage.missing')}` : ''}`
      const button = document.createElement('button')
      button.className = 'dshdc-danger'
      button.textContent = t('btn.aria')
      button.disabled = (row.running || (titleMap.canDetectRunning === false && !row.missing)) && titleMap.config?.allowRunning !== true
      button.addEventListener('click', async () => {
        if (await askThenDelete(row.id, button)) {
          rows = rows.filter((entry) => entry.id !== row.id)
          if (!closed) {
            const feedback = message.textContent
            render()
            message.textContent = feedback
            search.focus?.()
          }
        }
      })
      item.appendChild(label)
      item.appendChild(button)
      records.appendChild(item)
    }
  }
  const load = async () => {
    refresh.disabled = true
    message.textContent = t('manage.loading')
    try {
      const map = await refreshSessionLists()
      if (closed) return
      rows = map.sessions || []
      render()
      if (map.canDetectRunning === false) message.textContent = t('manage.unknown')
    } catch (error) {
      if (!closed) message.textContent = `${t('state.failed')}: ${error.message}`
    } finally {
      refresh.disabled = false
    }
  }
  search.addEventListener('input', render)
  refresh.addEventListener('click', load)
  close.addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => { closed = true; dialog.remove() })
  if (typeof dialog.showModal === 'function') {
    dialog.showModal()
    search.focus()
    load()
  } else {
    dialog.remove()
    notify('This browser does not support dialog.')
  }
}

// ---------------------------------------------------------------- 诊断上报

/**
 * 把客户端状态发给宿主，宿主落到 $DSH_HOME/logs/dsh-delete-chat-client.log。
 *
 * 页面里跑的是普通脚本；宿主那边 CDP 关着、browser access 也关着，出问题时
 * 我在外面看不到页面里发生了什么。这条通道是唯一的现场来源。
 *
 * 安静地失败：诊断本身绝不能影响功能。
 */
function report(event, payload) {
  try {
    fetch(`${API_BASE}/diag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ event, ...payload }),
    }).catch(() => {})
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 启动

const inject = ['locale']

function apply(ctx) {
  if (typeof document === 'undefined' || !document.body) return

  if (ctx?.locale && typeof ctx.locale.register === 'function') {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-delete-chat: dictionaries')
    try {
      currentT = ctx.locale.bind(NS)
    } catch {
      dict = pickDict()
      currentT = (key) => dict[key] || zh[key] || key
    }
  }

  const layer = ensureLayer()
  const btn = ensureButton(layer, (id, b) => {
    askThenDelete(id, b)
  })
  const manage = document.createElement('button')
  manage.id = 'dshdc-manage'
  manage.textContent = currentT('manage.title')
  manage.addEventListener('click', openManager)
  layer.appendChild(manage)

  let hovered = null
  let raf = 0
  let disposed = false
  const retryTimers = new Set()
  function later(fn, delay) {
    const timer = setTimeout(() => {
      retryTimers.delete(timer)
      if (!disposed) fn()
    }, delay)
    retryTimers.add(timer)
    return timer
  }

  function hide() {
    btn.dataset.dshdcVisible = '0'
  }

  function place(hit) {
    if (window.__dshDeleteChatNativeSlotReady__) return hide()
    if (pendingDeletes.size) return
    if (!hit || !hit.row || !hit.row.isConnected) return hide()
    const rect = hit.row.getBoundingClientRect()
    if (rect.width < 40 || rect.height < 12) return hide()
    btn.dataset.dshdcFor = hit.id
    btn.disabled = false
    btn.dataset.dshdcState = ''
    btn.title = currentT('btn.title')
    btn.setAttribute('aria-label', currentT('btn.aria'))
    // 固定层坐标 = 视口坐标，rect 也是视口坐标
    btn.style.top = `${Math.round(rect.top + rect.height / 2 - 11)}px`
    // Leave the host's native ellipsis menu at the far right accessible.
    const offset = hit.row.getAttribute?.('data-row-key')?.startsWith('session:') ? 54 : 26
    btn.style.left = `${Math.round(Math.max(0, Math.min(rect.right, window.innerWidth || rect.right) - offset))}px`
    btn.dataset.dshdcVisible = '1'
  }

  let scheduledTarget = null
  function schedule(target) {
    scheduledTarget = target
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      const hit = scheduledTarget ? resolveRow(scheduledTarget) : null
      hovered = hit
      place(hit)
      if (!hit && scheduledTarget) onMiss(scheduledTarget)
    })
  }

  /**
   * hover 没认出来时做两件事：
   *   1. 名单可能是空的（boot 时那次 fetch 赶在宿主就绪之前，失败了）——
   *      懒重试一次。这是「按钮一直不出现」最常见的成因。
   *   2. 把现场报给宿主，方便定位到底是没认出行、还是标题对不上。
   */
  let missReported = 0
  let retryTimer = 0
  function onMiss(target) {
    if (titleMap.byTitle.size === 0 && !retryTimer) {
      retryTimer = later(() => {
        retryTimer = 0
        refreshTitleMap(true).catch(() => {})
      }, 1200)
    }
    if (missReported >= 5) return
    missReported += 1
    let desc = ''
    try {
      const el = target
      desc = `${el.tagName?.toLowerCase()}.${String(el.className || '').slice(0, 40)}`
    } catch {
      /* ignore */
    }
    report('miss', {
      titleMapSize: titleMap.byTitle.size,
      target: desc,
    })
  }

  const onOver = (ev) => {
    const target = ev.target
    if (!(target instanceof Element)) return
    if (layer.contains(target)) return
    schedule(target)
    if (Date.now() - titleMap.fetchedAt > TITLE_MAP_TTL_MS) {
      refreshTitleMap().then(() => {
        if (!disposed) schedule(target)
      }).catch(() => {})
    }
  }

  const onOut = (ev) => {
    const to = ev.relatedTarget
    if (to instanceof Element && (to === btn || btn.contains(to))) return
    schedule(to instanceof Element ? to : null)
  }

  const onScrollOrResize = () => {
    if (hovered && hovered.row && hovered.row.isConnected) place(hovered)
    else {
      hovered = null
      hide()
    }
  }

  document.addEventListener('mouseover', onOver, true)
  document.addEventListener('mouseout', onOut, true)
  document.addEventListener('focusin', onOver, true)
  document.addEventListener('pointerdown', onOver, true)
  window.addEventListener('scroll', onScrollOrResize, true)
  window.addEventListener('resize', onScrollOrResize)

  /**
   * 名单先拉好，否则第一次 hover 反查不到 id。
   *
   * boot 期这次 fetch 有可能赶在宿主认证就绪之前而失败 —— 失败后不能就这么算了，
   * 否则整个生命周期里名单都是空的，按钮永远不出现（这正是上一版的表现）。
   * 所以失败就退避重试几次，同时上报现场。
   */
  const primeTitleMap = (attempt = 0) => {
    refreshTitleMap(attempt > 0)
      .then((map) => {
        if (disposed) return
        if (map.byTitle.size > 0) {
          report('install', { event2: 'titleMapReady', size: map.byTitle.size, attempt })
          return
        }
        if (disposed) return
        if (attempt < 6) later(() => primeTitleMap(attempt + 1), 800 * (attempt + 1))
        else report('install', { event2: 'titleMapEmpty', attempt, apiBase: API_BASE })
      })
      .catch(() => {
        if (!disposed && attempt < 6) later(() => primeTitleMap(attempt + 1), 800 * (attempt + 1))
      })
  }
  primeTitleMap()
  report('install', { apiBase: API_BASE, hasLayer: Boolean(layer),
    version: window.__dshDeleteChatBuildVersion__ || 'source' })

  // 自检手柄
  try {
    window.dshDeleteChat = {
      status: () => {
        const { source, selectors } = activeSelectors()
        return {
          selectorSource: source,
          selectors,
          apiBase: API_BASE,
          titleMapSize: titleMap.byTitle.size,
          visible: btn.dataset.dshdcVisible === '1',
          current: btn.dataset.dshdcFor || null,
          nativeRowAction: window.__dshDeleteChatNativeSlotReady__ === true,
          version: window.__dshDeleteChatBuildVersion__ || 'source',
          hostVersion: titleMap.hostVersion || null,
        }
      },
      titleMap: () => ({
        size: titleMap.byTitle.size,
        sample: [...titleMap.byTitle.entries()].slice(0, 10),
        fetchedAt: titleMap.fetchedAt,
      }),
      refreshTitles: () => refreshTitleMap(true),
      /** 拿一个元素试解析（排查用）：document.elementFromPoint 的结果直接喂进来。 */
      probe: (el) => ({ isRow: Boolean(resolveRow(el)), id: el ? resolveRow(el)?.id || null : null }),
      openManager,
      requestDelete: (id, button) => askThenDelete(id, button || btn),
      reportNativeReady: () => report('nativeRowActionReady', { version: window.__dshDeleteChatBuildVersion__ || 'source' }),
      setRowSelectors: (list) => {
        if (list === null) localStorage.removeItem(OVERRIDE_KEY)
        else localStorage.setItem(OVERRIDE_KEY, JSON.stringify(list))
        hovered = null
        hide()
        return activeSelectors()
      },
    }
  } catch {
    /* 非浏览器环境 */
  }

  ctx.effect(
    () => () => {
      disposed = true
      confirmation?.()
      for (const timer of retryTimers) clearTimeout(timer)
      document.removeEventListener('mouseover', onOver, true)
      document.removeEventListener('mouseout', onOut, true)
      document.removeEventListener('focusin', onOver, true)
      document.removeEventListener('pointerdown', onOver, true)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
      if (raf) cancelAnimationFrame(raf)
      const l = document.getElementById(LAYER_ID)
      if (l) l.remove()
      const s = document.getElementById('dshdc-style')
      if (s) s.remove()
      delete window.dshDeleteChat
      window.__dshDeleteChatInstalled__ = false
    },
    'dsh-delete-chat: dom cleanup',
  )
}





// ---------- end client-core.js ----------

  /**
   * 直接启动。这里没有宿主 ctx，于是给一个最小替身：
   * client-core 只用到 ctx.locale（可选）与 ctx.effect（清理钩子）。
   */
  var hostCtx = {
    locale: undefined,
    effect: function (fn) {
      var dispose = fn();
      window.addEventListener("pagehide", function () {
        try { if (typeof dispose === "function") dispose(); } catch (e) {}
      }, { once: true });
    },
  };

  function start() {
    if (window.__dshDeleteChatInstalled__ || !document.body) return;
    try {
      apply(hostCtx);
      window.__dshDeleteChatInstalled__ = true;
      console.info("[dsh-delete-chat] client installed");
    } catch (error) {
      window.__dshDeleteChatInstalled__ = false;
      console.error("[dsh-delete-chat] client apply failed:", error);
    }
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) start();
  });
})();
