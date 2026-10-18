import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { measureManagerContrast } from './helpers/manager-contrast.mjs'

test('manager layout: themes, useful list space, keyboard flow and responsive controls', async (t) => {
  const bundle = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const artifactDirectory = new URL('../.diagnostics/manager-ui/', import.meta.url)
  await mkdir(artifactDirectory, { recursive: true })
  const localHome = 'C:\\DSH\\personal', workHome = 'C:\\DSH\\work', offlineHome = 'C:\\DSH\\archive'
  const actions = ['archive', 'unarchive', 'pin', 'unpin']
  const sources = [
    { id: 'local', name: '个人空间', home: localHome, connected: true },
    { id: '8e1e41ea02c48899', name: '工作项目', home: workHome, connected: true },
    { id: 'a173bf1619439840', name: '离线归档', home: offlineHome, connected: false },
  ]
  const sessions = [
    ['project-plan', '下一步计划：把想法变成可执行的任务', { pinned: true }],
    ['interface', '管理界面的布局与交互设计', {}],
    ['notes', '阅读笔记 · 保留值得回看的内容', { releasable: true }],
    ['research', '产品调研：问题、观察与新的方向', { source: 1 }],
    ['running', '正在进行的代码审查', { running: true, source: 1 }],
    ['archived', '上周的灵感与阶段总结', { archived: true }],
    ['offline', '离线目录中的历史记录', { source: 2, readOnly: true }],
    ['missing', null, { missing: true }],
    ['long-title', '一个较长的对话标题，记录了从需求分析、方案比较到实现细节的完整思考过程，用于核对窄屏下的文字换行与操作位置', {}],
  ].map(([id, title, flags], index) => {
    const source = sources[flags.source || 0]
    return {
      id: `session-${id}`, title, key: source.id === 'local' ? `session-${id}` : `${source.id}:session-${id}`, sourceId: source.id,
      sourceHome: source.home, sourceName: source.name, workspace: flags.source ? '产品研发' : '日常工作',
      workspaceKey: `${source.id}:workspace`, bytes: flags.missing ? 0 : (index + 1) * 82432,
      files: flags.missing ? 0 : index + 2, mtime: flags.missing ? 0 : Date.UTC(2026, 9, 18, 9, 30 - index),
      actions: flags.readOnly ? [] : actions, ...flags,
    }
  })
  const catalog = { ok: true, apiVersion: 1, managementVersion: 1, version: manifest.version,
    canDetectRunning: true, config: { backup: false }, sources, sessions, actions }
  let holdCatalog = null, releaseCatalog = null, mutations = 0, failCatalog = false
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/dsh-chat-prune/')) {
      if (req.url === '/dsh-chat-prune/sessions' && req.method === 'GET' && failCatalog) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Fixture host unavailable' }))
        return
      }
      if (req.url === '/dsh-chat-prune/sessions' && req.method === 'GET' && holdCatalog) {
        const waiting = holdCatalog
        holdCatalog = null
        await waiting
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url === '/dsh-chat-prune/sessions' && req.method === 'GET') res.end(JSON.stringify(catalog))
      else if (req.url.startsWith('/dsh-chat-prune/ping')) res.end(JSON.stringify({ ...catalog, home: localHome }))
      else {
        if (!req.url.endsWith('/diag')) mutations++
        res.end(JSON.stringify({ ok: true }))
      }
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="margin:0;font:14px system-ui"><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script></body></html>`)
  })
  let browser
  t.after(async () => {
    releaseCatalog?.()
    await browser?.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1400, height: 950 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.locator('#dshdc-manage').click()
  const manager = page.locator('#dshdc-manager')
  await manager.locator('.dshdc-record').first().waitFor()
  assert.equal(await manager.getByRole('searchbox').evaluate((element) => element === document.activeElement), true)
  assert.equal(await manager.getByLabel('批量操作', { exact: true }).inputValue(), 'archive',
    'Initial loading does not silently switch the default action to deletion')
  await manager.locator('[data-session-id="session-interface"] input').check()
  await manager.locator('[data-session-id="session-research"] input').check()
  await manager.locator('.dshdc-records-scroll').evaluate((element) => { element.scrollTop = 0 })

  const palettes = {
    light: {
      scheme: 'light', surface: '#ffffff', field: '#f7f9fc', text: '#1e293b', muted: '#637083',
      border: '#e2e7ef', hover: '#f0f3f9', active: '#e8eefb', danger: '#b93238',
      dangerHover: '#fff0f0', focus: '#315cda', onColor: '#ffffff', mask: '#17233a66',
    },
    dark: {
      scheme: 'dark', surface: '#1c1f27', field: '#232833', text: '#edf0f7', muted: '#a1adbf',
      border: '#343d4b', hover: '#2b3340', active: '#323e51', danger: '#ffaaa9',
      dangerHover: '#402a30', focus: '#99b7ff', onColor: '#13213f', mask: '#070a10b3',
    },
  }
  async function setPalette(palette) {
    await page.evaluate((palette) => {
      const tokens = {
        surface: '--dsw-alias-bg-layer-2', field: '--dsw-alias-bg-layer-1',
        text: '--dsw-alias-label-primary', muted: '--dsw-alias-label-secondary',
        border: '--dsw-alias-border-l3', hover: '--dsw-alias-interactive-bg-hover',
        active: '--dsw-alias-interactive-bg-active', danger: '--dsw-alias-state-error-primary',
        dangerHover: '--dsw-alias-interactive-bg-hover-danger', focus: '--dsw-focus-ring-color',
        onColor: '--dsw-alias-label-on-color', mask: '--dsw-alias-bg-mask-1',
      }
      document.documentElement.style.colorScheme = palette.scheme
      document.body.style.background = palette.scheme === 'dark' ? '#0e1118' : '#edf1f7'
      for (const [name, token] of Object.entries(tokens)) document.body.style.setProperty(token, palette[name])
      document.body.style.setProperty('--dsw-radius-panel', '18px')
      document.body.style.setProperty('--dsw-font-family', '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif')
    }, palette)
  }
  async function assertLayout(minimumListHeight) {
    const bounds = await manager.boundingBox()
    const viewport = page.viewportSize()
    assert.ok(bounds.x >= 0 && bounds.y >= 0)
    assert.ok(bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height)
    assert.equal(await manager.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
    const list = manager.locator('.dshdc-records-scroll')
    assert.ok((await list.boundingBox()).height >= minimumListHeight, 'Conversations retain usable vertical space')
    for (const control of [
      manager.getByRole('button', { name: '预览所选操作', exact: true }),
      manager.getByRole('button', { name: '关闭', exact: true }),
      manager.getByLabel('批量操作', { exact: true }),
    ]) {
      const box = await control.boundingBox()
      assert.ok(box.x >= bounds.x && box.y >= bounds.y && box.x + box.width <= bounds.x + bounds.width &&
        box.y + box.height <= bounds.y + bounds.height, 'Primary controls remain inside the dialog')
      assert.ok(box.height >= 44, 'Primary controls retain a touch-sized target')
    }
  }
  for (const [name, palette] of Object.entries(palettes)) {
    await t.test(`${name} theme has readable contrast and preserves the current selection`, async () => {
      await setPalette(palette)
      await assertLayout(200)
      assert.equal(await manager.locator('.dshdc-record input:checked').count(), 2)
      const ratios = await manager.evaluate(measureManagerContrast)
      for (const [role, ratio] of Object.entries(ratios)) assert.ok(ratio >= 4.5, `${name} ${role} contrast is ${ratio}`)
      await manager.screenshot({ path: fileURLToPath(new URL(`${name}.png`, artifactDirectory)) })
    })
  }
  await t.test('preview cancellation returns focus and cannot perform a mutation', async () => {
    const preview = manager.getByRole('button', { name: '预览所选操作', exact: true })
    await preview.click()
    const confirmation = page.locator('#dshdc-batch-preview')
    await confirmation.waitFor()
    assert.equal(await confirmation.getByRole('button', { name: '取消', exact: true }).evaluate((element) => element === document.activeElement), true)
    await page.screenshot({ path: fileURLToPath(new URL('preview.png', artifactDirectory)) })
    await page.keyboard.press('Escape')
    await confirmation.waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.activeElement?.textContent.includes('预览所选操作'))
    assert.equal(mutations, 0)
    await manager.locator('.dshdc-records-scroll').focus()
    await page.keyboard.press('/')
    assert.equal(await manager.getByRole('searchbox').evaluate((element) => element === document.activeElement), true)
    await manager.locator('.dshdc-records-scroll').evaluate((element) => { element.scrollTop = 0 })
  })
  await t.test('portrait, small phone and landscape keep content and primary controls reachable', async () => {
    for (const viewport of [{ width: 375, height: 700 }, { width: 320, height: 640 }, { width: 812, height: 375 }]) {
      await page.setViewportSize(viewport)
      await assertLayout(viewport.height < 400 ? 48 : 90)
      await manager.locator('.dshdc-records-scroll').evaluate((element) => { element.scrollTop = 0 })
      if (viewport.width === 375) await manager.screenshot({
        path: fileURLToPath(new URL('mobile.png', artifactDirectory)),
      })
    }
  })
  await t.test('the retention shortcut reveals rules and editing a generated plan clears stale candidates', async () => {
    await page.setViewportSize({ width: 1400, height: 950 })
    const shortcut = manager.getByRole('button', { name: '保留规则', exact: true })
    await shortcut.click()
    await manager.locator('.dshdc-rules[open]').waitFor()
    assert.equal(await shortcut.getAttribute('aria-expanded'), 'true')
    await manager.getByLabel('每个工作区保留最近条数', { exact: true }).fill('1')
    await manager.getByLabel('只修剪早于多少天的记录', { exact: true }).fill('0')
    await manager.getByRole('button', { name: '生成修剪候选', exact: true }).click()
    assert.ok(await manager.locator('.dshdc-record input:checked').count() > 0)
    await manager.getByLabel('每个工作区保留最近条数', { exact: true }).fill('2')
    assert.equal(await manager.locator('.dshdc-record input:checked').count(), 0)
    assert.match(await manager.locator('#dshdc-manager-notice').innerText(), /规则已更改/)
    assert.equal(mutations, 0)
    await manager.getByRole('button', { name: '更多筛选', exact: true }).click()
    assert.equal(await shortcut.getAttribute('aria-expanded'), 'false')
    await shortcut.click()
    assert.equal(await manager.locator('.dshdc-rules').evaluate((element) => element.open), true,
      'Reopening hidden rules reveals the existing panel')
    await manager.getByRole('button', { name: '更多筛选', exact: true }).click()
  })
  await t.test('reduced motion stops refresh animation while loading remains visible and guarded', async () => {
    await page.setViewportSize({ width: 1400, height: 950 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    holdCatalog = new Promise((resolve) => { releaseCatalog = resolve })
    await manager.getByRole('button', { name: '刷新列表', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('#dshdc-manager')?.getAttribute('aria-busy') === 'true')
    assert.equal(await manager.locator('.dshdc-refresh svg').evaluate((element) => getComputedStyle(element).animationName), 'none')
    assert.equal(await manager.getByRole('button', { name: '预览所选操作', exact: true }).isDisabled(), true)
    assert.ok((await manager.locator('#dshdc-manager-notice').innerText()).length > 0)
    releaseCatalog()
    await page.waitForFunction(() => document.querySelector('#dshdc-manager')?.getAttribute('aria-busy') === 'false')
    assert.deepEqual(errors, [])
    assert.equal(mutations, 0)
  })
  await t.test('initial load failure has a retry action and is not presented as an empty library', async () => {
    await manager.getByRole('button', { name: '关闭', exact: true }).click()
    failCatalog = true
    await page.locator('#dshdc-manage').click()
    await manager.getByRole('button', { name: '重新加载', exact: true }).waitFor()
    assert.match(await manager.locator('.dshdc-empty').innerText(), /暂时无法读取对话/)
    assert.match(await manager.locator('#dshdc-manager-notice').innerText(), /读取对话失败/)
    assert.equal(await manager.getByRole('button', { name: '预览所选操作', exact: true }).isDisabled(), true)
    failCatalog = false
    await manager.getByRole('button', { name: '重新加载', exact: true }).click()
    await manager.locator('.dshdc-record').first().waitFor()
    assert.equal(await manager.locator('.dshdc-record').count(), sessions.length)
    assert.deepEqual(errors, [])
  })
  await t.test('English labels fit small screens without hiding the action or close controls', async () => {
    const englishPage = await browser.newPage({ locale: 'en-US', viewport: { width: 375, height: 700 } })
    try {
      await englishPage.goto(`http://127.0.0.1:${server.address().port}`)
      await englishPage.locator('#dshdc-manage').click()
      const englishManager = englishPage.locator('#dshdc-manager')
      await englishManager.locator('.dshdc-record').first().waitFor()
      await englishManager.locator('.dshdc-record input').first().check()
      for (const width of [375, 320]) {
        await englishPage.setViewportSize({ width, height: 700 })
        assert.equal(await englishManager.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
        const bounds = await englishManager.boundingBox()
        for (const label of ['Preview selected action', 'Close']) {
          const box = await englishManager.getByRole('button', { name: label, exact: true }).boundingBox()
          assert.ok(box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width &&
            box.y + box.height <= bounds.y + bounds.height, `${label} fits ${width}px`)
        }
      }
    } finally {
      await englishPage.close()
    }
  })
})
