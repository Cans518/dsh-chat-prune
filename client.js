/**
 * dsh-chat-prune — client 入口（构建产物，勿手改）。
 *
 * 由 scripts/build-client.mjs 从 pruning-policy、client-manager 和 client-core.js 生成。
 * 改逻辑请改对应源模块，然后重跑：
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
  if (window.__dshChatPruneInstalled__) return;
  window.__dshChatPruneBuildVersion__ = "0.6.0";

// ---------- begin client-core.js ----------
const DAY_MS = 86400000

function sessionKey(row) {
  return row.key || row.id
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4)
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`
}

function filterSessions(rows, filters = {}, now = Date.now()) {
  const query = (filters.query || '').trim().toLocaleLowerCase()
  return rows.filter((row) => {
    if (query && !`${row.title || ''} ${row.workspace || ''} ${row.id} ${row.sourceName || ''} ${row.sourceHome || ''}`.toLocaleLowerCase().includes(query)) return false
    if (filters.source && row.sourceId !== filters.source) return false
    if (filters.workspace && row.workspaceKey !== filters.workspace) return false
    if (filters.status === 'archived' && !row.archived) return false
    if (filters.status === 'active' && (row.archived || row.missing)) return false
    if (filters.status === 'pinned' && !row.pinned) return false
    if (filters.status === 'loaded' && !row.running) return false
    if (filters.status === 'missing' && !row.missing) return false
    if (filters.olderDays > 0 && (!(row.mtime > 0) || row.mtime >= now - filters.olderDays * DAY_MS)) return false
    if (filters.minMiB > 0 && row.bytes < filters.minMiB * 1024 ** 2) return false
    return true
  }).sort((a, b) => {
    const compared = filters.sort === 'oldest' ? a.mtime - b.mtime
      : filters.sort === 'largest' ? b.bytes - a.bytes
      : filters.sort === 'title' ? (a.title || '').localeCompare(b.title || '')
      : b.mtime - a.mtime
    return compared || sessionKey(a).localeCompare(sessionKey(b))
  })
}

// Rank against the entire workspace before applying the current view's filters.
// Otherwise a search could silently redefine which records count as "recent".
function buildPrunePlan(allRows, candidates, { keepRecent = 10, olderDays = 30, now = Date.now() } = {}) {
  if (!Number.isInteger(keepRecent) || keepRecent < 0 || !Number.isFinite(olderDays) || olderDays < 0) {
    throw new Error('Invalid pruning rule')
  }
  const retained = new Set()
  const counts = new Map()
  for (const row of filterSessions(allRows.filter((entry) => !entry.missing), { sort: 'newest' })) {
    const workspace = row.workspaceKey || row.workspace
    const count = counts.get(workspace) || 0
    if (count < keepRecent || !(row.mtime > 0)) retained.add(sessionKey(row))
    counts.set(workspace, count + 1)
  }
  const selected = []
  const skipped = { pinned: 0, loaded: 0, missing: 0, recent: 0, age: 0 }
  for (const row of candidates) {
    const reason = row.missing ? 'missing' : row.running ? 'loaded' : row.pinned ? 'pinned'
      : retained.has(sessionKey(row)) ? 'recent'
      : !(row.mtime > 0) || row.mtime >= now - olderDays * DAY_MS ? 'age' : null
    if (reason) skipped[reason] += 1
    else selected.push(row)
  }
  return { sessions: selected, skipped, bytes: selected.reduce((sum, row) => sum + row.bytes, 0) }
}


function managerIcon(name) {
  const paths = {
    conversations: 'M4 4h16v12H9l-5 4V4Zm4 4h8M8 12h5',
    search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
    refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1',
    close: 'M6 6l12 12M18 6 6 18',
    folder: 'M3 7h7l2 2h9v11H3V7Zm0 0V4h7l2 3',
    filter: 'M4 6h16M7 12h10M10 18h4',
    shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6',
    trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    arrow: 'M5 12h14m-5-5 5 5-5 5',
    check: 'm5 12 4 4L19 6',
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(key, value)
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', paths[name])
  svg.append(path)
  return svg
}

function showConversationManager(services) {
  const { createDialog, t, loadSessions, deleteOne, request, apiBase, beginBatch, endBatch } = services
  const existing = document.getElementById('dshdc-manager')
  if (existing) { existing.focus(); return }
  const english = t('manage.close') === 'Close'
  const text = (zh, en) => english ? en : zh
  const dialog = createDialog(t('manage.title'))
  dialog.id = 'dshdc-manager'
  const node = (tag, content, className) => {
    const element = document.createElement(tag)
    if (content !== undefined) element.textContent = content
    if (className) element.className = className
    return element
  }
  const button = (label, listener, className) => {
    const element = node('button', label, className)
    element.type = 'button'
    element.addEventListener('click', listener)
    return element
  }
  let fieldIndex = 0
  const field = (label, control, parent) => {
    const wrapper = node('div', undefined, 'dshdc-field')
    control.id = `dshdc-field-${++fieldIndex}`
    control.setAttribute('aria-label', label)
    const caption = node('label', label)
    caption.htmlFor = control.id
    wrapper.append(caption, control)
    parent.append(wrapper)
    return control
  }
  const select = (label, options, parent) => {
    const element = node('select')
    for (const [value, caption] of options) {
      const option = node('option', caption)
      option.value = value
      element.append(option)
    }
    return field(label, element, parent)
  }
  const number = (label, value, parent) => {
    const element = node('input')
    element.type = 'number'
    element.min = '0'
    element.step = '1'
    element.value = value
    return field(label, element, parent)
  }
  let rows = [], map = {}, selected = new Set(), page = 0, closed = false, busy = false, loading = false, stopped = false, retention = null
  let hasLoaded = false, loadError = ''
  let cancelPreview = null, restorePreviewFocus = false
  let editingSource = false
  const pageSize = 50
  const actions = node('div', undefined, 'dshdc-actions dshdc-manager-header')
  const refresh = button(t('manage.refresh'), () => load())
  const close = button(t('manage.close'), () => dialog.close())
  refresh.className = 'dshdc-refresh'
  close.className = 'dshdc-close'
  refresh.title = refresh.textContent
  close.title = close.textContent
  refresh.prepend(managerIcon('refresh'))
  close.prepend(managerIcon('close'))
  const heading = node('div', undefined, 'dshdc-manager-heading')
  const mark = node('span', undefined, 'dshdc-manager-mark')
  mark.append(managerIcon('conversations'))
  const title = node('div')
  dialog.querySelector('h2').title = t('manage.title')
  title.append(dialog.querySelector('h2'), node('p', text('让重要的内容留下来。', 'Make room for the conversations that matter.')))
  heading.append(mark, title)
  actions.append(heading, refresh, close)
  const stats = node('div', undefined, 'dshdc-summary')
  stats.setAttribute('aria-label', text('对话概览', 'Conversation overview'))
  const sourceTools = node('div', undefined, 'dshdc-source-tools')
  const sourcePanel = node('section', undefined, 'dshdc-source-panel')
  sourcePanel.id = 'dshdc-sources'
  sourcePanel.hidden = true
  const sourceToggle = button(text('管理来源路径', 'Manage source paths'), () => {
    sourcePanel.hidden = !sourcePanel.hidden
    sourceToggle.setAttribute('aria-expanded', String(!sourcePanel.hidden))
  })
  sourceToggle.setAttribute('aria-expanded', 'false')
  sourceToggle.className = 'dshdc-source-toggle'
  sourceToggle.title = sourceToggle.textContent
  sourceToggle.setAttribute('aria-controls', sourcePanel.id)
  sourceToggle.prepend(managerIcon('folder'))
  actions.insertBefore(sourceToggle, refresh)
  sourceTools.append(node('span', text('集中查看所有目录，按来源分别执行操作。', 'Browse all directories together; actions stay within their source.')))
  const sourceList = node('div', undefined, 'dshdc-source-list')
  const sourceForm = node('form', undefined, 'dshdc-filters')
  const sourceName = field(text('来源名称', 'Source name'), node('input'), sourceForm)
  const sourceHome = field(text('DSH 数据目录', 'DSH data directory'), node('input'), sourceForm)
  sourceHome.required = true
  sourceHome.placeholder = text('绝对路径，目录内应有 sessions 文件夹', 'Absolute path containing a sessions folder')
  const sourceEndpoint = field(text('所属宿主的本机访问地址（可选）', 'Local host URL (optional)'), node('input'), sourceForm)
  sourceEndpoint.type = 'url'
  sourceEndpoint.placeholder = 'http://127.0.0.1:3000/?token=…'
  const saveSource = node('button', text('保存路径', 'Save path'), 'dshdc-primary')
  saveSource.type = 'submit'
  const cancelEdit = button(text('取消编辑', 'Cancel editing'), resetSourceForm)
  cancelEdit.hidden = true
  const sourceFeedback = node('p', undefined, 'dshdc-hint dshdc-source-feedback')
  sourceFeedback.setAttribute('role', 'status')
  sourceForm.append(saveSource, cancelEdit)
  function resetSourceForm() {
    sourceForm.reset()
    editingSource = false
    sourceHome.readOnly = false
    cancelEdit.hidden = true
    sourceEndpoint.placeholder = 'http://127.0.0.1:3000/?token=…'
  }
  sourcePanel.append(node('h3', text('来源路径', 'Source paths')),
    node('p', text('填写 DSH 数据根目录。连接该目录所属的本机 DSH 宿主后可删除、归档和置顶；未连接时可合并查看与搜索。移除来源只会停止显示，不会删除对话。',
      'Enter a DSH data root. Connect its local DSH host to delete, archive and pin records; disconnected paths support inventory and search. Removing a source keeps its conversations.'), 'dshdc-hint'),
    sourceList, sourceForm, sourceFeedback)
  sourceForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (busy || loading) return
    busy = true
    setBusyControls()
    sourceFeedback.dataset.tone = 'busy'
    sourceFeedback.textContent = text('正在校验路径与连接…', 'Checking path and connection…')
    try {
      await request(`${apiBase}/sources`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: sourceName.value, home: sourceHome.value.trim(),
          endpoint: editingSource && !sourceEndpoint.value.trim() ? undefined : sourceEndpoint.value.trim() }) })
      resetSourceForm()
      sourceFeedback.textContent = text('路径已保存。', 'Path saved.')
      sourceFeedback.dataset.tone = 'done'
      await load()
    } catch (error) {
      sourceFeedback.textContent = error.message
      sourceFeedback.dataset.tone = 'error'
    }
    finally {
      busy = false
      if (!closed) { setBusyControls(); render() }
    }
  })
  const filters = node('div', undefined, 'dshdc-filters dshdc-main-filters')
  const search = node('input')
  search.type = 'search'
  search.placeholder = t('manage.search')
  field(text('搜索对话', 'Search conversations'), search, filters)
  const searchControl = node('div', undefined, 'dshdc-search-control')
  search.replaceWith(searchControl)
  const clearSearch = button(text('清空搜索', 'Clear search'), () => {
    search.value = ''; changeFilters(); search.focus()
  }, 'dshdc-icon-button')
  clearSearch.setAttribute('aria-label', clearSearch.textContent)
  clearSearch.replaceChildren(managerIcon('close'))
  clearSearch.hidden = true
  searchControl.append(managerIcon('search'), search, clearSearch)
  const workspace = select(text('工作区', 'Workspace'), [['', text('全部工作区', 'All workspaces')]], filters)
  const source = select(text('来源路径', 'Source path'), [['', text('全部路径', 'All paths')]], filters)
  const advanced = node('div', undefined, 'dshdc-filters')
  advanced.id = 'dshdc-advanced-filters'
  advanced.hidden = true
  const filterTools = node('div', undefined, 'dshdc-filter-tools')
  const statusFilters = node('div', undefined, 'dshdc-status-filters')
  statusFilters.setAttribute('role', 'group')
  statusFilters.setAttribute('aria-label', text('快速状态筛选', 'Quick status filters'))
  const advancedToggle = button(text('更多筛选', 'More filters'), () => {
    advanced.hidden = !advanced.hidden
    advancedToggle.setAttribute('aria-expanded', String(!advanced.hidden))
    rulesToggle.setAttribute('aria-expanded', String(!advanced.hidden && rules.open))
  })
  advancedToggle.setAttribute('aria-expanded', 'false')
  advancedToggle.setAttribute('aria-controls', advanced.id)
  advancedToggle.prepend(managerIcon('filter'))
  const status = select(text('状态', 'Status'), [
    ['', text('全部状态', 'All statuses')], ['active', text('未归档', 'Unarchived')],
    ['archived', text('已归档', 'Archived')], ['pinned', text('已置顶', 'Pinned')],
    ['loaded', t('manage.running')], ['missing', text('记录缺失', 'Missing records')],
  ], advanced)
  const listSort = node('div', undefined, 'dshdc-list-sort')
  const sort = select(text('排序', 'Sort'), [
    ['newest', text('最近更新', 'Newest first')], ['oldest', text('最早更新', 'Oldest first')],
    ['largest', text('占用最大', 'Largest first')], ['title', text('标题', 'Title')],
  ], listSort)
  const older = number(text('距今至少多少天', 'At least days old'), 0, advanced)
  const minimum = number(text('至少占用 MiB', 'Minimum MiB'), 0, advanced)
  function resetFilters() {
    search.value = ''; workspace.value = ''; source.value = ''; status.value = ''
    sort.value = 'newest'; older.value = '0'; minimum.value = '0'
    selected.clear(); retention = null; page = 0; render(); search.focus()
  }
  const reset = button(text('重置筛选', 'Reset filters'), resetFilters, 'dshdc-text-button')
  reset.setAttribute('aria-label', reset.textContent)
  reset.title = reset.textContent
  reset.prepend(managerIcon('close'))
  const statusChoices = [
    ['', text('全部', 'All'), () => rows.length],
    ['active', text('未归档', 'Unarchived'), () => rows.filter((row) => !row.archived && !row.missing).length],
    ['archived', text('已归档', 'Archived'), () => rows.filter((row) => row.archived).length],
    ['pinned', text('已置顶', 'Pinned'), () => rows.filter((row) => row.pinned).length],
    ['loaded', text('受保护', 'Protected'), () => rows.filter((row) => row.running).length],
    ['missing', text('记录缺失', 'Missing'), () => rows.filter((row) => row.missing).length],
  ].map(([value, label, count]) => {
    const control = button(label, () => { status.value = value; changeFilters() }, 'dshdc-status-filter')
    control.setAttribute('aria-label', text(`筛选：${label}`, `Filter: ${label}`))
    const badge = node('span', '0')
    badge.setAttribute('aria-hidden', 'true')
    control.append(badge)
    statusFilters.append(control)
    return { value, control, badge, count }
  })
  const filterActions = node('div', undefined, 'dshdc-filter-actions')
  filterActions.append(advancedToggle, reset)
  filterTools.append(statusFilters, filterActions)
  const rules = node('details', undefined, 'dshdc-rules')
  rules.id = 'dshdc-retention-rules'
  const ruleSummary = node('summary')
  ruleSummary.append(managerIcon('shield'), node('span', text('按保留规则修剪', 'Prune with retention rules')),
    node('span', text('先生成候选，再预览确认', 'Review candidates before making changes'), 'dshdc-rule-caption'))
  rules.append(ruleSummary)
  const rulesToggle = button(text('保留规则', 'Retention rules'), () => {
    const reveal = advanced.hidden || !rules.open
    advanced.hidden = false
    advancedToggle.setAttribute('aria-expanded', 'true')
    rules.open = reveal
    rulesToggle.setAttribute('aria-expanded', String(reveal))
    if (rules.open) rules.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  })
  rulesToggle.prepend(managerIcon('shield'))
  rulesToggle.setAttribute('aria-label', text('保留规则', 'Retention rules'))
  rulesToggle.title = text('按保留规则修剪', 'Prune with retention rules')
  rulesToggle.setAttribute('aria-expanded', 'false')
  rules.addEventListener('toggle', () => rulesToggle.setAttribute('aria-expanded', String(!advanced.hidden && rules.open)))
  filterActions.insertBefore(rulesToggle, reset)
  advancedToggle.setAttribute('aria-label', text('更多筛选', 'More filters'))
  advancedToggle.title = text('更多筛选', 'More filters')
  const ruleFields = node('div', undefined, 'dshdc-filters')
  const keep = number(text('每个工作区保留最近条数', 'Keep newest per workspace'), 10, ruleFields)
  const days = number(text('只修剪早于多少天的记录', 'Only prune records older than days'), 30, ruleFields)
  const ruleHint = node('p', text(
    '在当前筛选范围内生成候选，保留条数按各来源的整个工作区计算。排除置顶、进行中、无法安全释放、记录缺失及时间未知的会话。预览不会修改数据。',
    'Generate candidates within these filters; retention counts each source workspace. Pinned, running, unreleasable, missing and unknown-date records are protected. Preview changes no data.'))
  const prune = button(text('生成修剪候选', 'Generate pruning candidates'), () => {
    if (!keep.checkValidity() || !days.checkValidity()) { keep.reportValidity(); days.reportValidity(); return }
    retention = { keepRecent: Number(keep.value), olderDays: Number(days.value) }
    const plan = buildPrunePlan(rows, filtered(), retention)
    const candidates = plan.sessions.filter((row) => !row.readOnly)
    selected = new Set(candidates.map(sessionKey))
    page = 0
    render()
    message.textContent = text(
      `候选 ${selected.size} 条，记录约 ${formatBytes(candidates.reduce((sum, row) => sum + row.bytes, 0))}；置顶 ${plan.skipped.pinned}、进行中或受保护 ${plan.skipped.loaded}、缺失 ${plan.skipped.missing}、最近保留 ${plan.skipped.recent}、未达时间条件 ${plan.skipped.age}。请核对后预览操作。`,
      `${selected.size} candidates, about ${formatBytes(candidates.reduce((sum, row) => sum + row.bytes, 0))}. Protected: ${plan.skipped.pinned} pinned, ${plan.skipped.loaded} running or protected, ${plan.skipped.missing} missing, ${plan.skipped.recent} retained, ${plan.skipped.age} too recent. Review before proceeding.`)
  })
  rules.append(ruleFields, ruleHint, prune)
  const compressionPanel = node('details', undefined, 'dshdc-rules')
  compressionPanel.id = 'dshdc-compression'
  compressionPanel.append(node('summary', text('压缩与迁移', 'Compression and transfer')))
  const compressionFields = node('div', undefined, 'dshdc-filters')
  const compressionDays = number(text('多少天未更新后自动压缩（0 为关闭）', 'Auto-compress after days without updates (0 disables)'), 0, compressionFields)
  compressionDays.max = '36500'
  const compressionNotice = node('p', undefined, 'dshdc-hint')
  const runStorageTask = async (work) => {
    if (busy || loading || !beginBatch()) return
    busy = true
    setBusyControls()
    try {
      compressionNotice.textContent = text('正在处理…', 'Working…')
      const result = await work()
      await load()
      compressionNotice.textContent = result
    } catch (error) {
      await load()
      compressionNotice.textContent = error.message + (error.partial
        ? text(`\n已完成 ${error.imported?.length || 0} 条，请检查列表后再重试。`,
          `\n${error.imported?.length || 0} completed. Check the list before retrying.`) : '')
    }
    finally {
      busy = false
      endBatch()
      if (!closed) { setBusyControls(); render() }
    }
  }
  const saveCompression = button(text('保存自动压缩设置', 'Save compression settings'), () => {
    if (!compressionDays.checkValidity()) { compressionDays.reportValidity(); return }
    runStorageTask(async () => {
      await request(`${apiBase}/compression`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ afterDays: Number(compressionDays.value) }) })
      return text('已保存。宿主运行期间每分钟检查一次。', 'Saved. Checks run every minute while the host is running.')
    })
  })
  const runCompression = button(text('立即检查自动压缩', 'Check automatic compression now'), () => runStorageTask(async () => {
    const result = await request(`${apiBase}/compression/run`, { method: 'POST' })
    return text(`已压缩 ${result.compressed} 条，跳过 ${result.skipped} 条，失败 ${result.errors.length} 条。`,
      `${result.compressed} compressed, ${result.skipped} skipped, ${result.errors.length} failed.`) +
      result.errors.map((entry) => `\n${entry.sessionId}: ${entry.error}`).join('')
  }))
  const importFile = field(text('对话压缩包', 'Conversation package'), node('input'), compressionFields)
  importFile.type = 'file'
  importFile.accept = '.gz,application/gzip'
  const importPackage = button(text('导入对话压缩包', 'Import conversation package'), () => {
    const file = importFile.files?.[0]
    if (!file) { compressionNotice.textContent = text('请先选择压缩包。', 'Choose a package first.'); return }
    if (file.size > 64 * 1024 * 1024) { compressionNotice.textContent = text('压缩包不能超过 64 MiB。', 'Packages must be at most 64 MiB.'); return }
    runStorageTask(async () => {
      const result = await request(`${apiBase}/conversations/import`, {
        method: 'POST', headers: { 'content-type': 'application/gzip' }, body: await file.arrayBuffer(),
      })
      importFile.value = ''
      return text(`已导入 ${result.imported.length} 条对话。`, `${result.imported.length} conversations imported.`)
    })
  })
  compressionPanel.append(compressionFields, node('p', text(
    '自动压缩仅作用于当前来源，跳过置顶和受保护的会话。打开对话时自动解压。选择列表中的对话可手动压缩或批量导出；每次导出选择同一来源。导入到当前环境的新工作区，保留标题、内容和附件；已有 ID 会拒绝导入。',
    'Automatic compression applies to this source and skips pinned and protected records. Opening a conversation restores it. Select records to compress or export; export one source at a time. Import restores titles, content and attachments into a local workspace; existing IDs are rejected.'), 'dshdc-hint'),
  saveCompression, runCompression, importPackage, compressionNotice)
  const toolbar = node('div', undefined, 'dshdc-list-toolbar')
  const selectPage = node('input')
  selectPage.type = 'checkbox'
  selectPage.setAttribute('aria-label', text('选择本页', 'Select page'))
  selectPage.addEventListener('change', () => {
    retention = null
    for (const row of filtered().slice(page * pageSize, (page + 1) * pageSize)) {
      if (row.readOnly) continue
      if (selectPage.checked) selected.add(sessionKey(row))
      else selected.delete(sessionKey(row))
    }
    render()
  })
  const pageSelection = node('label', undefined, 'dshdc-page-selection')
  pageSelection.append(selectPage, node('span', text('本页', 'Page')))
  const selectAll = button(text('选择全部筛选结果', 'Select all filtered'), () => {
    retention = null
    selected = new Set(filtered().filter((row) => !row.readOnly).map(sessionKey)); render()
  })
  const clear = button(text('清空选择', 'Clear selection'), () => { selected.clear(); retention = null; render() }, 'dshdc-text-button')
  clear.setAttribute('aria-label', clear.textContent)
  clear.prepend(managerIcon('close'))
  const selectedCount = node('div', undefined, 'dshdc-selected-count')
  selectedCount.setAttribute('aria-live', 'polite')
  const resultCount = node('span', undefined, 'dshdc-result-count')
  const selectionTools = node('div', undefined, 'dshdc-selection-tools')
  selectionTools.append(pageSelection, resultCount, selectAll, clear)
  toolbar.append(selectionTools, listSort)
  const operations = node('footer', undefined, 'dshdc-batch-tools dshdc-operation-bar')
  const selectionSummary = node('div', undefined, 'dshdc-selection-summary')
  const selectionHint = node('span', undefined, 'dshdc-hint')
  selectionSummary.append(selectedCount, selectionHint)
  operations.append(selectionSummary)
  const operation = select(text('批量操作', 'Batch action'), [
    ['archive', text('归档', 'Archive')], ['unarchive', text('取消归档', 'Unarchive')],
    ['pin', text('置顶', 'Pin')], ['unpin', text('取消置顶', 'Unpin')],
    ['delete', text('删除记录', 'Delete records')],
    ['compress', text('压缩记录', 'Compress records')], ['decompress', text('解压记录', 'Decompress records')],
    ['export', text('导出压缩包', 'Export package')],
  ], operations)
  const backup = node('input')
  backup.type = 'checkbox'
  backup.checked = true
  const backupField = field(text('删除前备份', 'Back up before deleting'), backup, operations)
  const preview = button(text('预览所选操作', 'Preview selected action'), () => previewBatch(), 'dshdc-primary')
  preview.append(managerIcon('arrow'))
  const stop = button(text('停止后续任务', 'Stop remaining tasks'), () => {
    stopped = true; stop.disabled = true
    message.textContent = text('正在等待当前请求完成，之后停止。', 'Waiting for the current request, then stopping.')
  }, 'dshdc-stop')
  stop.hidden = true
  operations.append(preview, stop)
  const progress = node('progress')
  progress.setAttribute('aria-label', text('批量操作进度', 'Batch operation progress'))
  const progressLabel = node('span')
  const progressStatus = node('div', undefined, 'dshdc-progress')
  progressStatus.hidden = true
  progressStatus.append(progress, progressLabel)
  operations.append(progressStatus)
  const message = node('div')
  message.id = 'dshdc-manager-notice'
  message.setAttribute('role', 'status')
  message.setAttribute('aria-live', 'polite')
  const records = node('div')
  records.setAttribute('role', 'list')
  records.setAttribute('aria-label', text('对话列表', 'Conversations'))
  const pagination = node('nav', undefined, 'dshdc-pagination')
  pagination.setAttribute('aria-label', text('对话分页', 'Conversation pages'))
  const previous = button(text('上一页', 'Previous'), () => { page--; render() })
  const next = button(text('下一页', 'Next'), () => { page++; render() })
  const pageCaption = node('span')
  const pageRange = node('span', undefined, 'dshdc-page-range')
  const pageControls = node('div')
  pageControls.append(previous, pageCaption, next)
  pagination.append(pageRange, pageControls)
  const results = node('div')
  results.id = 'dshdc-results'
  results.tabIndex = -1
  const body = node('div', undefined, 'dshdc-manager-body')
  const controls = node('div', undefined, 'dshdc-manager-controls')
  advanced.append(rules)
  controls.append(stats, sourceTools, sourcePanel, filters, filterTools, advanced, compressionPanel)
  const listSection = node('section', undefined, 'dshdc-list-section')
  const listScroller = node('div', undefined, 'dshdc-records-scroll')
  listScroller.tabIndex = 0
  listScroller.setAttribute('aria-label', text('滚动浏览对话', 'Browse conversations'))
  listScroller.append(records, results)
  listSection.append(toolbar, listScroller, pagination)
  body.append(controls, message, listSection)
  dialog.append(actions, body, operations)

  function filtered() {
    return filterSessions(rows.map((row) => ({ ...row, title: row.title || t('manage.untitled') })), {
      query: search.value, workspace: workspace.value, source: source.value, status: status.value,
      sort: sort.value, olderDays: Number(older.value), minMiB: Number(minimum.value),
    })
  }

  function changeFilters() {
    selected.clear()
    retention = null
    page = 0
    render()
    listScroller.scrollTop = 0
  }

  function updateSelection(visible = filtered()) {
    const chosen = rows.filter((row) => selected.has(sessionKey(row)))
    const chosenBytes = formatBytes(chosen.reduce((sum, row) => sum + row.bytes, 0))
    selectedCount.textContent = selected.size
      ? text(`已选择 ${selected.size} 条 · ${chosenBytes}`, `${selected.size} selected · ${chosenBytes}`)
      : text('尚未选择对话', 'No conversations selected')
    selectionHint.textContent = selected.size
      ? operation.value === 'delete'
        ? text('删除前预览；置顶和受保护的对话会跳过。', 'Preview first. Pinned and protected records are skipped.')
        : text('预览并确认后执行，更改筛选会清空选择。', 'Review before applying. Changing filters clears selection.')
      : text('勾选记录，选择操作，再预览确认。', 'Select conversations and an action, then review.')
    resultCount.textContent = text(`筛选 ${visible.length} 条`, `${visible.length} results`)
    const eligible = visible.slice(page * pageSize, (page + 1) * pageSize).filter((row) => !row.readOnly)
    const count = eligible.filter((row) => selected.has(sessionKey(row))).length
    selectPage.checked = eligible.length > 0 && count === eligible.length
    selectPage.indeterminate = count > 0 && count < eligible.length
    selectPage.disabled = busy || loading || !eligible.length
    selectAll.disabled = busy || loading || !visible.some((row) => !row.readOnly)
    clear.disabled = busy || loading || !selected.size
    preview.disabled = busy || loading || !selected.size || map.managementVersion !== 1
    const operationRows = chosen.length ? chosen : rows
    if (hasLoaded) {
      for (const option of operation.options) option.disabled = option.value !== 'delete' &&
        !operationRows.some((row) => !row.readOnly && (row.actions || map.actions)?.includes(option.value))
      if (operation.selectedOptions[0]?.disabled) operation.value = 'delete'
    }
    backup.disabled = busy || loading || map.config?.backup === true
    if (map.config?.backup === true) backup.checked = true
    backupField.parentElement.hidden = operation.value !== 'delete'
    operations.dataset.hasSelection = String(selected.size > 0)
  }

  function render() {
    const visible = filtered()
    const pages = Math.max(1, Math.ceil(visible.length / pageSize))
    page = Math.max(0, Math.min(page, pages - 1))
    stats.replaceChildren()
    for (const [label, value] of [
      [text('全部对话', 'Conversations'), rows.length],
      [text('记录占用', 'Record size'), formatBytes(rows.reduce((sum, row) => sum + row.bytes, 0))],
      [text('已归档', 'Archived'), rows.filter((row) => row.archived).length],
      [text('已置顶', 'Pinned'), rows.filter((row) => row.pinned).length],
    ]) {
      const metric = node('div', undefined, 'dshdc-metric')
      metric.append(node('span', label), node('strong', !hasLoaded ? '—' : String(value)))
      stats.append(metric)
    }
    sourceTools.hidden = (map.sources || []).length <= 1
    for (const choice of statusChoices) {
      choice.control.setAttribute('aria-pressed', String(status.value === choice.value))
      choice.badge.textContent = String(choice.count())
    }
    clearSearch.hidden = !search.value
    for (const control of [compressionDays, importFile, saveCompression, runCompression, importPackage]) {
      control.disabled = busy || loading || !map.compression
    }
    records.replaceChildren()
    for (const row of visible.slice(page * pageSize, (page + 1) * pageSize)) {
      const item = node('div', undefined, 'dshdc-record')
      item.setAttribute('role', 'listitem')
      item.dataset.sessionId = row.id
      item.dataset.sourceId = row.sourceId || 'local'
      item.dataset.selected = String(selected.has(sessionKey(row)))
      item.dataset.readonly = String(Boolean(row.readOnly))
      const checkbox = node('input')
      checkbox.type = 'checkbox'
      checkbox.id = `dshdc-select-${row.sourceId || 'local'}-${row.id}`
      checkbox.checked = selected.has(sessionKey(row))
      checkbox.disabled = busy || row.readOnly
      checkbox.setAttribute('aria-label', text(`选择 ${row.title}`, `Select ${row.title}`))
      checkbox.addEventListener('change', () => {
        retention = null
        if (checkbox.checked) selected.add(sessionKey(row))
        else selected.delete(sessionKey(row))
        item.dataset.selected = String(checkbox.checked)
        updateSelection()
      })
      const selectionTarget = node('label', undefined, 'dshdc-select-target')
      selectionTarget.append(checkbox)
      const label = node('label', undefined, 'dshdc-record-text')
      label.htmlFor = checkbox.id
      const date = row.mtime > 0 ? new Date(row.mtime).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }) : text('更新时间未知', 'Unknown update time')
      const recordTitle = node('strong', row.title)
      recordTitle.title = row.title
      const titleLine = node('div', undefined, 'dshdc-record-title')
      titleLine.append(recordTitle)
      const metadata = node('div', undefined, 'dshdc-record-meta')
      const workspaceName = node('span', row.workspace)
      workspaceName.prepend(managerIcon('folder'))
      metadata.append(workspaceName, node('span', date))
      const identifier = node('small', row.id, 'dshdc-record-id')
      identifier.title = row.id
      const identity = node('div', undefined, 'dshdc-record-identity')
      identity.append(identifier)
      label.append(titleLine, metadata, identity)
      if (map.sources?.length > 1) {
        const path = node('small', row.sourceName || text('当前数据目录', 'Current directory'), 'dshdc-source-path')
        path.title = row.sourceHome
        path.setAttribute('aria-label', `${path.textContent}: ${row.sourceHome}`)
        identity.append(path)
      }
      const badges = [
        row.compressed && ['compressed', text('已压缩', 'Compressed')],
        row.archived && ['archived', text('已归档', 'Archived')],
        row.pinned && ['pinned', text('已置顶', 'Pinned')],
        row.running && ['protected', t('manage.running')],
        row.missing && ['missing', t('manage.missing')],
        row.releasable && ['idle', text('已打开 · 空闲可删除', 'Opened · Idle and deletable')],
        row.readOnly && ['readonly', text('未连接宿主 · 仅查看', 'Host disconnected · View only')],
      ].filter(Boolean)
      if (badges.length) {
        const badgeList = node('span', undefined, 'dshdc-badges')
        for (const [kind, caption] of badges) {
          const badge = node('span', caption, 'dshdc-badge')
          badge.dataset.kind = kind
          badgeList.append(badge)
        }
        titleLine.append(badgeList)
      }
      const remove = button(t('btn.aria'), async () => {
        if (busy) return
        busy = true
        setBusyControls()
        try {
          if (await deleteOne(row.id, remove, row.sourceId || 'local')) {
            rows = rows.filter((entry) => sessionKey(entry) !== sessionKey(row))
            selected.delete(sessionKey(row))
          }
        } finally {
          busy = false
          if (!closed) { setBusyControls(); render(); search.focus() }
        }
      }, 'dshdc-danger dshdc-record-remove')
      remove.setAttribute('aria-label', t('btn.aria'))
      remove.title = t('btn.aria')
      remove.replaceChildren(managerIcon('trash'))
      remove.disabled = busy || row.running || row.readOnly
      if (remove.disabled) remove.title = row.readOnly ? text('请先连接此路径的宿主', 'Connect this path to its host first') : t('manage.running')
      const size = node('div', formatBytes(row.bytes), 'dshdc-record-size')
      size.title = text(`${row.files || 0} 个文件`, `${row.files || 0} files`)
      const rowActions = node('div', undefined, 'dshdc-record-actions')
      rowActions.append(size, remove)
      item.append(selectionTarget, label, rowActions)
      records.append(item)
    }
    if (!visible.length) {
      const empty = node('div', undefined, 'dshdc-empty')
      const initialLoading = loading && !hasLoaded
      empty.append(managerIcon(initialLoading ? 'refresh' : 'search'), node('strong', initialLoading
        ? text('正在读取对话…', 'Loading conversations…') : loadError
        ? text('暂时无法读取对话', 'Conversations could not be loaded') : rows.length
        ? text('没有匹配的对话', 'No matching conversations') : text('这里还没有对话', 'No conversations yet')),
      node('p', initialLoading ? text('正在检查来源与记录，请稍候。', 'Checking sources and records. Please wait.') : loadError
        ? text('请检查宿主连接，然后重新加载。', 'Check the host connection and try again.') : rows.length
        ? text('试试其他关键词，或清除筛选条件。', 'Try another search or clear your filters.')
        : text('添加来源路径，或在 DSH 中创建对话后刷新。', 'Add a source path, or create a conversation in DSH and refresh.')))
      if (loadError && !loading) empty.append(button(text('重新加载', 'Retry loading'), () => load()))
      else if (rows.length) empty.append(button(text('清除筛选条件', 'Clear filters'), resetFilters))
      records.append(empty)
    }
    pageCaption.textContent = `${page + 1} / ${pages}`
    pageRange.textContent = visible.length
      ? text(`显示 ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, visible.length)} 条，共 ${visible.length} 条`,
        `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, visible.length)} of ${visible.length}`)
      : text('没有符合条件的记录', 'No matching records')
    previous.disabled = busy || page === 0
    next.disabled = busy || page + 1 === pages
    updateSelection(visible)
  }

  async function load() {
    if (loading) return
    const initial = !hasLoaded
    const focusedBeforeLoad = document.activeElement
    loading = true
    loadError = ''
    refresh.dataset.loading = 'true'
    setBusyControls()
    message.textContent = t('manage.loading')
    if (!hasLoaded) render()
    try {
      map = await loadSessions()
      if (closed) return
      rows = map.sessions || []
      compressionDays.value = String(map.compression?.afterDays || 0)
      hasLoaded = true
      sourceList.replaceChildren()
      for (const entry of map.sources || []) {
        const item = node('div', undefined, 'dshdc-source-row')
        const description = node('div')
        description.append(node('strong', entry.name), node('small', entry.home),
          node('small', entry.error || (entry.connected ? text('已连接宿主', 'Host connected') : text('仅查看 · 可填写宿主地址启用操作', 'View only · Add host URL to enable actions'))))
        item.append(description)
        if (entry.id !== 'local') {
          item.append(button(text('编辑', 'Edit'), () => {
            if (busy || loading) return
            editingSource = true
            sourceHome.readOnly = true
            cancelEdit.hidden = false
            sourceName.value = entry.name; sourceHome.value = entry.home
            sourceEndpoint.placeholder = text('留空保留现有连接', 'Leave empty to keep the connection')
            sourceEndpoint.value = ''; sourceEndpoint.focus()
          }))
          item.append(button(text('移除来源', 'Remove source'), async () => {
            if (busy || loading) return
            busy = true
            setBusyControls()
            try {
              await request(`${apiBase}/sources`, { method: 'DELETE', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sourceId: entry.id }) })
              await load()
            } catch (error) {
              sourceFeedback.textContent = error.message
              sourceFeedback.dataset.tone = 'error'
            }
            finally {
              busy = false
              if (!closed) { setBusyControls(); render() }
            }
          }))
        }
        sourceList.append(item)
      }
      selected = new Set([...selected].filter((id) => rows.some((row) => sessionKey(row) === id)))
      const oldSource = source.value
      source.replaceChildren()
      for (const entry of [{ id: '', name: text('全部路径', 'All paths') }, ...(map.sources || [])]) {
        const option = node('option', entry.name); option.value = entry.id; source.append(option)
      }
      source.value = (map.sources || []).some((entry) => entry.id === oldSource) ? oldSource : ''
      const oldWorkspace = workspace.value
      workspace.replaceChildren()
      const choices = new Map([['', text('全部工作区', 'All workspaces')]])
      for (const row of rows) choices.set(row.workspaceKey, row.workspace)
      for (const [value, caption] of choices) {
        const option = node('option', caption); option.value = value; workspace.append(option)
      }
      workspace.value = choices.has(oldWorkspace) ? oldWorkspace : ''
      const visibleIds = new Set(filtered().map(sessionKey))
      selected = new Set([...selected].filter((id) => visibleIds.has(id)))
      render()
      message.textContent = [map.managementVersion !== 1 ? t('state.hostOutdated')
        : map.canDetectRunning === false ? t('manage.unknown') : '',
      ...(map.sources || []).filter((entry) => entry.error).map((entry) => `${entry.name}: ${entry.error}`)].filter(Boolean).join('\n')
    } catch (error) {
      if (!closed) {
        loadError = error.message
        message.textContent = text(`读取对话失败：${error.message}`, `Could not load conversations: ${error.message}`)
      }
    } finally {
      loading = false
      refresh.dataset.loading = 'false'
      if (!closed) {
        setBusyControls()
        render()
        if (!busy && [document.body, dialog].includes(document.activeElement)) {
          if (initial) (loadError ? records.querySelector('button') : search)?.focus({ preventScroll: true })
          else if (focusedBeforeLoad === refresh) refresh.focus({ preventScroll: true })
        }
      }
    }
  }

  async function previewBatch() {
    if (busy || loading || !selected.size || !beginBatch()) return
    busy = true
    stopped = false
    setBusyControls()
    try {
      map = await loadSessions()
      rows = map.sessions || []
      if (closed || stopped) return
      if (map.managementVersion !== 1) throw new Error(t('state.hostOutdated'))
      const action = operation.value
      const targets = (retention ? buildPrunePlan(rows, filtered(), retention).sessions : filtered())
        .filter((row) => selected.has(sessionKey(row)))
      const eligible = targets.filter((row) => !row.readOnly && (action === 'delete'
        ? !row.pinned && !row.running
        : (row.actions || map.actions)?.includes(action) &&
          (!['compress', 'decompress', 'export'].includes(action) || !row.running) &&
          (action !== 'compress' || !row.compressed) && (action !== 'decompress' || row.compressed)))
      const skipped = selected.size - eligible.length
      if (!eligible.length) {
        message.textContent = text('所选会话均已消失或受到保护，没有可执行目标。', 'All selected records are gone or protected; nothing to execute.')
        return
      }
      const label = operation.selectedOptions[0].textContent
      const useBackup = backup.checked || map.config?.backup === true
      if (!await confirmBatch(eligible, { action, label, skipped, useBackup })) return
      if (action === 'export') {
        const sourceIds = new Set(eligible.map((row) => row.sourceId || 'local'))
        if (sourceIds.size !== 1) throw new Error(text('请每次选择同一来源的对话导出。', 'Select one source per export.'))
        const result = await request(`${apiBase}/conversations/export`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionIds: eligible.map((row) => row.id), sourceId: [...sourceIds][0] }),
        })
        const bytes = Uint8Array.from(atob(result.archive), (char) => char.charCodeAt(0))
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/gzip' }))
        const anchor = node('a')
        anchor.href = url
        anchor.download = result.filename
        dialog.append(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 60000)
        message.textContent = text(`已导出 ${eligible.length} 条对话。`, `${eligible.length} conversations exported.`)
        return
      }
      stop.hidden = false
      stop.disabled = false
      progressStatus.hidden = false
      progress.max = eligible.length
      progress.value = 0
      progressLabel.textContent = `0 / ${eligible.length}`
      stop.focus({ preventScroll: true })
      results.replaceChildren()
      const outcomes = []
      for (const row of eligible) {
        if (stopped || closed || !dialog.isConnected) break
        message.textContent = text(`处理中 ${outcomes.length + 1} / ${eligible.length}：${row.title || row.id}`, `Processing ${outcomes.length + 1} / ${eligible.length}: ${row.title || row.id}`)
        try {
          const response = await request(`${apiBase}/sessions${action === 'delete' ? '' : '/action'}`, {
            method: action === 'delete' ? 'DELETE' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(action === 'delete'
              ? { sessionId: row.id, sourceId: row.sourceId, backup: useBackup, protectPinned: true, expectedMtime: row.mtime, expectedRevision: row.revision }
              : { sessionId: row.id, sourceId: row.sourceId, action }),
          })
          outcomes.push({ row, state: 'success', detail: response.skipped === 'noSpaceSaved'
            ? text('原记录已压缩，进一步压缩无法节省空间。', 'Further compression would not save space.')
            : response.backupDir ? `${t('manage.backup')}${response.backupDir}` : '' })
          selected.delete(sessionKey(row))
        } catch (error) {
          const unknown = error.outcomeUnknown === true || error.name === 'AbortError'
          outcomes.push({ row, state: unknown ? 'unknown' : 'failed', detail: [
            error.name === 'AbortError' ? t('state.timeout') : unknown ? t('state.unknown') : error.message,
            error.partial && t('state.partial'), error.backupDir && `${t('manage.backup')}${error.backupDir}`,
          ].filter(Boolean).join('\n') })
          // A lost response cannot establish whether the mutation committed.
          if (unknown) stopped = true
        }
        progress.value = outcomes.length
        progressLabel.textContent = `${outcomes.length} / ${eligible.length}`
      }
      const successful = outcomes.filter((entry) => entry.state === 'success').length
      const failed = outcomes.filter((entry) => entry.state === 'failed').length
      const unknown = outcomes.filter((entry) => entry.state === 'unknown').length
      const unfinished = eligible.length - outcomes.length
      for (const outcome of outcomes) {
        const state = outcome.state === 'success' ? text('成功', 'Succeeded')
          : outcome.state === 'unknown' ? text('结果未知', 'Outcome unknown') : text('失败', 'Failed')
        const result = node('p', `${state} · ${outcome.row.title || outcome.row.id}\n${outcome.row.id}${outcome.row.sourceHome ? `\n${outcome.row.sourceHome}` : ''}${outcome.detail ? `\n${outcome.detail}` : ''}`)
        result.dataset.state = outcome.state
        results.append(result)
      }
      const summary = text(
        `${label}完成：成功 ${successful}，失败 ${failed}，跳过 ${skipped}，未执行 ${unfinished}${unknown ? `，结果未知 ${unknown}` : ''}。`,
        `${label}: ${successful} succeeded, ${failed} failed, ${skipped} skipped, ${unfinished} not started${unknown ? `, ${unknown} unknown` : ''}.`)
      if (!closed && dialog.isConnected) {
        await load()
        message.textContent = `${summary}${message.textContent ? `\n${message.textContent}` : ''}`
        results.focus()
      }
    } catch (error) {
      if (!closed) message.textContent = text(`操作未完成：${error.message}`, `Operation could not be completed: ${error.message}`)
    } finally {
      busy = false
      endBatch()
      if (!closed) {
        stop.hidden = true
        progressStatus.hidden = true
        setBusyControls()
        render()
        if (restorePreviewFocus) { preview.focus({ preventScroll: true }); restorePreviewFocus = false }
      }
    }
  }

  function confirmBatch(targets, { action, label, skipped, useBackup }) {
    const previewDialog = createDialog(text('批量操作预览', 'Batch preview'))
    previewDialog.id = 'dshdc-batch-preview'
    previewDialog.dataset.action = action
    const previewBody = node('div', undefined, 'dshdc-preview-body')
    const bytes = targets.reduce((sum, row) => sum + row.bytes, 0)
    previewBody.append(node('p', text(
      `${label} ${targets.length} 条，记录约 ${formatBytes(bytes)}；跳过 ${skipped} 条。`,
      `${label} ${targets.length} records, about ${formatBytes(bytes)}; ${skipped} skipped.`)))
    if (action === 'delete') previewBody.append(node('p', useBackup
      ? text('已开启备份。备份会占用磁盘，本次释放空间可能少于记录大小；恢复仍需离线手动操作。', 'Backup is enabled and uses disk space; reclaimed space may be smaller. Restoration is manual and offline.')
      : text('未开启备份。删除本地记录后无法通过插件撤销。', 'Backup is off. Deleted local records cannot be undone through this plugin.'),
    'dshdc-preview-warning'))
    const list = node('div', undefined, 'dshdc-preview-list')
    for (const row of targets) list.append(node('p', `${row.title || t('manage.untitled')}\n${row.workspace} · ${row.id}${row.sourceHome ? `\n${row.sourceHome}` : ''}`))
    previewBody.append(list)
    previewDialog.append(previewBody)
    const controls = node('div', undefined, 'dshdc-actions')
    return new Promise((resolve) => {
      let settled = false
      const finish = (answer) => {
        if (settled) return
        settled = true
        restorePreviewFocus = !answer && !closed
        cancelPreview = null
        previewDialog.close()
        previewDialog.remove()
        resolve(answer)
      }
      cancelPreview = () => finish(false)
      const cancel = button(t('manage.cancel'), () => finish(false))
      const proceed = button(text(`确认${label}`, `Confirm ${label}`), () => finish(true), action === 'delete' ? 'dshdc-danger' : 'dshdc-primary')
      controls.append(cancel, proceed)
      previewDialog.append(controls)
      previewDialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false) })
      previewDialog.addEventListener('close', () => finish(false))
      previewDialog.showModal()
      cancel.focus()
    })
  }

  function setBusyControls() {
    dialog.setAttribute('aria-busy', String(busy || loading))
    for (const element of dialog.querySelectorAll('input, select, button')) element.disabled = busy || loading
    close.disabled = busy
    stop.disabled = stopped || loading
  }
  for (const element of [search, workspace, source, status, older, minimum]) {
    element.addEventListener(element === search ? 'input' : 'change', changeFilters)
  }
  sort.addEventListener('change', () => { page = 0; render(); listScroller.scrollTop = 0 })
  for (const control of [keep, days]) control.addEventListener('input', () => {
    if (!retention) return
    retention = null
    selected.clear()
    render()
    message.textContent = text('规则已更改，请重新生成修剪候选。', 'Rules changed. Generate pruning candidates again.')
  })
  dialog.addEventListener('keydown', (event) => {
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey &&
        !event.target.closest('input, select, textarea, [contenteditable="true"]')) {
      event.preventDefault()
      search.focus()
    }
  })
  operation.addEventListener('change', render)
  dialog.addEventListener('cancel', (event) => {
    if (busy) { event.preventDefault(); stopped = true; message.textContent = text('当前请求完成后停止。', 'Stopping after the current request.') }
  })
  dialog.addEventListener('close', () => { closed = true; stopped = true; dialog.remove() })
  if (typeof dialog.showModal !== 'function') { dialog.remove(); return }
  dialog.showModal()
  search.focus()
  load()
  return () => {
    closed = true
    stopped = true
    cancelPreview?.()
    dialog.close()
    dialog.remove()
  }
}

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
      error.imported = data?.imported
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
      compression: data.compression,
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

const inject = ['locale']

function apply(ctx) {
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
    if (window.__dshChatPruneInstalled__ || !document.body) return;
    try {
      apply(hostCtx);
      window.__dshChatPruneInstalled__ = true;
      console.info("[dsh-chat-prune] client installed");
    } catch (error) {
      window.__dshChatPruneInstalled__ = false;
      console.error("[dsh-chat-prune] client apply failed:", error);
    }
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) start();
  });
})();
