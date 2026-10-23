import { buildPrunePlan, filterSessions, formatBytes, sessionKey } from './lib/pruning-policy.js'

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

export function showConversationManager(services) {
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
