import { buildPrunePlan, filterSessions, formatBytes, sessionKey } from './lib/pruning-policy.js'

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
  const field = (label, control, parent) => {
    const wrapper = node('label', undefined, 'dshdc-field')
    control.setAttribute('aria-label', label)
    wrapper.append(node('span', label), control)
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
  let cancelPreview = null
  let editingSource = false
  const pageSize = 50
  const actions = node('div', undefined, 'dshdc-actions')
  const refresh = button(t('manage.refresh'), () => load())
  const close = button(t('manage.close'), () => dialog.close())
  actions.append(dialog.querySelector('h2'), refresh, close)
  const stats = node('p', undefined, 'dshdc-summary')
  const sourceTools = node('div', undefined, 'dshdc-source-tools')
  const sourcePanel = node('section', undefined, 'dshdc-source-panel')
  sourcePanel.id = 'dshdc-sources'
  sourcePanel.hidden = true
  const sourceToggle = button(text('管理来源路径', 'Manage source paths'), () => {
    sourcePanel.hidden = !sourcePanel.hidden
    sourceToggle.setAttribute('aria-expanded', String(!sourcePanel.hidden))
  })
  sourceToggle.setAttribute('aria-expanded', 'false')
  sourceToggle.setAttribute('aria-controls', sourcePanel.id)
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
  const sourceFeedback = node('p', undefined, 'dshdc-hint')
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
    sourceFeedback.textContent = text('正在校验路径与连接…', 'Checking path and connection…')
    try {
      await request(`${apiBase}/sources`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: sourceName.value, home: sourceHome.value.trim(),
          endpoint: editingSource && !sourceEndpoint.value.trim() ? undefined : sourceEndpoint.value.trim() }) })
      resetSourceForm()
      sourceFeedback.textContent = text('路径已保存。', 'Path saved.')
      await load()
    } catch (error) { sourceFeedback.textContent = error.message }
    finally {
      busy = false
      if (!closed) { setBusyControls(); render() }
    }
  })
  const filters = node('div', undefined, 'dshdc-filters')
  const search = node('input')
  search.type = 'search'
  search.placeholder = t('manage.search')
  field(t('manage.search'), search, filters)
  const workspace = select(text('工作区', 'Workspace'), [['', text('全部工作区', 'All workspaces')]], filters)
  const source = select(text('来源路径', 'Source path'), [['', text('全部路径', 'All paths')]], filters)
  const advanced = node('div', undefined, 'dshdc-filters')
  advanced.id = 'dshdc-advanced-filters'
  advanced.hidden = true
  const filterTools = node('div', undefined, 'dshdc-filter-tools')
  const advancedToggle = button(text('更多筛选', 'More filters'), () => {
    advanced.hidden = !advanced.hidden
    advancedToggle.setAttribute('aria-expanded', String(!advanced.hidden))
  })
  advancedToggle.setAttribute('aria-expanded', 'false')
  advancedToggle.setAttribute('aria-controls', advanced.id)
  const status = select(text('状态', 'Status'), [
    ['', text('全部状态', 'All statuses')], ['active', text('未归档', 'Unarchived')],
    ['archived', text('已归档', 'Archived')], ['pinned', text('已置顶', 'Pinned')],
    ['loaded', t('manage.running')], ['missing', text('记录缺失', 'Missing records')],
  ], advanced)
  const sort = select(text('排序', 'Sort'), [
    ['newest', text('最近更新', 'Newest first')], ['oldest', text('最早更新', 'Oldest first')],
    ['largest', text('占用最大', 'Largest first')], ['title', text('标题', 'Title')],
  ], advanced)
  const older = number(text('距今至少多少天', 'At least days old'), 0, advanced)
  const minimum = number(text('至少占用 MiB', 'Minimum MiB'), 0, advanced)
  const reset = button(text('重置筛选', 'Reset filters'), () => {
    search.value = ''; workspace.value = ''; source.value = ''; status.value = ''
    sort.value = 'newest'; older.value = '0'; minimum.value = '0'
    selected.clear(); retention = null; page = 0; render(); search.focus()
  })
  filterTools.append(advancedToggle, reset)
  const rules = node('details', undefined, 'dshdc-rules')
  rules.append(node('summary', text('按保留规则修剪', 'Prune with retention rules')))
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
    selected = new Set(plan.sessions.filter((row) => !row.readOnly).map(sessionKey))
    page = 0
    render()
    message.textContent = text(
      `候选 ${selected.size} 条，记录约 ${formatBytes(plan.bytes)}；置顶 ${plan.skipped.pinned}、进行中或受保护 ${plan.skipped.loaded}、缺失 ${plan.skipped.missing}、最近保留 ${plan.skipped.recent}、未达时间条件 ${plan.skipped.age}。请核对后预览操作。`,
      `${selected.size} candidates, about ${formatBytes(plan.bytes)}. Protected: ${plan.skipped.pinned} pinned, ${plan.skipped.loaded} running or protected, ${plan.skipped.missing} missing, ${plan.skipped.recent} retained, ${plan.skipped.age} too recent. Review before proceeding.`)
  })
  rules.append(ruleFields, ruleHint, prune)
  const toolbar = node('div', undefined, 'dshdc-batch-tools')
  const selectPage = button(text('选择本页', 'Select page'), () => {
    retention = null
    for (const row of filtered().slice(page * pageSize, (page + 1) * pageSize)) if (!row.readOnly) selected.add(sessionKey(row))
    render()
  })
  const selectAll = button(text('选择全部筛选结果', 'Select all filtered'), () => {
    retention = null
    selected = new Set(filtered().filter((row) => !row.readOnly).map(sessionKey)); render()
  })
  const clear = button(text('清空选择', 'Clear selection'), () => { selected.clear(); retention = null; render() })
  const selectedCount = node('span')
  toolbar.append(selectPage, selectAll, clear, selectedCount)
  const operations = node('div', undefined, 'dshdc-batch-tools')
  const operation = select(text('批量操作', 'Batch action'), [
    ['archive', text('归档', 'Archive')], ['unarchive', text('取消归档', 'Unarchive')],
    ['pin', text('置顶', 'Pin')], ['unpin', text('取消置顶', 'Unpin')],
    ['delete', text('删除记录', 'Delete records')],
  ], operations)
  const backup = node('input')
  backup.type = 'checkbox'
  backup.checked = true
  const backupField = field(text('删除前备份', 'Back up before deleting'), backup, operations)
  const preview = button(text('预览所选操作', 'Preview selected action'), () => previewBatch(), 'dshdc-primary')
  const stop = button(text('停止后续任务', 'Stop remaining tasks'), () => {
    stopped = true; stop.disabled = true
    message.textContent = text('正在等待当前请求完成，之后停止。', 'Waiting for the current request, then stopping.')
  })
  stop.hidden = true
  operations.append(preview, stop)
  const hint = node('p', text(
    '更改筛选会清空选择。批量删除跳过置顶、进行中和无法安全释放的会话。归档保留记录但会取消置顶；取消归档不会恢复置顶。',
    'Changing filters clears selection. Batch deletion skips pinned, running and unreleasable sessions. Archiving keeps records and removes pins; unarchiving does not restore pins.'), 'dshdc-hint')
  const message = node('div')
  message.id = 'dshdc-manager-notice'
  message.setAttribute('role', 'status')
  message.setAttribute('aria-live', 'polite')
  const records = node('div')
  records.setAttribute('role', 'list')
  const pagination = node('div', undefined, 'dshdc-batch-tools')
  const previous = button(text('上一页', 'Previous'), () => { page--; render() })
  const next = button(text('下一页', 'Next'), () => { page++; render() })
  const pageCaption = node('span')
  pagination.append(previous, pageCaption, next)
  const results = node('div')
  results.id = 'dshdc-results'
  results.tabIndex = -1
  const body = node('div', undefined, 'dshdc-manager-body')
  body.append(stats, sourceTools, sourcePanel, filters, filterTools, advanced, rules, toolbar, hint, message, records, pagination, results)
  dialog.append(actions, body, operations)

  function filtered() {
    return filterSessions(rows.map((row) => ({ ...row, title: row.title || t('manage.untitled') })), {
      query: search.value, workspace: workspace.value, source: source.value, status: status.value,
      sort: sort.value, olderDays: Number(older.value), minMiB: Number(minimum.value),
    })
  }

  function render() {
    const visible = filtered()
    const pages = Math.max(1, Math.ceil(visible.length / pageSize))
    page = Math.max(0, Math.min(page, pages - 1))
    stats.textContent = text(
      `${rows.length} 个对话 · 记录约 ${formatBytes(rows.reduce((sum, row) => sum + row.bytes, 0))} · 已归档 ${rows.filter((row) => row.archived).length} · 已置顶 ${rows.filter((row) => row.pinned).length}`,
      `${rows.length} conversations · about ${formatBytes(rows.reduce((sum, row) => sum + row.bytes, 0))} · ${rows.filter((row) => row.archived).length} archived · ${rows.filter((row) => row.pinned).length} pinned`)
    selectedCount.textContent = text(`筛选 ${visible.length} · 已选 ${selected.size}`, `${visible.length} filtered · ${selected.size} selected`)
    records.replaceChildren()
    for (const row of visible.slice(page * pageSize, (page + 1) * pageSize)) {
      const item = node('div', undefined, 'dshdc-record')
      item.setAttribute('role', 'listitem')
      item.dataset.sessionId = row.id
      item.dataset.sourceId = row.sourceId || 'local'
      const checkbox = node('input')
      checkbox.type = 'checkbox'
      checkbox.checked = selected.has(sessionKey(row))
      checkbox.disabled = busy || row.readOnly
      checkbox.setAttribute('aria-label', text(`选择 ${row.title}`, `Select ${row.title}`))
      checkbox.addEventListener('change', () => {
        retention = null
        if (checkbox.checked) selected.add(sessionKey(row))
        else selected.delete(sessionKey(row))
        selectedCount.textContent = text(`筛选 ${visible.length} · 已选 ${selected.size}`, `${visible.length} filtered · ${selected.size} selected`)
        preview.disabled = selected.size === 0 || map.managementVersion !== 1
      })
      const selectionTarget = node('label', undefined, 'dshdc-select-target')
      selectionTarget.append(checkbox)
      const label = node('div', undefined, 'dshdc-record-text')
      const date = row.mtime > 0 ? new Date(row.mtime).toLocaleString() : text('更新时间未知', 'Unknown update time')
      label.append(node('strong', row.title), node('div', `${row.workspace} · ${formatBytes(row.bytes)} · ${date}`),
        node('small', row.id))
      if (map.sources?.length > 1) label.append(node('small', row.sourceHome, 'dshdc-source-path'))
      const badges = [
        row.archived && text('已归档', 'Archived'), row.pinned && text('已置顶', 'Pinned'),
        row.running && t('manage.running'), row.missing && t('manage.missing'),
        row.releasable && text('已打开 · 空闲可删除', 'Opened · Idle and deletable'),
        row.readOnly && text('未连接宿主 · 仅查看', 'Host disconnected · View only'),
      ].filter(Boolean)
      if (badges.length) label.append(node('div', badges.join(' · '), 'dshdc-badges'))
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
      }, 'dshdc-danger')
      remove.disabled = busy || row.running || row.readOnly
      if (remove.disabled) remove.title = row.readOnly ? text('请先连接此路径的宿主', 'Connect this path to its host first') : t('manage.running')
      item.append(selectionTarget, label, remove)
      records.append(item)
    }
    if (!visible.length) records.append(node('p', t('manage.empty')))
    pageCaption.textContent = `${page + 1} / ${pages}`
    previous.disabled = busy || page === 0
    next.disabled = busy || page + 1 === pages
    preview.disabled = busy || selected.size === 0 || map.managementVersion !== 1
    const operationRows = selected.size ? rows.filter((row) => selected.has(sessionKey(row))) : rows
    for (const option of operation.options) option.disabled = option.value !== 'delete' &&
      !operationRows.some((row) => !row.readOnly && (row.actions || map.actions)?.includes(option.value))
    if (operation.selectedOptions[0]?.disabled) operation.value = 'delete'
    backup.disabled = busy || map.config?.backup === true
    if (map.config?.backup === true) backup.checked = true
    backupField.parentElement.hidden = operation.value !== 'delete'
  }

  async function load() {
    if (loading) return
    loading = true
    setBusyControls()
    message.textContent = t('manage.loading')
    try {
      map = await loadSessions()
      if (closed) return
      rows = map.sessions || []
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
            } catch (error) { sourceFeedback.textContent = error.message }
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
      if (!closed) message.textContent = `${t('state.failed')}: ${error.message}`
    } finally {
      loading = false
      if (!closed) { setBusyControls(); render() }
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
        : (row.actions || map.actions)?.includes(action)))
      const skipped = selected.size - eligible.length
      if (!eligible.length) {
        message.textContent = text('所选会话均已消失或受到保护，没有可执行目标。', 'All selected records are gone or protected; nothing to execute.')
        return
      }
      const label = operation.selectedOptions[0].textContent
      const useBackup = backup.checked || map.config?.backup === true
      if (!await confirmBatch(eligible, { action, label, skipped, useBackup })) return
      stop.hidden = false
      stop.disabled = false
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
          outcomes.push({ row, state: 'success', detail: response.backupDir ? `${t('manage.backup')}${response.backupDir}` : '' })
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
      }
      const successful = outcomes.filter((entry) => entry.state === 'success').length
      const failed = outcomes.filter((entry) => entry.state === 'failed').length
      const unknown = outcomes.filter((entry) => entry.state === 'unknown').length
      const unfinished = eligible.length - outcomes.length
      for (const outcome of outcomes) {
        const state = outcome.state === 'success' ? text('成功', 'Succeeded')
          : outcome.state === 'unknown' ? text('结果未知', 'Outcome unknown') : text('失败', 'Failed')
        results.append(node('p', `${state} · ${outcome.row.title || outcome.row.id}\n${outcome.row.id}${outcome.row.sourceHome ? `\n${outcome.row.sourceHome}` : ''}${outcome.detail ? `\n${outcome.detail}` : ''}`))
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
      if (!closed) message.textContent = `${t('state.failed')}: ${error.message}`
    } finally {
      busy = false
      endBatch()
      if (!closed) { stop.hidden = true; setBusyControls(); render() }
    }
  }

  function confirmBatch(targets, { action, label, skipped, useBackup }) {
    const previewDialog = createDialog(text('批量操作预览', 'Batch preview'))
    previewDialog.id = 'dshdc-batch-preview'
    const bytes = targets.reduce((sum, row) => sum + row.bytes, 0)
    previewDialog.append(node('p', text(
      `${label} ${targets.length} 条，记录约 ${formatBytes(bytes)}；跳过 ${skipped} 条。`,
      `${label} ${targets.length} records, about ${formatBytes(bytes)}; ${skipped} skipped.`)))
    if (action === 'delete') previewDialog.append(node('p', useBackup
      ? text('已开启备份。备份会占用磁盘，本次释放空间可能少于记录大小；恢复仍需离线手动操作。', 'Backup is enabled and uses disk space; reclaimed space may be smaller. Restoration is manual and offline.')
      : text('未开启备份。删除本地记录后无法通过插件撤销。', 'Backup is off. Deleted local records cannot be undone through this plugin.')))
    const list = node('div', undefined, 'dshdc-preview-list')
    for (const row of targets) list.append(node('p', `${row.title || t('manage.untitled')}\n${row.workspace} · ${row.id}${row.sourceHome ? `\n${row.sourceHome}` : ''}`))
    previewDialog.append(list)
    const controls = node('div', undefined, 'dshdc-actions')
    return new Promise((resolve) => {
      let settled = false
      const finish = (answer) => {
        if (settled) return
        settled = true; cancelPreview = null; previewDialog.close(); previewDialog.remove(); resolve(answer)
      }
      cancelPreview = () => finish(false)
      const cancel = button(t('manage.cancel'), () => finish(false))
      const proceed = button(text(`确认${label}`, `Confirm ${label}`), () => finish(true), action === 'delete' ? 'dshdc-danger' : '')
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
  for (const element of [...filters.querySelectorAll('input, select'), ...advanced.querySelectorAll('input, select')]) {
    element.addEventListener(element === search ? 'input' : 'change', () => {
      selected.clear(); retention = null; page = 0; render()
    })
  }
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
