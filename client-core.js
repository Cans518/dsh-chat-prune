/**
 * dsh-chat-prune — client half.
 *
 * 形态：鼠标移到会话列表某一行上时，在该行右端浮出一个垃圾桶按钮；
 * 点击 → 确认 → 调 host 的 DELETE /dsh-chat-prune/sessions → 列表自己消失。
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

import { showConversationManager } from './client-manager.js'

const name = 'dsh-chat-prune'

const NS = 'settings.dsh-chat-prune'

const API_BASE = '/dsh-chat-prune'

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
  'notice.dismiss': '关闭提示',
  'state.unknown': '未收到有效响应，结果尚未确认。请刷新列表检查后再重试。',
  'state.refreshFailed': '删除已完成，但列表刷新失败。请点击刷新列表。',
  'state.partial': '删除可能已部分完成。请修复上述错误后重试以清理残留索引。',
  'manage.title': '管理对话',
  'manage.search': '搜索标题、工作区或会话 ID',
  'manage.refresh': '刷新列表',
  'manage.close': '关闭',
  'manage.empty': '没有匹配的对话',
  'manage.loading': '正在读取对话…',
  'manage.untitled': '无标题对话',
  'manage.running': '进行中或受保护',
  'manage.cancel': '取消',
  'manage.delete': '确认删除',
  'manage.backup': '备份位置：',
  'manage.unknown': '运行检测不可用，删除时仍会校验宿主写入锁。',
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
  'notice.dismiss': 'Dismiss notice',
  'state.unknown': 'No valid response was received; the result is unknown. Refresh before retrying.',
  'state.refreshFailed': 'Deletion completed, but refreshing failed. Refresh the list to check.',
  'state.partial': 'Deletion may have partly completed. Fix the error and retry to clean up remaining entries.',
  'manage.title': 'Manage conversations',
  'manage.search': 'Search title, workspace or session ID',
  'manage.refresh': 'Refresh list',
  'manage.close': 'Close',
  'manage.empty': 'No matching conversations',
  'manage.loading': 'Loading conversations…',
  'manage.untitled': 'Untitled conversation',
  'manage.running': 'Running or protected',
  'manage.cancel': 'Cancel',
  'manage.delete': 'Delete conversation',
  'manage.backup': 'Backup location: ',
  'manage.unknown': 'Activity detection is unavailable. Deletion will still check host write ownership.',
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
      error.definitive = true
      error.outcomeUnknown = data?.outcomeUnknown === true
      error.partial = data?.partial
      error.backupDir = data?.backupDir
      throw error
    }
    return data
  } catch (error) {
    if (!error.definitive) error.outcomeUnknown = true
    throw error
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
  const generation = clientGeneration
  const pending = (async () => {
    const data = await requestJson(`${API_BASE}/sessions`)
    if (generation !== clientGeneration) return titleMap
    if (data.apiVersion !== 1) throw new Error(currentT('state.hostOutdated'))
    const rows = Array.isArray(data?.sessions) ? data.sessions : []
    const backupOn = data?.config ? data.config.backup === true : undefined
    if (backupOn !== undefined) window.__dshdcBackupOn = backupOn
    const byTitle = new Map()
    for (const row of rows) {
      if (row.sourceId && row.sourceId !== 'local') continue
      if (!row?.id || !row.title) continue
      const key = normalizeTitle(row.title)
      // Duplicates remain explicitly ambiguous, including the third occurrence.
      byTitle.set(key, byTitle.has(key) ? null : row.id)
    }
    titleMap = { byTitle, fetchedAt: now, sessions: rows, config: data.config || {},
      canDetectRunning: data.canDetectRunning, hostVersion: data.version, actions: data.actions || [],
      managementVersion: data.managementVersion, sources: data.sources || [] }
    return titleMap
  })()
  titleRequest = pending
  try {
    return await pending
  } finally {
    if (titleRequest === pending) titleRequest = null
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
#${LAYER_ID}, .dshdc-native-del, .dshdc-sidebar-manage {
  --dshdc-surface: var(--dsw-alias-bg-layer-2, Canvas);
  --dshdc-text: var(--dsw-alias-label-primary, CanvasText);
  --dshdc-muted: var(--dsw-alias-label-secondary, GrayText);
  --dshdc-border: var(--dsw-alias-border-l3, ButtonBorder);
  --dshdc-hover: var(--dsw-alias-interactive-bg-hover, ButtonFace);
  --dshdc-active: var(--dsw-alias-interactive-bg-active, ButtonFace);
  --dshdc-danger: var(--dsw-alias-state-error-primary, light-dark(#b42318, #ff9b9b));
  --dshdc-danger-hover: var(--dsw-alias-interactive-bg-hover-danger, var(--dshdc-hover));
  --dshdc-focus: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, Highlight));
}
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
  color: var(--dshdc-muted);
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
  transition: background-color .12s ease, color .12s ease;
}
.${BTN_CLASS}[data-dshdc-visible="1"] { display: inline-flex; }
.${BTN_CLASS}:hover {
  background: var(--dshdc-danger-hover);
  color: var(--dshdc-danger);
}
.${BTN_CLASS}:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dshdc-focus);
  outline-offset: 1px;
}
.${BTN_CLASS}[data-dshdc-state="deleting"] { opacity: .5; pointer-events: none; }
.${BTN_CLASS}[data-dshdc-state="done"] { color: var(--dshdc-text); }
.${BTN_CLASS}[data-dshdc-state="failed"] { color: var(--dshdc-danger); }
.dshdc-native-del:hover { color:var(--dshdc-danger) !important; background:var(--dshdc-danger-hover) !important; }
.dshdc-native-del:focus-visible { outline:var(--dsw-focus-ring-width, 2px) solid var(--dshdc-focus); outline-offset:2px; }
.dshdc-native-del:disabled { opacity:.5; cursor:wait !important; }
#dshdc-manage { all:unset; position:fixed; left:12px; bottom:64px; pointer-events:auto;
  padding:10px 14px; border:1px solid var(--dshdc-border); border-radius:var(--dsw-radius-md, 8px); cursor:pointer;
  background:var(--dshdc-surface); color:var(--dshdc-text); font:inherit; }
#dshdc-manage:hover { background:var(--dshdc-hover); }
#dshdc-manage[hidden] { display:none; }
.dshdc-sidebar-manage { display:flex; align-items:center; justify-content:center; gap:10px;
  box-sizing:border-box; min-height:44px; width:100%; padding:10px 12px;
  border:0; border-radius:var(--dsw-radius-md,8px); background:transparent;
  color:var(--dshdc-text); cursor:pointer; font:inherit; white-space:nowrap; }
.dshdc-sidebar-manage:hover { background:var(--dshdc-hover); }
.dshdc-sidebar-manage:focus-visible { outline:2px solid var(--dshdc-focus); outline-offset:-2px; }
.dshdc-sidebar-manage:active { background:var(--dshdc-active); }
.dshdc-dialog { color-scheme:inherit; box-sizing:border-box; width:min(640px, calc(100vw - 32px));
  max-height:80vh; padding:24px; border:0; border-radius:var(--dsw-radius-panel, 12px);
  background:var(--dshdc-surface); color:var(--dshdc-text);
  box-shadow:var(--dsw-elevation-prominent, 0 0 0 1px var(--dshdc-border), 0 16px 48px #0003);
  font:inherit; font-family:var(--dsw-font-family, system-ui, sans-serif); line-height:1.5; overflow:auto; pointer-events:auto; }
.dshdc-dialog::backdrop { background:var(--dsw-alias-bg-mask-1, #0008); backdrop-filter:var(--dsw-mask-blur, none); }
.dshdc-dialog h2 { font-size:20px; margin:0 0 16px; }
.dshdc-dialog [hidden] { display:none !important; }
.dshdc-dialog :is(input, select) { box-sizing:border-box; width:100%; min-height:44px; padding:8px; margin:12px 0; font:inherit;
  border:1px solid var(--dsw-alias-border-l4, var(--dshdc-border)); border-radius:var(--dsw-radius-md, 6px);
  background:var(--dsw-alias-bg-layer-1, Field); color:var(--dshdc-text); caret-color:var(--dshdc-focus); }
.dshdc-dialog input::placeholder { color:var(--dsw-alias-label-tertiary, var(--dshdc-muted)); }
.dshdc-dialog input:focus-visible { border-color:var(--dshdc-focus); }
.dshdc-dialog button { min-height:44px; padding:8px 16px; border:1px solid var(--dshdc-border);
  background:transparent; color:var(--dshdc-text); border-radius:var(--dsw-radius-md, 6px); cursor:pointer; font:inherit; }
.dshdc-dialog button:hover:not(:disabled) { background:var(--dshdc-hover); }
.dshdc-dialog button:active:not(:disabled) { background:var(--dshdc-active); }
.dshdc-dialog button:disabled { opacity:.55; cursor:not-allowed; }
.dshdc-dialog :is(button, input, select, summary):focus-visible, #dshdc-manage:focus-visible {
  outline:var(--dsw-focus-ring-width, 2px) solid var(--dshdc-focus); outline-offset:2px; }
.dshdc-actions { display:flex; justify-content:flex-end; gap:12px; flex-wrap:wrap; margin-top:20px; }
.dshdc-dialog button.dshdc-danger { border-color:var(--dshdc-danger); color:var(--dshdc-danger); }
.dshdc-dialog button.dshdc-danger:hover:not(:disabled) { background:var(--dshdc-danger-hover); }
.dshdc-dialog button.dshdc-primary { background:color-mix(in srgb,var(--dshdc-focus) 92%,var(--dshdc-text));
  color:var(--dsw-alias-label-on-color,light-dark(#ffffff,#13213f)); border-color:transparent; }
.dshdc-dialog button.dshdc-primary:hover:not(:disabled) { background:color-mix(in srgb,var(--dshdc-focus) 85%,var(--dshdc-text)); }
.dshdc-filters { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
.dshdc-field { display:flex; flex-direction:column; gap:6px; min-width:0; font-size:12px; font-weight:500; }
.dshdc-field > label { color:var(--dshdc-muted); }
.dshdc-field :is(input, select) { margin:0; }
.dshdc-field:has(input[type="search"]) { grid-column:span 2; }
.dshdc-dialog input[type="checkbox"] { width:18px; height:18px; min-height:18px; margin:0; accent-color:var(--dshdc-focus); cursor:pointer; flex-shrink:0; }
.dshdc-select-target { display:flex; align-items:center; justify-content:center; min-width:44px; min-height:44px; cursor:pointer; }
.dshdc-hint, .dshdc-rules p { font-size:12px; line-height:1.6; color:var(--dshdc-muted); }
#dshdc-manager {
  --dshdc-soft:color-mix(in srgb,var(--dshdc-surface) 95%,var(--dshdc-text));
  --dshdc-tint:color-mix(in srgb,var(--dshdc-focus) 9%,var(--dshdc-surface));
  --dshdc-accent-text:color-mix(in srgb,var(--dshdc-focus) 82%,var(--dshdc-text));
  width:min(1180px,calc(100vw - 48px)); height:min(860px,calc(100dvh - 48px));
  max-height:calc(100dvh - 48px); padding:0; font-size:14px;
}
#dshdc-manager[open] { display:flex; flex-direction:column; overflow:hidden; }
#dshdc-manager svg, #dshdc-batch-preview svg { flex-shrink:0; }
#dshdc-manager button { display:inline-flex; align-items:center; justify-content:center; gap:7px; }
#dshdc-manager > .dshdc-manager-header { flex-shrink:0; align-items:center; gap:8px; padding:14px 24px;
  margin:0; background:var(--dshdc-surface); border-bottom:1px solid var(--dshdc-border); }
.dshdc-manager-heading { display:flex; align-items:center; gap:12px; flex:1; min-width:0; }
.dshdc-manager-heading > div { min-width:0; }
.dshdc-manager-mark { display:flex; align-items:center; justify-content:center; width:42px; height:42px;
  color:var(--dshdc-focus); background:var(--dshdc-tint); border-radius:12px; }
.dshdc-manager-mark svg { width:23px; height:23px; }
.dshdc-manager-heading h2 { margin:0; font-size:21px; line-height:1.35; font-weight:650; letter-spacing:-.02em; }
.dshdc-manager-heading p { margin:3px 0 0; font-size:12px; color:var(--dshdc-muted); }
#dshdc-manager .dshdc-close { width:44px; padding:0; font-size:0; border-color:transparent; }
.dshdc-manager-body { display:flex; flex:1; flex-direction:column; min-height:0; overflow:hidden; }
.dshdc-manager-controls { flex-shrink:0; max-height:50%; overflow:auto; padding:0 24px 10px;
  scrollbar-gutter:stable; overscroll-behavior:contain; }
.dshdc-summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:0; padding:14px 0; }
.dshdc-metric { display:flex; align-items:baseline; justify-content:space-between; gap:8px; min-width:0;
  padding:0 20px; border-left:1px solid var(--dshdc-border); font-variant-numeric:tabular-nums; }
.dshdc-metric:first-child { border-left:0; padding-left:0; }
.dshdc-metric:last-child { padding-right:0; }
.dshdc-metric > span { font-size:12px; color:var(--dshdc-muted); white-space:nowrap; }
.dshdc-metric > strong { font-size:18px; font-weight:650; white-space:nowrap; }
.dshdc-source-tools { margin:0 0 10px; font-size:12px; color:var(--dshdc-muted); }
.dshdc-source-panel { padding:16px; margin:12px 0; border:1px solid var(--dshdc-border);
  border-radius:12px; background:var(--dshdc-soft); }
.dshdc-source-panel h3 { margin:0 0 6px; font-size:15px; }
.dshdc-source-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:12px 0; border-bottom:1px solid var(--dshdc-border); }
.dshdc-source-row > div { flex:1; min-width:150px; overflow-wrap:anywhere; }
.dshdc-source-row small { display:block; font-size:12px; color:var(--dshdc-muted); }
.dshdc-source-panel form { margin-top:16px; grid-template-columns:repeat(2,minmax(0,1fr)); }
.dshdc-source-panel form > .dshdc-field:has(input[type="url"]) { grid-column:1/-1; }
.dshdc-source-feedback:empty { display:none; }
.dshdc-source-feedback[data-tone="error"] { color:var(--dshdc-danger); }
.dshdc-main-filters { grid-template-columns:2fr 1fr 1fr; }
.dshdc-main-filters > .dshdc-field:has(input[type="search"]) { grid-column:auto; }
.dshdc-search-control { display:flex; align-items:center; min-width:0; position:relative; }
.dshdc-search-control > svg { position:absolute; left:12px; color:var(--dshdc-muted); pointer-events:none; }
.dshdc-search-control input { padding-inline:38px 42px; }
.dshdc-search-control input::-webkit-search-cancel-button { -webkit-appearance:none; }
#dshdc-manager .dshdc-search-control button { position:absolute; right:2px; width:40px; padding:0; border-color:transparent; }
.dshdc-filter-tools { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:10px 0 8px; }
.dshdc-status-filters { display:flex; gap:4px; flex-wrap:wrap; }
#dshdc-manager .dshdc-status-filter { min-height:36px; padding:6px 10px; border:1px solid transparent;
  border-radius:7px; font-size:12px; color:var(--dshdc-muted); white-space:nowrap; }
.dshdc-status-filter > span { min-width:16px; font-size:11px; font-variant-numeric:tabular-nums; }
#dshdc-manager .dshdc-status-filter[aria-pressed="true"] { background:var(--dshdc-tint); color:var(--dshdc-accent-text);
  border-color:color-mix(in srgb,var(--dshdc-focus) 24%,transparent); font-weight:600; }
.dshdc-filter-actions { display:flex; align-items:center; gap:4px; flex-shrink:0; }
#dshdc-manager .dshdc-filter-actions button { min-height:36px; padding:6px 9px; font-size:12px; }
#dshdc-manager .dshdc-text-button { border-color:transparent; color:var(--dshdc-muted); }
#dshdc-advanced-filters { grid-template-columns:repeat(3,minmax(0,1fr)); padding:12px; margin-bottom:8px;
  background:var(--dshdc-soft); border-radius:10px; }
.dshdc-rules { grid-column:1/-1; margin:0; padding:0; border:1px solid var(--dshdc-border); border-radius:9px; }
.dshdc-rules summary { display:flex; align-items:center; gap:8px; min-height:40px; box-sizing:border-box;
  padding:8px 12px; cursor:pointer; list-style:none; font-size:12px; }
.dshdc-rules summary::-webkit-details-marker { display:none; }
.dshdc-rules summary > svg { width:16px; height:16px; color:var(--dshdc-focus); }
.dshdc-rules summary::after { content:'⌄'; margin-left:auto; color:var(--dshdc-muted); }
.dshdc-rules[open] summary::after { transform:rotate(180deg); }
.dshdc-rule-caption { margin-left:4px; color:var(--dshdc-muted); }
.dshdc-rules .dshdc-filters { grid-template-columns:repeat(2,minmax(0,1fr)); margin:8px 12px; }
.dshdc-rules > p { margin:10px 12px; }
.dshdc-rules > button { margin:0 12px 12px; }
#dshdc-manager-notice { flex-shrink:0; max-height:82px; overflow:auto; padding:8px 24px;
  white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; line-height:1.6; color:var(--dshdc-muted);
  border-top:1px solid var(--dshdc-border); background:var(--dshdc-soft); }
#dshdc-manager-notice:empty { display:none; }
.dshdc-list-section { display:flex; flex:1; flex-direction:column; min-height:80px; border-top:1px solid var(--dshdc-border); }
.dshdc-list-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 24px;
  flex-shrink:0; border-bottom:1px solid var(--dshdc-border); }
.dshdc-selection-tools { display:flex; align-items:center; flex-wrap:wrap; gap:4px; min-width:0; }
.dshdc-page-selection { display:flex; align-items:center; min-height:44px; gap:8px; margin-right:8px; cursor:pointer; font-size:12px; }
.dshdc-result-count { padding-right:10px; color:var(--dshdc-muted); font-size:12px; white-space:nowrap; }
#dshdc-manager .dshdc-selection-tools button { padding:6px 8px; border-color:transparent; font-size:12px; }
.dshdc-list-sort .dshdc-field { display:flex; flex-direction:row; align-items:center; gap:8px; }
.dshdc-list-sort select { width:142px; min-height:38px; font-size:12px; }
.dshdc-records-scroll { flex:1; min-height:0; overflow:auto; scrollbar-gutter:stable; overscroll-behavior:contain; }
.dshdc-records-scroll:focus-visible { outline:2px solid var(--dshdc-focus); outline-offset:-2px; }
.dshdc-record { display:flex; align-items:center; gap:12px; padding:13px 20px 13px 12px;
  border-bottom:1px solid color-mix(in srgb,var(--dshdc-border) 65%,transparent); border-left:3px solid transparent; }
.dshdc-record:hover { background:var(--dshdc-soft); }
.dshdc-record[data-selected="true"] { background:var(--dshdc-tint); border-left-color:var(--dshdc-focus); }
.dshdc-record[data-selected="true"] :is(.dshdc-record-meta,.dshdc-record-id,.dshdc-source-path,.dshdc-record-size) {
  color:color-mix(in srgb,var(--dshdc-text) 24%,var(--dshdc-muted)); }
.dshdc-record-text { display:block; flex:1; min-width:0; cursor:pointer; }
.dshdc-record[data-readonly="true"] .dshdc-record-text { cursor:default; }
.dshdc-record-title { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dshdc-record-title > strong { min-width:0; overflow-wrap:anywhere; font-size:14px; font-weight:600; line-height:1.45; }
.dshdc-record-meta { display:flex; align-items:center; gap:6px 16px; flex-wrap:wrap; margin-top:4px;
  color:var(--dshdc-muted); font-size:12px; }
.dshdc-record-meta > span { display:inline-flex; align-items:center; gap:5px; }
.dshdc-record-meta svg { width:13px; height:13px; }
.dshdc-record-id, .dshdc-source-path { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--dshdc-muted); font-size:11px; line-height:1.5; }
.dshdc-record-identity { display:flex; align-items:center; flex-wrap:wrap; gap:2px 10px; min-width:0; margin-top:4px; }
.dshdc-source-path { max-width:100%; padding-left:10px; border-left:1px solid var(--dshdc-border); }
.dshdc-record-id { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
.dshdc-record-size { width:76px; flex-shrink:0; text-align:right; color:var(--dshdc-muted); font-size:12px; font-variant-numeric:tabular-nums; }
.dshdc-record-actions { display:flex; align-items:center; gap:12px; flex-shrink:0; }
.dshdc-badges { display:inline-flex; flex-wrap:wrap; gap:4px; }
.dshdc-badge { padding:2px 7px; font-size:11px; font-weight:500; line-height:1.6; border-radius:5px;
  color:var(--dshdc-muted); background:var(--dshdc-soft); border:1px solid var(--dshdc-border); }
.dshdc-badge[data-kind="pinned"], .dshdc-badge[data-kind="idle"] { color:var(--dshdc-accent-text); border-color:color-mix(in srgb,var(--dshdc-focus) 25%,transparent); background:var(--dshdc-tint); }
#dshdc-manager .dshdc-record-remove { min-width:44px; width:44px; padding:0; border-color:transparent; color:var(--dshdc-muted); }
#dshdc-manager .dshdc-record-remove:hover:not(:disabled) { color:var(--dshdc-danger); background:var(--dshdc-danger-hover); }
.dshdc-empty { display:flex; align-items:center; justify-content:center; flex-direction:column; gap:10px; min-height:180px;
  padding:24px; box-sizing:border-box; text-align:center; }
.dshdc-empty > svg { width:28px; height:28px; padding:12px; background:var(--dshdc-soft); border-radius:14px; color:var(--dshdc-muted); }
.dshdc-empty > strong { font-size:15px; }
.dshdc-empty > p { margin:0; font-size:13px; color:var(--dshdc-muted); }
.dshdc-pagination { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 24px;
  flex-shrink:0; border-top:1px solid var(--dshdc-border); color:var(--dshdc-muted); font-size:12px; }
.dshdc-pagination > div { display:flex; align-items:center; gap:10px; white-space:nowrap; }
#dshdc-manager .dshdc-pagination button { padding:6px 10px; font-size:12px; }
.dshdc-operation-bar { display:flex; align-items:center; gap:12px; flex-shrink:0; margin:0; padding:12px 24px;
  border-top:1px solid var(--dshdc-border); background:var(--dshdc-surface); }
.dshdc-selection-summary { flex:1; min-width:0; }
.dshdc-selected-count { font-size:14px; font-weight:600; font-variant-numeric:tabular-nums; }
.dshdc-selection-summary > .dshdc-hint { display:block; margin-top:3px; }
.dshdc-operation-bar > .dshdc-field { min-width:120px; flex-direction:row; align-items:center; gap:8px; }
.dshdc-operation-bar > .dshdc-field > label { white-space:nowrap; }
.dshdc-operation-bar > .dshdc-field > select { width:128px; }
.dshdc-operation-bar > .dshdc-field:has(input[type="checkbox"]) { min-height:44px; flex-direction:row-reverse;
  justify-content:flex-end; align-items:center; gap:8px; }
.dshdc-operation-bar:has(.dshdc-stop:not([hidden])) > .dshdc-primary { display:none !important; }
.dshdc-progress { display:flex; align-items:center; gap:10px; flex-basis:100%; min-width:0; color:var(--dshdc-muted); font-size:12px; }
.dshdc-progress progress { width:100%; height:6px; border:0; accent-color:var(--dshdc-focus); border-radius:6px; overflow:hidden; }
.dshdc-progress > span { white-space:nowrap; font-variant-numeric:tabular-nums; }
.dshdc-operation-bar:has(.dshdc-progress:not([hidden])) { flex-wrap:wrap; }
#dshdc-results { white-space:pre-wrap; overflow-wrap:anywhere; padding:0 16px; }
#dshdc-results p { padding:12px 14px; background:var(--dshdc-soft); border-radius:9px; font-size:12px; border-left:3px solid var(--dshdc-focus); }
#dshdc-results p[data-state="failed"], #dshdc-results p[data-state="unknown"] { border-left-color:var(--dshdc-danger); }
#dshdc-batch-preview { width:min(680px,calc(100vw - 32px)); max-height:calc(100dvh - 32px); }
#dshdc-batch-preview[open] { display:flex; flex-direction:column; overflow:hidden; }
.dshdc-preview-body { min-height:0; overflow:auto; }
.dshdc-preview-body > p:first-child { margin-top:0; color:var(--dshdc-muted); }
.dshdc-preview-warning { padding:12px 14px; border:1px solid var(--dshdc-border); border-radius:9px; font-size:13px; }
.dshdc-preview-list { max-height:38vh; overflow:auto; overflow-wrap:anywhere; white-space:pre-wrap; border-block:1px solid var(--dshdc-border); }
.dshdc-preview-list > p { padding:10px 0; margin:0; font-size:13px; border-bottom:1px solid var(--dshdc-border); }
#dshdc-batch-preview > .dshdc-actions { flex-shrink:0; margin-top:16px; }
@keyframes dshdc-refresh { to { transform:rotate(360deg); } }
.dshdc-refresh[data-loading="true"] svg { animation:dshdc-refresh 1s linear infinite; }
@media (max-width:900px) {
  .dshdc-filter-tools { align-items:flex-start; flex-direction:column; gap:4px; }
  .dshdc-filter-actions { align-self:flex-end; }
  .dshdc-rule-caption { display:none; }
}
@media (max-width:600px) {
  .dshdc-dialog { padding:16px; max-height:90vh; }
  .dshdc-filters { grid-template-columns:repeat(2,minmax(0,1fr)); }
  #dshdc-manager { width:calc(100vw - 16px); height:calc(100dvh - 24px); max-height:calc(100dvh - 24px); padding:0; }
  #dshdc-manager > .dshdc-manager-header { gap:4px; padding:12px; }
  .dshdc-manager-heading { gap:8px; }
  .dshdc-manager-heading h2 { font-size:18px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .dshdc-manager-heading p { display:none; }
  .dshdc-manager-mark { width:34px; height:34px; border-radius:10px; }
  #dshdc-manager .dshdc-manager-header > button { width:44px; padding:0; font-size:0; border-color:transparent; }
  .dshdc-manager-controls { padding:10px 12px; max-height:43%; }
  .dshdc-summary, .dshdc-source-tools { display:none; }
  .dshdc-main-filters > .dshdc-field:has(input[type="search"]) { grid-column:1/-1; }
  .dshdc-main-filters > .dshdc-field > label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
  .dshdc-main-filters { gap:8px; }
  .dshdc-main-filters :is(input,select) { font-size:16px; }
  .dshdc-filter-tools { flex-direction:row; align-items:center; gap:4px; margin:6px 0 0; }
  .dshdc-status-filters { flex:1; min-width:0; flex-wrap:nowrap; overflow:auto; max-width:100%; padding:2px; box-sizing:border-box; }
  #dshdc-manager .dshdc-status-filter { min-height:44px; padding:6px 8px; }
  .dshdc-filter-actions { align-self:auto; gap:0; }
  #dshdc-manager .dshdc-filter-actions button { min-height:44px; width:40px; padding:0; font-size:0; border-color:transparent; }
  #dshdc-advanced-filters { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .dshdc-source-panel { padding:12px; }
  .dshdc-source-panel form { grid-template-columns:1fr; }
  .dshdc-source-panel form > .dshdc-field:has(input[type="url"]) { grid-column:auto; }
  .dshdc-list-toolbar { padding:6px 12px; gap:4px; flex-wrap:wrap; }
  .dshdc-selection-tools { flex:1; gap:2px; flex-wrap:nowrap; }
  .dshdc-page-selection { gap:6px; margin-right:2px; }
  .dshdc-result-count { display:none; }
  #dshdc-manager .dshdc-selection-tools button { padding:6px 4px; font-size:12px; }
  #dshdc-manager .dshdc-selection-tools .dshdc-text-button { width:36px; padding:0; font-size:0; }
  .dshdc-list-sort .dshdc-field > label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
  .dshdc-list-sort select { width:104px; min-height:44px; padding:6px; }
  #dshdc-manager-notice { padding:6px 12px; max-height:70px; }
  .dshdc-record { padding:12px 10px 12px 2px; gap:6px; }
  .dshdc-select-target { min-width:36px; }
  .dshdc-record-title > strong { font-size:14px; }
  .dshdc-record-meta { gap:3px 8px; font-size:11px; }
  .dshdc-record-actions { flex-direction:column; gap:0; }
  .dshdc-record-size { width:44px; text-align:center; font-size:11px; white-space:nowrap; }
  .dshdc-pagination { padding:6px 12px; gap:6px; }
  .dshdc-pagination > div { gap:6px; }
  #dshdc-manager .dshdc-pagination button { padding:6px 8px; }
  .dshdc-operation-bar { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:8px 12px; padding:10px 12px; }
  .dshdc-selection-summary { grid-column:1; grid-row:1; }
  .dshdc-selected-count { font-size:12px; }
  .dshdc-selection-summary > .dshdc-hint { display:none; }
  .dshdc-operation-bar > .dshdc-field { min-width:0; grid-column:1; grid-row:2; flex-direction:column; align-items:stretch; gap:4px; }
  .dshdc-operation-bar > .dshdc-field > select { width:100%; }
  .dshdc-operation-bar > .dshdc-field:has(input[type="checkbox"]) { grid-column:2; grid-row:1; min-height:32px; justify-content:center; }
  .dshdc-operation-bar > :is(.dshdc-primary,.dshdc-stop) { grid-column:2; grid-row:2; align-self:end; padding:8px; font-size:13px; }
  .dshdc-progress { grid-column:1/-1; }
}
@media (max-height:520px) {
  #dshdc-manager { height:calc(100dvh - 16px); max-height:calc(100dvh - 16px); }
  #dshdc-manager > .dshdc-manager-header { padding-block:8px; }
  .dshdc-manager-controls { max-height:25%; }
  .dshdc-list-toolbar, .dshdc-pagination { padding-block:2px; }
  .dshdc-summary { display:none; }
  .dshdc-operation-bar { padding-block:8px; }
  .dshdc-selection-summary > .dshdc-hint { display:none; }
}
#dshdc-notice { position:fixed; right:16px; bottom:72px; max-width:min(480px, calc(100vw - 32px));
  padding:12px 40px 12px 16px; border:1px solid var(--dshdc-border); border-radius:var(--dsw-radius-md, 8px);
  background:var(--dshdc-surface); color:var(--dshdc-text);
  font:inherit; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; pointer-events:auto; }
#dshdc-notice[hidden] { display:none; }
#dshdc-notice[data-tone="error"] { border-color:var(--dshdc-danger, #ff6b6b); }
#dshdc-notice[data-tone="done"] { border-color:var(--dshdc-ok, #4ec97a); }
#dshdc-notice > .dshdc-notice-close {
  all:unset; position:absolute; top:6px; right:6px; width:22px; height:22px;
  display:inline-flex; align-items:center; justify-content:center;
  border-radius:5px; cursor:pointer; color:inherit; opacity:.7; font-size:16px; line-height:1;
}
#dshdc-notice > .dshdc-notice-close:hover { opacity:1; background:var(--dshdc-hover, rgba(255,255,255,.1)); }
#dshdc-notice > .dshdc-notice-close:focus-visible { opacity:1; outline:2px solid var(--dshdc-accent, #4d9fff); }
@media (prefers-reduced-motion:reduce) {
  .${BTN_CLASS}, #dshdc-manager button, .dshdc-record { transition:none; }
  .dshdc-refresh[data-loading="true"] svg { animation:none; }
}
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

/** Busy notices remain until replaced; results can be dismissed or expire. */
let noticeTimer = 0

function dismissNotice() {
  clearTimeout(noticeTimer)
  noticeTimer = 0
  const el = document.getElementById('dshdc-notice')
  if (el) {
    el.textContent = ''
    el.hidden = true
  }
}

function notify(message, { tone = 'info', timeout } = {}) {
  let notice = document.getElementById('dshdc-notice')
  if (!notice) {
    notice = document.createElement('div')
    notice.id = 'dshdc-notice'
    notice.setAttribute('role', 'status')
    notice.setAttribute('aria-live', 'polite')
  }
  // Modal dialogs make everything outside them inert, including close buttons.
  const parent = document.getElementById('dshdc-manager-notice') || document.getElementById(LAYER_ID)
  if (notice.parentElement !== parent) {
    if (parent?.id === 'dshdc-manager-notice') parent.textContent = ''
    parent?.appendChild(notice)
  }
  notice.hidden = false
  notice.dataset.tone = tone

  // 关闭按钮：提示条唯一的确定性消失方式
  let close = notice.querySelector('.dshdc-notice-close')
  if (!close) {
    close = document.createElement('button')
    close.type = 'button'
    close.className = 'dshdc-notice-close'
    close.setAttribute('aria-label', currentT('notice.dismiss'))
    close.title = currentT('notice.dismiss')
    close.textContent = '×'
    close.addEventListener('click', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      dismissNotice()
    })
    notice.appendChild(close)
  }

  let body = notice.querySelector('.dshdc-notice-body')
  if (!body) {
    body = document.createElement('span')
    body.className = 'dshdc-notice-body'
    notice.insertBefore(body, close)
  }
  body.textContent = message

  clearTimeout(noticeTimer)
  noticeTimer = 0
  const ms = timeout ?? (tone === 'busy' ? 0 : tone === 'error' ? 12000 : 6000)
  if (ms > 0) noticeTimer = setTimeout(dismissNotice, ms)
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
let disposeManager = null
const pendingDeletes = new Set()
let clientGeneration = 0

function confirmDeletion(sessionId, row) {
  const t = currentT
  const backupOn = titleMap.config?.backup === true || row?.backup === true
  const body = (row?.missing ? t('confirm.missing') : backupOn ? t('confirm.bodyBackup') : t('confirm.body')).replace('{id}', sessionId)
  const dialog = createDialog(t('confirm.title'))
  if (typeof dialog.showModal !== 'function') {
    dialog.remove()
    return Promise.resolve(window.confirm(`${t('confirm.title')}\n\n${row?.title || ''}\n${body}`))
  }
  const detail = document.createElement('p')
  detail.textContent = [row?.title || t('manage.untitled'), row?.workspace, row?.sourceHome, body].filter(Boolean).join('\n')
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
  await window.__dshChatPruneRefreshSessions__?.(deletedId)
  return refreshTitleMap(true)
}

async function askThenDelete(sessionId, btn, sourceId = 'local') {
  const t = currentT
  const generation = clientGeneration
  if (pendingDeletes.size || confirmation) return false
  pendingDeletes.add(sessionId)
  btn.disabled = true
  try {
    // Revalidate the target and effective backup setting before confirmation.
    const map = await refreshTitleMap(true)
    if (generation !== clientGeneration) return false
    const row = map.sessions?.find((item) => item.id === sessionId && (item.sourceId || 'local') === sourceId)
    if (row?.readOnly) throw new Error('请先在路径设置中连接此目录所属的 DSH 宿主')
    // 注意：这里**不再**因为 canDetectRunning=false 就拒绝。
    // 0.4.3 会因此直接抛错，导致宿主没暴露 agents 服务时「什么都删不掉」。
    // 真正能不能删，交给 host 的写入所有权判定（409 会带回明确原因）。
    if (!await confirmDeletion(sessionId, row) || generation !== clientGeneration) return false
    btn.dataset.dshdcState = 'deleting'
    btn.title = t('state.deleting')
    notify(t('state.deleting'), { tone: 'busy' })
    const data = await requestJson(`${API_BASE}/sessions`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, ...(sourceId !== 'local' ? { sourceId } : {}) }),
    })
    if (generation !== clientGeneration) return false
    btn.dataset.dshdcState = 'done'
    btn.title = data && data.alreadyGone ? t('state.gone') : t('state.done')
    notify(`${btn.title}${data.backupDir ? `\n${t('manage.backup')}${data.backupDir}` : ''}`, { tone: 'done' })
    try {
      await refreshSessionLists(sourceId === 'local' ? sessionId : undefined)
    } catch {
      if (generation === clientGeneration) notify(t('state.refreshFailed'), { tone: 'error' })
    }
    btn.dataset.dshdcVisible = '0'
    return true
  } catch (error) {
    if (generation !== clientGeneration) return false
    const msg = String((error && error.message) || error)
    btn.dataset.dshdcState = 'failed'
    btn.title = error.name === 'AbortError' ? t('state.timeout') : error.outcomeUnknown ? t('state.unknown') : `${t('state.failed')}: ${msg}`
    notify(`${btn.title}${error.partial ? `\n${t('state.partial')}` : ''}${error.backupDir ? `\n${t('manage.backup')}${error.backupDir}` : ''}`, { tone: 'error' })
    return false
  } finally {
    if (generation === clientGeneration) pendingDeletes.delete(sessionId)
    btn.disabled = false
  }
}

function openManager() {
  const existing = document.getElementById('dshdc-manager')
  if (existing) { existing.focus(); return }
  const generation = clientGeneration
  disposeManager = showConversationManager({
    createDialog, t: currentT, loadSessions: refreshSessionLists, deleteOne: askThenDelete,
    request: requestJson, apiBase: API_BASE,
    beginBatch: () => {
      if (generation !== clientGeneration || pendingDeletes.size || confirmation) return false
      pendingDeletes.add('batch')
      return true
    },
    endBatch: () => {
      if (generation === clientGeneration) pendingDeletes.delete('batch')
    },
  })
  const notice = document.getElementById('dshdc-notice')
  const manager = document.getElementById('dshdc-manager')
  if (notice && manager) manager.appendChild(notice)
}

// ---------------------------------------------------------------- 诊断上报

/**
 * 把客户端状态发给宿主，宿主落到 $DSH_HOME/logs/dsh-chat-prune-client.log。
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

export const inject = ['locale']

export function apply(ctx) {
  if (typeof document === 'undefined' || !document.body) return
  const generation = ++clientGeneration

  if (ctx?.locale && typeof ctx.locale.register === 'function') {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chat-prune: dictionaries')
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
  manage.hidden = window.__dshChatPruneManagerSlotReady__ === true
  manage.setAttribute('aria-haspopup', 'dialog')
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
    if (window.__dshChatPruneNativeSlotReady__) return hide()
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
    version: window.__dshChatPruneBuildVersion__ || 'source' })

  // 自检手柄
  try {
    window.dshChatPrune = {
      status: () => {
        const { source, selectors } = activeSelectors()
        return {
          selectorSource: source,
          selectors,
          apiBase: API_BASE,
          titleMapSize: titleMap.byTitle.size,
          visible: btn.dataset.dshdcVisible === '1',
          current: btn.dataset.dshdcFor || null,
          nativeRowAction: window.__dshChatPruneNativeSlotReady__ === true,
          version: window.__dshChatPruneBuildVersion__ || 'source',
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
      /** 提示条自检/手动清除（排查「提示不消失」时用）。 */
      notice: () => {
        const el = document.getElementById('dshdc-notice')
        return el ? { text: el.textContent || '', tone: el.dataset.tone || null, hidden: el.hidden === true } : null
      },
      dismissNotice,
      notify: (message, options) => notify(message, options),
      reportNativeReady: () => report('nativeRowActionReady', { version: window.__dshChatPruneBuildVersion__ || 'source' }),
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
      if (generation === clientGeneration) {
        clientGeneration++
        pendingDeletes.clear()
        titleRequest = null
        titleMap = { byTitle: new Map(), fetchedAt: 0, sessions: [], config: {} }
        delete window.__dshdcBackupOn
      }
      dismissNotice()
      confirmation?.()
      disposeManager?.()
      disposeManager = null
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
      delete window.dshChatPrune
      window.__dshChatPruneInstalled__ = false
    },
    'dsh-chat-prune: dom cleanup',
  )
}

/* __CJS_EXPORT_START__ */
// 仅供 node 单测（浏览器里没有 module/exports，build-client.mjs 会剥掉 export 关键字）
export default { name, inject, apply }
/* __CJS_EXPORT_END__ */

/* __TEST_SURFACE_START__ */
/**
 * 测试面：把纯函数暴露出来，单测不必搭一整套 DOM。
 * build 时会整段剥掉（浏览器里用不到）。
 */
export const __test__ = {
  normalizeTitle,
  sessionIdOf,
  findRow,
  activeSelectors,
  sessionIdByTitle,
  refreshTitleMap,
  askThenDelete,
  titleMap: () => titleMap,
  setTitleMap: (map) => {
    titleMap = map
  },
  BUILTIN_ROW_SELECTORS,
}
/* __TEST_SURFACE_END__ */
