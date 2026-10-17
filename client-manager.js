import { buildPrunePlan, filterSessions, formatBytes } from './lib/pruning-policy.js'

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
  let rows = [], map = {}, selected = new Set(), page = 0, closed = false, busy = false, stopped = false, retention = null
  let cancelPreview = null
  const pageSize = 50
  const actions = node('div', undefined, 'dshdc-actions')
  const refresh = button(t('manage.refresh'), () => load())
  const close = button(t('manage.close'), () => dialog.close())
  actions.append(dialog.querySelector('h2'), refresh, close)
  const stats = node('p', undefined, 'dshdc-summary')
  const filters = node('div', undefined, 'dshdc-filters')
  const search = node('input')
  search.type = 'search'
  search.placeholder = t('manage.search')
  field(t('manage.search'), search, filters)
  const workspace = select(text('工作区', 'Workspace'), [['', text('全部工作区', 'All workspaces')]], filters)
  const status = select(text('状态', 'Status'), [
    ['', text('全部状态', 'All statuses')], ['active', text('未归档', 'Unarchived')],
    ['archived', text('已归档', 'Archived')], ['pinned', text('已置顶', 'Pinned')],
    ['loaded', t('manage.running')], ['missing', text('记录缺失', 'Missing records')],
  ], filters)
  const sort = select(text('排序', 'Sort'), [
    ['newest', text('最近更新', 'Newest first')], ['oldest', text('最早更新', 'Oldest first')],
    ['largest', text('占用最大', 'Largest first')], ['title', text('标题', 'Title')],
  ], filters)
  const older = number(text('距今至少多少天', 'At least days old'), 0, filters)
  const minimum = number(text('至少占用 MiB', 'Minimum MiB'), 0, filters)
  const rules = node('details', undefined, 'dshdc-rules')
  rules.append(node('summary', text('按保留规则修剪', 'Prune with retention rules')))
  const ruleFields = node('div', undefined, 'dshdc-filters')
  const keep = number(text('每个工作区保留最近条数', 'Keep newest per workspace'), 10, ruleFields)
  const days = number(text('只修剪早于多少天的记录', 'Only prune records older than days'), 30, ruleFields)
  const ruleHint = node('p', text(
    '在当前筛选范围内生成候选，保留条数按整个工作区计算。始终排除置顶、已加载、记录缺失及时间未知的会话。预览不会修改数据。',
    'Generate candidates within these filters; retention counts the whole workspace. Pinned, loaded, missing and unknown-date records are protected. Preview changes no data.'))
  const prune = button(text('生成修剪候选', 'Generate pruning candidates'), () => {
    if (!keep.checkValidity() || !days.checkValidity()) { keep.reportValidity(); days.reportValidity(); return }
    retention = { keepRecent: Number(keep.value), olderDays: Number(days.value) }
    const plan = buildPrunePlan(rows, filtered(), retention)
    selected = new Set(plan.sessions.map((row) => row.id))
    page = 0
    render()
    message.textContent = text(
      `候选 ${selected.size} 条，记录约 ${formatBytes(plan.bytes)}；保护置顶 ${plan.skipped.pinned}、已加载 ${plan.skipped.loaded}、缺失 ${plan.skipped.missing}、最近保留 ${plan.skipped.recent}、未达时间条件 ${plan.skipped.age}。请核对后预览操作。`,
      `${selected.size} candidates, about ${formatBytes(plan.bytes)}. Protected: ${plan.skipped.pinned} pinned, ${plan.skipped.loaded} loaded, ${plan.skipped.missing} missing, ${plan.skipped.recent} retained, ${plan.skipped.age} too recent. Review before proceeding.`)
  })
  rules.append(ruleFields, ruleHint, prune)
  const toolbar = node('div', undefined, 'dshdc-batch-tools')
  const selectPage = button(text('选择本页', 'Select page'), () => {
    retention = null
    for (const row of filtered().slice(page * pageSize, (page + 1) * pageSize)) selected.add(row.id)
    render()
  })
  const selectAll = button(text('选择全部筛选结果', 'Select all filtered'), () => {
    retention = null
    selected = new Set(filtered().map((row) => row.id)); render()
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
  const preview = button(text('预览所选操作', 'Preview selected action'), () => previewBatch())
  const stop = button(text('停止后续任务', 'Stop remaining tasks'), () => {
    stopped = true; stop.disabled = true
    message.textContent = text('正在等待当前请求完成，之后停止。', 'Waiting for the current request, then stopping.')
  })
  stop.hidden = true
  operations.append(preview, stop)
  const hint = node('p', text(
    '更改筛选会清空选择。批量删除始终跳过置顶和已加载会话。归档保留记录但会取消置顶；取消归档不会恢复置顶。',
    'Changing filters clears selection. Batch deletion always skips pinned and loaded sessions. Archiving keeps records and removes pins; unarchiving does not restore pins.'), 'dshdc-hint')
  const message = node('p')
  message.id = 'dshdc-manager-notice'
  message.setAttribute('role', 'status')
  message.setAttribute('aria-live', 'polite')
  const records = node('div')
  const pagination = node('div', undefined, 'dshdc-batch-tools')
  const previous = button(text('上一页', 'Previous'), () => { page--; render() })
  const next = button(text('下一页', 'Next'), () => { page++; render() })
  const pageCaption = node('span')
  pagination.append(previous, pageCaption, next)
  const results = node('div')
  results.id = 'dshdc-results'
  results.tabIndex = -1
  dialog.append(actions, stats, filters, rules, toolbar, operations, hint, message, records, pagination, results)

  function filtered() {
    return filterSessions(rows.map((row) => ({ ...row, title: row.title || t('manage.untitled') })), {
      query: search.value, workspace: workspace.value, status: status.value,
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
      item.dataset.sessionId = row.id
      const checkbox = node('input')
      checkbox.type = 'checkbox'
      checkbox.checked = selected.has(row.id)
      checkbox.disabled = busy
      checkbox.setAttribute('aria-label', text(`选择 ${row.title}`, `Select ${row.title}`))
      checkbox.addEventListener('change', () => {
        retention = null
        if (checkbox.checked) selected.add(row.id)
        else selected.delete(row.id)
        selectedCount.textContent = text(`筛选 ${visible.length} · 已选 ${selected.size}`, `${visible.length} filtered · ${selected.size} selected`)
        preview.disabled = selected.size === 0 || map.managementVersion !== 1
      })
      const selectionTarget = node('label', undefined, 'dshdc-select-target')
      selectionTarget.append(checkbox)
      const label = node('div', undefined, 'dshdc-record-text')
      const date = row.mtime > 0 ? new Date(row.mtime).toLocaleString() : text('更新时间未知', 'Unknown update time')
      label.append(node('strong', row.title), node('div', `${row.workspace} · ${formatBytes(row.bytes)} · ${date}`),
        node('small', row.id))
      const badges = [
        row.archived && text('已归档', 'Archived'), row.pinned && text('已置顶', 'Pinned'),
        row.running && t('manage.running'), row.missing && t('manage.missing'),
      ].filter(Boolean)
      if (badges.length) label.append(node('div', badges.join(' · '), 'dshdc-badges'))
      const remove = button(t('btn.aria'), async () => {
        if (await deleteOne(row.id, remove)) {
          rows = rows.filter((entry) => entry.id !== row.id)
          selected.delete(row.id)
          if (!closed) { const feedback = message.textContent; render(); message.textContent = feedback; search.focus() }
        }
      }, 'dshdc-danger')
      remove.disabled = busy || ((row.running || (map.canDetectRunning === false && !row.missing)) && map.config?.allowRunning !== true)
      item.append(selectionTarget, label, remove)
      records.append(item)
    }
    if (!visible.length) records.append(node('p', t('manage.empty')))
    pageCaption.textContent = `${page + 1} / ${pages}`
    previous.disabled = busy || page === 0
    next.disabled = busy || page + 1 === pages
    preview.disabled = busy || selected.size === 0 || map.managementVersion !== 1
    for (const option of operation.options) option.disabled = option.value !== 'delete' && !map.actions?.includes(option.value)
    if (operation.selectedOptions[0]?.disabled) operation.value = 'delete'
    backup.disabled = busy || map.config?.backup === true
    if (map.config?.backup === true) backup.checked = true
    backupField.parentElement.hidden = operation.value !== 'delete'
  }

  async function load() {
    refresh.disabled = true
    message.textContent = t('manage.loading')
    try {
      map = await loadSessions()
      if (closed) return
      rows = map.sessions || []
      selected = new Set([...selected].filter((id) => rows.some((row) => row.id === id)))
      const oldWorkspace = workspace.value
      workspace.replaceChildren()
      const choices = new Map([['', text('全部工作区', 'All workspaces')]])
      for (const row of rows) choices.set(row.workspaceKey, row.workspace)
      for (const [value, caption] of choices) {
        const option = node('option', caption); option.value = value; workspace.append(option)
      }
      workspace.value = choices.has(oldWorkspace) ? oldWorkspace : ''
      const visibleIds = new Set(filtered().map((row) => row.id))
      selected = new Set([...selected].filter((id) => visibleIds.has(id)))
      render()
      message.textContent = map.managementVersion !== 1 ? t('state.hostOutdated')
        : map.canDetectRunning === false ? t('manage.unknown') : ''
    } catch (error) {
      if (!closed) message.textContent = `${t('state.failed')}: ${error.message}`
    } finally {
      refresh.disabled = busy
    }
  }

  async function previewBatch() {
    if (busy || !selected.size || !beginBatch()) return
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
        .filter((row) => selected.has(row.id))
      const eligible = targets.filter((row) => action !== 'delete' ||
        (!row.pinned && !row.running && (row.missing || map.canDetectRunning !== false)))
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
              ? { sessionId: row.id, backup: useBackup, protectPinned: true, expectedMtime: row.mtime, expectedRevision: row.revision }
              : { sessionId: row.id, action }),
          })
          outcomes.push({ row, state: 'success', detail: response.backupDir ? `${t('manage.backup')}${response.backupDir}` : '' })
          selected.delete(row.id)
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
        results.append(node('p', `${state} · ${outcome.row.title || outcome.row.id}\n${outcome.row.id}${outcome.detail ? `\n${outcome.detail}` : ''}`))
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
    for (const row of targets) list.append(node('p', `${row.title || t('manage.untitled')}\n${row.workspace} · ${row.id}`))
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
    for (const element of dialog.querySelectorAll('input, select, button')) element.disabled = busy
    stop.disabled = false
  }
  for (const element of filters.querySelectorAll('input, select')) {
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
