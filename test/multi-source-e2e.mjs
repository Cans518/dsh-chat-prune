import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { apply } from '../lib/index.js'
import { renderFixtureInjections } from './helpers/render-injections.mjs'

test('source settings persist and identical IDs stay independent through browser selection, preview and deletion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-multi-browser-'))
  const servers = []
  let browser
  t.after(async () => {
    await browser?.close()
    await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })))
    await rm(root, { recursive: true, force: true })
  })
  async function host(name, withManagement = false) {
    const home = join(root, name), dir = join(home, 'sessions', 'workspace', 'session-same')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'record'), name)
    const metadata = { global: { pinnedSessionIds: [], archivedSessionIds: [] } }
    const persist = async () => {
      await mkdir(join(home, 'storages'), { recursive: true })
      await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify(metadata))
    }
    const registry = {
      get pinnedSessionIds() { return metadata.global.pinnedSessionIds },
      get archivedSessionIds() { return metadata.global.archivedSessionIds },
      list: () => [],
      async pinSession(id) { metadata.global.pinnedSessionIds = [...new Set([...this.pinnedSessionIds, id])]; await persist() },
      async unpinSession(id) { metadata.global.pinnedSessionIds = this.pinnedSessionIds.filter((value) => value !== id); await persist() },
      async archiveSession(id) { metadata.global.archivedSessionIds = [...new Set([...this.archivedSessionIds, id])]; await this.unpinSession(id) },
      async unarchiveSession(id) { metadata.global.archivedSessionIds = this.archivedSessionIds.filter((value) => value !== id); await persist() },
    }
    let route, injection
    apply({ profileContext: { home }, sessions: { get: () => undefined },
      ...(withManagement ? { workspaceRegistry: registry } : {}),
      sessionPersistence: { async open() { return { async close() {} } } },
      webServer: { register(value) { route = value; return () => {} } },
      effect: (fn) => fn(), on(_name, callback) { injection = callback; return () => {} },
    }, {})
    const table = []; injection(table)
    const server = createServer((req, res) => {
      if (req.url.startsWith('/dsh-chat-prune/')) { route.handler(req, res); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderFixtureInjections('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font:16px system-ui"></body></html>', table))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    return { home, dir, url: `http://127.0.0.1:${server.address().port}/` }
  }
  const a = await host('Current'), b = await host('Second', true), offline = await host('Offline')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(a.url)
  await page.locator('#dshdc-manage').click()
  const manager = page.locator('#dshdc-manager')
  await manager.locator('.dshdc-record').waitFor()
  await manager.getByRole('button', { name: '管理来源路径', exact: true }).click()
  async function addSource(name, home, endpoint = '') {
    await manager.getByLabel('来源名称', { exact: true }).fill(name)
    await manager.getByLabel('DSH 数据目录', { exact: true }).fill(home)
    await manager.getByLabel('所属宿主的本机访问地址（可选）', { exact: true }).fill(endpoint)
    await manager.getByRole('button', { name: '保存路径', exact: true }).click()
    await page.waitForFunction((name) => [...document.querySelectorAll('.dshdc-source-row strong')].some((element) => element.textContent === name), name)
  }
  await addSource('Second', b.home, b.url)
  await addSource('Offline', offline.home)
  assert.equal(await manager.locator('.dshdc-record').count(), 3)
  assert.equal(await manager.locator('.dshdc-record input:disabled').count(), 1)
  await manager.getByRole('button', { name: '管理来源路径', exact: true }).click()
  await manager.getByRole('button', { name: '选择全部筛选结果', exact: true }).click()
  await manager.getByLabel('批量操作', { exact: true }).selectOption('delete')
  await manager.getByRole('button', { name: '预览所选操作', exact: true }).click()
  let preview = page.locator('#dshdc-batch-preview')
  await preview.waitFor()
  assert.equal(await preview.locator('.dshdc-preview-list p').count(), 2)
  assert.match(await preview.innerText(), /Second/)
  assert.match(await preview.innerText(), /Current/)
  await preview.getByRole('button', { name: '取消', exact: true }).click()
  const sourceId = await manager.getByLabel('来源路径', { exact: true }).locator('option').filter({ hasText: /^Second$/ }).getAttribute('value')
  await manager.getByLabel('来源路径', { exact: true }).selectOption(sourceId)
  assert.equal(await manager.locator('.dshdc-record').count(), 1)
  for (const [action, label] of [['pin', '置顶'], ['unpin', '取消置顶'], ['archive', '归档'], ['unarchive', '取消归档']]) {
    await manager.getByRole('button', { name: '选择全部筛选结果', exact: true }).click()
    await manager.getByLabel('批量操作', { exact: true }).selectOption(action)
    await manager.getByRole('button', { name: '预览所选操作', exact: true }).click()
    await page.locator('#dshdc-batch-preview').getByRole('button', { name: `确认${label}`, exact: true }).click()
    await page.waitForFunction(() => document.querySelector('#dshdc-manager-notice')?.textContent.includes('成功 1，失败 0'))
    const list = await page.evaluate(async () => (await (await fetch('/dsh-chat-prune/sessions')).json()).sessions)
    const remote = list.find((row) => row.sourceId === sourceId)
    assert.equal(remote.pinned, action === 'pin')
    assert.equal(remote.archived, action === 'archive')
    assert.equal(list.find((row) => row.sourceId === 'local').pinned, false)
    assert.equal(list.find((row) => row.sourceId === 'local').archived, false)
  }
  await manager.getByRole('button', { name: '选择全部筛选结果', exact: true }).click()
  await manager.getByLabel('批量操作', { exact: true }).selectOption('delete')
  await manager.getByRole('button', { name: '预览所选操作', exact: true }).click()
  preview = page.locator('#dshdc-batch-preview')
  await preview.waitFor()
  assert.equal(await preview.locator('.dshdc-preview-list p').count(), 1)
  assert.equal((await preview.locator('.dshdc-preview-list').innerText()).includes(a.home), false)
  await preview.getByRole('button', { name: '确认删除记录', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#dshdc-manager-notice')?.textContent.includes('成功 1，失败 0'))
  assert.equal(await readFile(join(a.dir, 'record'), 'utf8'), 'Current')
  assert.equal(await readFile(join(offline.dir, 'record'), 'utf8'), 'Offline')
  await assert.rejects(() => readFile(join(b.dir, 'record')), { code: 'ENOENT' })
  await page.reload()
  await page.locator('#dshdc-manage').click()
  await manager.locator('.dshdc-record').first().waitFor()
  assert.equal(await manager.getByLabel('来源路径', { exact: true }).locator('option').count(), 4)
  await manager.getByRole('button', { name: '管理来源路径', exact: true }).click()
  await manager.getByRole('button', { name: '选择全部筛选结果', exact: true }).click()
  let releaseList
  const listGate = new Promise((resolve) => { releaseList = resolve })
  let signalList
  const listStarted = new Promise((resolve) => { signalList = resolve })
  await page.route('**/dsh-chat-prune/sessions', async (route) => {
    if (route.request().method() === 'GET') { signalList(); await listGate }
    await route.continue()
  })
  await manager.getByRole('button', { name: '刷新列表', exact: true }).click()
  await listStarted
  try {
    assert.equal(await manager.getByRole('button', { name: '预览所选操作', exact: true }).isDisabled(), true)
    assert.equal(await manager.locator('.dshdc-source-row').filter({ hasText: 'Offline' }).getByRole('button', { name: '移除来源', exact: true }).isDisabled(), true)
  } finally { releaseList() }
  await page.waitForFunction(() => document.querySelector('#dshdc-manager')?.getAttribute('aria-busy') === 'false')
  await page.unroute('**/dsh-chat-prune/sessions')
  let releaseRemoval, signalRemoval
  const removalGate = new Promise((resolve) => { releaseRemoval = resolve })
  const removalStarted = new Promise((resolve) => { signalRemoval = resolve })
  await page.route('**/dsh-chat-prune/sources', async (route) => {
    if (route.request().method() === 'DELETE') { signalRemoval(); await removalGate }
    await route.continue()
  })
  await manager.locator('.dshdc-source-row').filter({ hasText: 'Offline' }).getByRole('button', { name: '移除来源', exact: true }).click()
  await removalStarted
  try {
    assert.equal(await manager.getByRole('button', { name: '预览所选操作', exact: true }).isDisabled(), true)
    assert.equal(await manager.getByRole('button', { name: '刷新列表', exact: true }).isDisabled(), true)
  } finally { releaseRemoval() }
  await page.waitForFunction(() => document.querySelectorAll('.dshdc-source-row').length === 2)
  await page.unroute('**/dsh-chat-prune/sources')
  assert.equal(await readFile(join(offline.dir, 'record'), 'utf8'), 'Offline')
  await page.setViewportSize({ width: 375, height: 700 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const bounds = await manager.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }))
  assert.ok(bounds.scroll <= bounds.width, 'Source settings must fit a narrow viewport')
  assert.deepEqual(errors, [])
})
