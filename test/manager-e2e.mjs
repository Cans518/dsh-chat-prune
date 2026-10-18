import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as zlib from 'node:zlib'
import { chromium } from 'playwright'
import { apply } from '../lib/index.js'
import { renderFixtureInjections } from './helpers/render-injections.mjs'

test('manager: real HTTP, retention, metadata round trips, protected batches and cancellation', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-prune-manager-'))
  let browser, server, route, inject, gate = null, releaseGate = null, dropNextMutation = false, listGate = null, releaseList = null
  const requests = [], pending = new Set(), loaded = new Set(['session-delete-loaded'])
  const now = Date.now(), day = 86400000
  const data = [
    ['new', 1], ['old', 90], ['delete-a', 90], ['delete-b', 90],
    ['delete-pin', 90], ['delete-loaded', 90], ['stop-a', 90], ['stop-b', 90],
    ['changed', 90], ['unknown-a', 90], ['unknown-b', 90],
    ['other-new', 1, 'other'], ['other-old', 90, 'other'],
  ].map(([name, age, workspace = 'main']) => ({ id: `session-${name}`, title: name, age, workspace }))
  const doc = { global: { pinnedSessionIds: ['session-delete-pin'], archivedSessionIds: [] },
    tables: { workspaces: Object.fromEntries(['main', 'other'].map((key) => [key,
      { title: key, sessionIds: data.filter((row) => row.workspace === key).map((row) => row.id) }])) } }
  const wsPath = join(home, 'storages', 'workspace.json')
  doc.tables.workspaces.main.sessionIds.push('session-missing')
  const fileFor = (row) => join(home, 'sessions', row.workspace, row.id, 'session.v4.jsonl.zstd')
  for (const row of data) {
    const path = fileFor(row)
    await mkdir(join(home, 'sessions', row.workspace, row.id), { recursive: true })
    await writeFile(path, zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session/title', data: { title: row.title } })}\n`)))
    await utimes(path, new Date(now - row.age * day), new Date(now - row.age * day))
  }
  await mkdir(join(home, 'storages'))
  const persist = () => writeFile(wsPath, JSON.stringify(doc))
  await persist()
  const registry = {
    get pinnedSessionIds() { return doc.global.pinnedSessionIds },
    get archivedSessionIds() { return doc.global.archivedSessionIds },
    list: () => Object.entries(doc.tables.workspaces).map(([id, record]) => ({
      id, title: record.title, record,
      async detachSession(sessionId) { record.sessionIds = record.sessionIds.filter((id) => id !== sessionId); await persist() },
    })),
    async archiveSession(id) {
      if (loaded.has(id)) throw Object.assign(new Error('busy'), { name: 'WorkspaceActiveSessionError' })
      doc.global.archivedSessionIds = [...new Set([...this.archivedSessionIds, id])]
      await this.unpinSession(id)
    },
    async unarchiveSession(id) { doc.global.archivedSessionIds = this.archivedSessionIds.filter((value) => value !== id); await persist() },
    async pinSession(id) { doc.global.pinnedSessionIds = [...new Set([...this.pinnedSessionIds, id])]; await persist() },
    async unpinSession(id) { doc.global.pinnedSessionIds = this.pinnedSessionIds.filter((value) => value !== id); await persist() },
  }
  apply({
    profileContext: { home }, workspaceRegistry: registry,
    sessions: { get: (id) => loaded.has(id) ? { id } : undefined },
    sessionPersistence: { async open() { return { async close() {} } } },
    webServer: { register(value) { route = value; return () => {} } },
    on(_name, fn) { inject = fn; return () => {} }, effect: (fn) => fn(),
  }, {})
  const table = []
  inject(table)
  server = createServer((req, res) => {
    const handle = async () => {
      if (req.url.startsWith('/dsh-chat-prune/')) {
        if (req.method === 'GET' && req.url.endsWith('/sessions') && listGate) {
          const waiting = listGate; listGate = null; await waiting
        }
        if (req.method === 'DELETE') {
          requests.push(req.method)
          server.emit('fixture-delete')
          if (gate) { const waiting = gate; gate = null; await waiting }
        }
        if (req.method === 'POST' && req.url.endsWith('/sessions/action') && dropNextMutation) {
          dropNextMutation = false
          await route.handler(req, {
            writeHead(status) { res.writeHead(status, { 'content-type': 'application/json' }) },
            end() { res.end('{') },
          })
        } else {
          await route.handler(req, res)
        }
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(renderFixtureInjections('<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font:16px system-ui"></body></html>', table))
      }
    }
    const promise = handle()
    pending.add(promise)
    promise.finally(() => pending.delete(promise))
  })
  t.after(async () => {
    releaseGate?.()
    releaseList?.()
    await browser?.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await Promise.allSettled([...pending])
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  page.setDefaultTimeout(6000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  t.afterEach(async (context) => {
    if (!context.passed) {
      console.log('Manager failure state:', await page.locator('#dshdc-manager').innerText())
      console.log('Page errors:', errors)
    }
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.locator('#dshdc-manage').click()
  const manager = page.locator('#dshdc-manager')
  await manager.locator('.dshdc-record').first().waitFor()
  await manager.getByRole('button', { name: '更多筛选', exact: true }).click()
  const choose = async (query, action) => {
    await manager.getByRole('searchbox').fill(query)
    await manager.getByRole('button', { name: '选择全部筛选结果', exact: true }).click()
    await manager.getByLabel('批量操作', { exact: true }).selectOption(action)
    await manager.getByRole('button', { name: '预览所选操作', exact: true }).click()
    await page.locator('#dshdc-batch-preview').waitFor()
  }
  const confirm = async (label) => {
    await page.locator('#dshdc-batch-preview').getByRole('button', { name: `确认${label}`, exact: true }).click()
    await page.waitForFunction(() => document.querySelector('#dshdc-manager-notice')?.textContent.includes('完成：'))
  }

  await t.test('composable filters and retention preview protect the newest record of each workspace', async () => {
    await manager.getByLabel('工作区', { exact: true }).selectOption('other')
    assert.equal(await manager.locator('.dshdc-record').count(), 2)
    await manager.getByLabel('至少占用 MiB', { exact: true }).fill('100')
    await manager.getByLabel('至少占用 MiB', { exact: true }).dispatchEvent('change')
    assert.equal(await manager.locator('.dshdc-record').count(), 0)
    await manager.getByLabel('至少占用 MiB', { exact: true }).fill('0')
    await manager.getByLabel('至少占用 MiB', { exact: true }).dispatchEvent('change')
    await manager.getByLabel('工作区', { exact: true }).selectOption('')
    await manager.locator('summary').click()
    await manager.getByLabel('每个工作区保留最近条数', { exact: true }).fill('1')
    await manager.getByRole('button', { name: '生成修剪候选', exact: true }).click()
    const selected = await manager.locator('.dshdc-record:has(input:checked)').evaluateAll((elements) => elements.map((element) => element.dataset.sessionId))
    assert.ok(selected.includes('session-old'))
    assert.ok(selected.includes('session-other-old'))
    assert.equal(selected.includes('session-other-new'), false)
    const changedBeforePreview = fileFor(data.find((row) => row.id === 'session-old'))
    await utimes(changedBeforePreview, new Date(), new Date())
    await manager.getByRole('button', { name: '预览所选操作', exact: true }).click()
    const preview = page.locator('#dshdc-batch-preview')
    await preview.waitFor()
    const content = await preview.innerText()
    for (const id of ['session-new', 'session-other-new', 'session-delete-pin', 'session-delete-loaded']) assert.equal(content.includes(id), false)
    assert.equal(content.includes('session-old'), false, 'Retention is recalculated before showing the final preview')
    assert.match(content, /session-other-old/)
    assert.equal(requests.length, 0)
    await preview.getByRole('button', { name: '取消', exact: true }).click()
  })

  await t.test('archive, unarchive, pin and unpin persist through the manager', async () => {
    for (const [action, label] of [['archive', '归档'], ['unarchive', '取消归档'], ['pin', '置顶'], ['unpin', '取消置顶']]) {
      await choose('session-old', action)
      await confirm(label)
      const disk = JSON.parse(await readFile(wsPath, 'utf8'))
      assert.equal(disk.global.archivedSessionIds.includes('session-old'), action === 'archive')
      assert.equal(disk.global.pinnedSessionIds.includes('session-old'), action === 'pin')
    }
    assert.ok(await readFile(fileFor(data.find((row) => row.id === 'session-old'))))
  })

  await t.test('batch deletion backs up success, skips protected rows and reports a newly loaded failure', async () => {
    await choose('delete-', 'delete')
    assert.match(await page.locator('#dshdc-batch-preview').innerText(), /跳过 2 条/)
    loaded.add('session-delete-b')
    await confirm('删除记录')
    const notice = await manager.locator('#dshdc-manager-notice').innerText()
    assert.match(notice, /成功 1，失败 1，跳过 2/)
    assert.match(await manager.locator('#dshdc-results').innerText(), /已拒绝删除/)
    const backups = await readdir(join(home, 'deleted-sessions'))
    assert.equal(backups.length, 1)
    await assert.rejects(() => readFile(fileFor(data.find((row) => row.id === 'session-delete-a'))), { code: 'ENOENT' })
    for (const id of ['session-delete-b', 'session-delete-pin', 'session-delete-loaded']) {
      assert.ok(await readFile(fileFor(data.find((row) => row.id === id))))
    }
  })

  await t.test('a changed record is refused after confirmation and can be retried after refreshing', async () => {
    await choose('session-changed', 'delete')
    const file = fileFor(data.find((row) => row.id === 'session-changed'))
    await utimes(file, new Date(), new Date())
    await confirm('删除记录')
    assert.match(await manager.locator('#dshdc-manager-notice').innerText(), /成功 0，失败 1/)
    assert.match(await manager.locator('#dshdc-results').innerText(), /预览后发生变化/)
    assert.ok(await readFile(file))
  })

  await t.test('stopping waits for the current delete and never starts the next target', async () => {
    await choose('stop-', 'delete')
    gate = new Promise((resolve) => { releaseGate = resolve })
    const before = requests.length
    await page.locator('#dshdc-batch-preview').getByRole('button', { name: '确认删除记录', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('#dshdc-manager-notice')?.textContent.includes('处理中'))
    // Synchronize against the actual server request, not a delay.
    await new Promise((resolve) => {
      const check = () => requests.length > before ? resolve() : setTimeout(check, 10)
      check()
    })
    await manager.getByRole('button', { name: '停止后续任务', exact: true }).click()
    releaseGate()
    await page.waitForFunction(() => document.querySelector('#dshdc-manager-notice')?.textContent.includes('未执行 1'))
    assert.equal(requests.length, before + 1)
    assert.ok(await readFile(fileFor(data.find((row) => row.id === 'session-stop-b'))))
  })

  await t.test('new controls and preview fit narrow screens and retain the live theme', async () => {
    await page.setViewportSize({ width: 375, height: 700 })
    await choose('session-other-old', 'archive')
    for (const scheme of ['light', 'dark']) {
      await page.evaluate((scheme) => {
        document.documentElement.style.colorScheme = scheme
        document.body.style.setProperty('--dsw-alias-bg-layer-2', scheme === 'dark' ? '#222222' : '#ffffff')
      }, scheme)
      const preview = page.locator('#dshdc-batch-preview')
      assert.equal(await preview.evaluate((element) => getComputedStyle(element).backgroundColor), scheme === 'dark' ? 'rgb(34, 34, 34)' : 'rgb(255, 255, 255)')
      for (const locator of [manager, preview]) {
        const box = await locator.boundingBox()
        assert.ok(box.x >= 0 && box.x + box.width <= 375)
        assert.equal(await locator.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
      }
    }
    await page.locator('#dshdc-batch-preview').getByRole('button', { name: '取消', exact: true }).click()
    if (process.env.DSHDC_SCREENSHOTS) {
      await manager.evaluate((element) => { element.scrollTop = 0 })
      await page.screenshot({ path: '.diagnostics/manager-narrow.png' })
    }
    assert.deepEqual(errors, [])
  })
  await t.test('lost mutation responses are unknown and stop the next operation', async () => {
    await choose('unknown-', 'archive')
    dropNextMutation = true
    await confirm('归档')
    assert.match(await manager.locator('#dshdc-manager-notice').innerText(), /成功 0，失败 0，跳过 0，未执行 1，结果未知 1/)
    assert.match(await manager.locator('#dshdc-results').innerText(), /结果未知/)
    assert.equal(doc.global.archivedSessionIds.includes('session-unknown-a'), true)
    assert.equal(doc.global.archivedSessionIds.includes('session-unknown-b'), false)
  })
  await t.test('refresh removes a selection that no longer matches the current status', async () => {
    await manager.getByRole('searchbox').fill('session-unknown-b')
    await manager.getByLabel('状态', { exact: true }).selectOption('active')
    await manager.locator('.dshdc-record input[type="checkbox"]').check()
    await registry.archiveSession('session-unknown-b')
    await manager.getByRole('button', { name: '刷新列表', exact: true }).click()
    await manager.locator('.dshdc-record').waitFor({ state: 'detached' })
    assert.equal(await manager.getByRole('button', { name: '预览所选操作', exact: true }).isDisabled(), true)
    await manager.getByLabel('状态', { exact: true }).selectOption('')
  })
  await t.test('Escape during preflight cancels before any preview or mutation', async () => {
    await manager.getByRole('searchbox').fill('session-other-old')
    await manager.getByRole('button', { name: '选择全部筛选结果', exact: true }).click()
    listGate = new Promise((resolve) => { releaseList = resolve })
    await manager.getByRole('button', { name: '预览所选操作', exact: true }).click()
    await page.keyboard.press('Escape')
    releaseList()
    await page.waitForFunction(() => !document.querySelector('#dshdc-manager button')?.disabled)
    assert.equal(await page.locator('#dshdc-batch-preview').count(), 0)
    assert.match(await manager.locator('#dshdc-manager-notice').innerText(), /停止/)
  })
  await t.test('missing record cleanup removes only the stale index', async () => {
    await choose('session-missing', 'delete')
    await confirm('删除记录')
    assert.match(await manager.locator('#dshdc-manager-notice').innerText(), /成功 1，失败 0/)
    assert.equal(doc.tables.workspaces.main.sessionIds.includes('session-missing'), false)
    assert.ok(await readFile(fileFor(data.find((row) => row.id === 'session-other-old'))))
  })
  await t.test('pagination preserves page selection and selects all matching records explicitly', async () => {
    for (let index = 0; index < 55; index++) {
      const row = { id: `session-paged-${index}`, title: `paged-${index}`, workspace: 'main' }
      const file = fileFor(row)
      await mkdir(join(home, 'sessions', row.workspace, row.id), { recursive: true })
      await writeFile(file, zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session/title', data: { title: row.title } })}\n`)))
      doc.tables.workspaces.main.sessionIds.push(row.id)
    }
    await persist()
    await manager.getByRole('button', { name: '刷新列表', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('#dshdc-manager button')?.disabled)
    await manager.getByRole('searchbox').fill('paged-')
    assert.equal(await manager.locator('.dshdc-record').count(), 50)
    await manager.getByRole('button', { name: '选择本页', exact: true }).click()
    await manager.getByRole('button', { name: '下一页', exact: true }).click()
    assert.equal(await manager.locator('.dshdc-record').count(), 5)
    assert.equal(await manager.locator('.dshdc-record input:checked').count(), 0)
    await manager.getByRole('button', { name: '选择全部筛选结果', exact: true }).click()
    await manager.getByLabel('批量操作', { exact: true }).selectOption('archive')
    await manager.getByRole('button', { name: '预览所选操作', exact: true }).click()
    await page.locator('#dshdc-batch-preview').waitFor()
    assert.equal(await page.locator('#dshdc-batch-preview .dshdc-preview-list > p').count(), 55)
    await page.locator('#dshdc-batch-preview').getByRole('button', { name: '取消', exact: true }).click()
  })
  await t.test('page disposal cancels an open batch preview and releases the operation guard', async () => {
    await choose('session-other-old', 'archive')
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    assert.equal(await page.locator('#dshdc-layer').count(), 0)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await page.locator('#dshdc-manage').click()
    await manager.locator('.dshdc-record').first().waitFor()
    await choose('session-other-old', 'archive')
    await page.locator('#dshdc-batch-preview').getByRole('button', { name: '取消', exact: true }).click()
    assert.deepEqual(errors, [])
  })
  await t.test('a disposed batch response cannot release the new instance operation guard', async () => {
    const before = requests.length
    gate = new Promise((resolve) => { releaseGate = resolve })
    const started = once(server, 'fixture-delete', { signal: AbortSignal.timeout(6000) })
    await choose('session-paged-0', 'delete')
    await page.evaluate(() => { window.fixtureOldResults = document.querySelector('#dshdc-results') })
    await page.locator('#dshdc-batch-preview').getByRole('button', { name: '确认删除记录', exact: true }).click()
    await started
    assert.equal(requests.length, before + 1)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await page.locator('#dshdc-manage').click()
    await manager.locator('.dshdc-record').first().waitFor()
    await choose('session-paged-54', 'archive')
    releaseGate()
    await page.waitForFunction(() => window.fixtureOldResults.textContent.includes('成功'))
    await page.evaluate(() => {
      window.fixtureSingleResult = 'pending'
      window.dshChatPrune.requestDelete('session-paged-53').then((result) => { window.fixtureSingleResult = result })
    })
    try {
      await page.waitForFunction(() => window.fixtureSingleResult !== 'pending' ||
        document.querySelectorAll('.dshdc-dialog').length > 2)
      assert.equal(await page.evaluate(() => window.fixtureSingleResult), false)
      assert.equal(await page.locator('.dshdc-dialog').count(), 2)
      assert.equal(requests.length, before + 1)
    } finally {
      const single = page.locator('.dshdc-dialog:not(#dshdc-manager):not(#dshdc-batch-preview)')
      if (await single.count()) await single.getByRole('button', { name: '取消', exact: true }).click()
      await page.locator('#dshdc-batch-preview').getByRole('button', { name: '取消', exact: true }).click()
    }
  })
  await t.test('an old host without management protocol support disables batch actions', async () => {
    await page.route('**/dsh-chat-prune/sessions', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const body = await response.json()
      delete body.managementVersion
      await route.fulfill({ response, json: body })
    })
    await manager.getByRole('button', { name: '刷新列表', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('#dshdc-manager-notice')?.textContent.includes('旧版'))
    await manager.getByRole('button', { name: '选择全部筛选结果', exact: true }).click()
    assert.equal(await manager.getByRole('button', { name: '预览所选操作', exact: true }).isDisabled(), true)
    await page.unroute('**/dsh-chat-prune/sessions')
    await manager.getByRole('button', { name: '刷新列表', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('#dshdc-manager button')?.disabled &&
      !document.querySelector('#dshdc-manager-notice')?.textContent.includes('旧版'))
    assert.equal(await manager.getByRole('button', { name: '预览所选操作', exact: true }).isEnabled(), true)
  })
})
