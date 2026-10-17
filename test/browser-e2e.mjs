import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import * as zlib from 'node:zlib'
import { chromium } from 'playwright'
import { apply } from '../lib/index.js'
import { renderFixtureInjections } from './helpers/render-injections.mjs'

test('Chromium: injected plugin, real HTTP routes and isolated session storage', {
  skip: typeof zlib.zstdCompressSync !== 'function' && 'Browser log fixtures require zstd support',
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dshdc-browser-'))
  let browser, server
  const disposers = []
  const activeRequests = new Set()
  t.after(async () => {
    await browser?.close()
    if (server?.listening) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    await Promise.allSettled([...activeRequests])
    for (const dispose of disposers) dispose?.()
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })
  const rows = [
    { id: 'session-first', title: '第一段对话' },
    { id: 'session-second', title: '第二段对话' },
    { id: 'session-duplicate-a', title: '同名对话' },
    { id: 'session-duplicate-b', title: '同名对话' },
    { id: 'session-untitled', title: null },
    { id: 'session-loaded', title: '已加载的对话' },
    { id: 'session-unsafe-html', title: '<img src=x onerror=alert(1)>' },
  ]
  for (const row of rows) {
    const dir = join(home, 'sessions', '--fixture--', row.id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(
      `${JSON.stringify({ type: 'session/title', data: { title: row.title } })}\n`,
    )))
  }
  await mkdir(join(home, 'storages'))
  const wsPath = join(home, 'storages', 'workspace.json')
  await writeFile(wsPath, JSON.stringify({
    global: { pinnedSessionIds: [], archivedSessionIds: [] },
    tables: { workspaces: { fixture: { sessionIds: rows.map((row) => row.id) } } },
  }))
  const loaded = new Set(['session-loaded'])
  let route, inject
  apply({
    profileContext: { home },
    sessions: { get: (id) => loaded.has(id) ? { id } : undefined },
    // Model the public single-writer contract; actual disk removal still uses
    // the plugin and real fixture files, without opening a user's live host.
    sessionPersistence: process.platform === 'win32' ? {
      async open(id) {
        assert.equal(loaded.has(id), false)
        return { async close() {} }
      },
    } : undefined,
    webServer: { register(value) { route = value; return () => {} } },
    on(_event, listener) { inject = listener; return () => {} },
    effect(fn) { disposers.push(fn()) },
  }, { backup: true })
  let deletes = 0
  let failList = false
  const table = []
  inject(table)
  server = createServer(async (req, res) => {
    if (req.url.startsWith('/dsh-delete-chat/')) {
      if (req.method === 'DELETE') deletes += 1
      if (req.method === 'GET' && req.url.endsWith('/sessions') && failList) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'fixture offline' }))
        return
      }
      const pending = route.handler(req, res)
      activeRequests.add(pending)
      try {
        await pending
      } finally {
        activeRequests.delete(pending)
      }
      return
    }
    const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{margin:0;font:16px system-ui;color:#eee;background:#202020}
      aside{width:min(280px,100vw);padding:16px;box-sizing:border-box}
      [role=treeitem]{height:36px;padding:0 12px;display:flex;align-items:center}
      #dshdc-layer{pointer-events:auto!important}
      input{padding:12px}main{padding:24px}</style></head><body>
      <aside><h1>DSH fixture</h1><div role="tree">
      <div role="treeitem" tabindex="0">第一段对话</div>
      <div role="treeitem" tabindex="0">第二段对话</div>
      <div role="treeitem" tabindex="0">同名对话</div>
      <div role="treeitem" tabindex="0">同名对话</div>
      </div></aside><main><input aria-label="宿主输入框" placeholder="输入消息"></main>
      </body></html>`
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(renderFixtureInjections(html, table))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, locale: 'zh-CN' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.locator('#dshdc-manage').waitFor()
  await page.evaluate(() => {
    window.fixtureRefreshCalls = []
    window.__dshDeleteChatRefreshSessions__ = async (id) => {
      window.fixtureRefreshCalls.push(id)
      if (window.fixtureFailRefresh) {
        window.fixtureFailRefresh = false
        throw new Error('fixture host catalog unavailable')
      }
    }
  })
  const hoverButton = page.locator('.dshdc-del')

  await t.test('open dialogs follow the host color scheme even when it differs from the OS', async () => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.evaluate(() => { document.documentElement.style.colorScheme = 'light' })
    await page.locator('#dshdc-manage').click()
    const manager = page.locator('#dshdc-manager')
    try {
      assert.equal(await manager.evaluate((element) => getComputedStyle(element).colorScheme), 'light')
      await manager.getByRole('searchbox').fill('session-duplicate')
      await page.evaluate(() => { document.documentElement.style.colorScheme = 'dark' })
      assert.equal(await manager.evaluate((element) => getComputedStyle(element).colorScheme), 'dark')
      assert.equal(await manager.getByRole('searchbox').inputValue(), 'session-duplicate')
    } finally {
      await manager.getByRole('button', { name: '关闭', exact: true }).click()
      await manager.waitFor({ state: 'detached' })
      await page.evaluate(() => { document.documentElement.style.removeProperty('color-scheme') })
      await page.emulateMedia({ colorScheme: 'light' })
    }
  })

  await t.test('host input remains editable after hover and React-owned rows are untouched', async () => {
    await page.getByRole('treeitem').first().hover()
    await hoverButton.waitFor({ state: 'visible' })
    const input = page.getByRole('textbox', { name: '宿主输入框' })
    await input.click()
    await page.keyboard.type('input remains clickable')
    assert.equal(await input.inputValue(), 'input remains clickable')
    assert.equal(await page.getByRole('treeitem').first().locator('button').count(), 0)
  })
  await t.test('ambiguous duplicate rows have no guessed delete target', async () => {
    await page.getByRole('treeitem').nth(2).hover()
    await hoverButton.waitFor({ state: 'hidden' })
  })
  await t.test('confirmation names target and backup policy; cancel has default focus and Escape works', async () => {
    await page.getByRole('treeitem').first().hover()
    await hoverButton.click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /session-first/)
    assert.match(await dialog.innerText(), /备份/)
    assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).evaluate(
      (element) => element === document.activeElement,
    ), true)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(deletes, 0)
  })
  await t.test('two consecutive deletes work and create recoverable backups', async () => {
    for (const index of [0, 1]) {
      await page.getByRole('treeitem').nth(index).hover()
      await hoverButton.click()
      await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click()
      await page.waitForFunction(() => {
        const button = document.querySelector('.dshdc-del')
        return button?.dataset.dshdcState === 'done' && !button.disabled
      })
      assert.equal(await hoverButton.isDisabled(), false)
      assert.match(await page.locator('#dshdc-notice').innerText(), /备份位置/)
    }
    assert.equal(deletes, 2)
    assert.deepEqual(await page.evaluate(() => window.fixtureRefreshCalls.filter(Boolean)),
      ['session-first', 'session-second'])
    const doc = JSON.parse(await readFile(wsPath, 'utf8'))
    assert.equal(doc.tables.workspaces.fixture.sessionIds.includes('session-first'), false)
    assert.equal(doc.tables.workspaces.fixture.sessionIds.includes('session-second'), false)
  })
  await t.test('manager, confirmation and notices update live with body-scoped theme tokens', async () => {
    const palettes = [
      { name: 'light', scheme: 'light', surface: '#ffffff', field: '#f5f6fa', text: '#0f1115',
        muted: '#61666b', border: '#d2d6dd', danger: '#b42318', hover: '#eef1f7',
        dangerHover: '#fee2e2', focus: '#4176e6', mask: 'rgba(0, 0, 0, 0.24)', radius: '28px', font: 'sans-serif' },
      { name: 'dark', scheme: 'dark', surface: '#2c2c2e', field: '#232324', text: '#f9fafb',
        muted: '#cfd3d6', border: '#5b5b60', danger: '#f25a5a', hover: '#3a3a3e',
        dangerHover: '#49252b', focus: '#7aaaff', mask: 'rgba(0, 0, 0, 0.5)', radius: '28px', font: 'sans-serif' },
      { name: 'custom', scheme: 'dark', surface: '#122d2b', field: '#0b201f', text: '#e9fff8',
        muted: '#a0c8ba', border: '#446c60', danger: '#ffab91', hover: '#21443d',
        dangerHover: '#5a3027', focus: '#82e1c0', mask: 'rgba(1, 10, 7, 0.62)', radius: '20px', font: 'monospace' },
    ]
    const tokens = {
      surface: '--dsw-alias-bg-layer-2', field: '--dsw-alias-bg-layer-1',
      text: '--dsw-alias-label-primary', muted: '--dsw-alias-label-secondary',
      border: '--dsw-alias-border-l3', danger: '--dsw-alias-state-error-primary',
      hover: '--dsw-alias-interactive-bg-hover', dangerHover: '--dsw-alias-interactive-bg-hover-danger',
      focus: '--dsw-focus-ring-color', mask: '--dsw-alias-bg-mask-1',
      radius: '--dsw-radius-panel', font: '--dsw-font-family',
    }
    const setPalette = (palette) => page.evaluate(({ palette, tokens }) => {
      document.documentElement.style.colorScheme = palette.scheme
      for (const [key, name] of Object.entries(tokens)) document.body.style.setProperty(name, palette[key])
      document.body.style.backgroundColor = palette.field
      document.body.style.color = palette.text
    }, { palette, tokens })
    const rgb = (hex) => `rgb(${hex.slice(1).match(/../g).map((value) => parseInt(value, 16)).join(', ')})`
    await setPalette(palettes[0])
    await page.locator('#dshdc-manage').click()
    const manager = page.locator('#dshdc-manager')
    const confirmation = page.locator('.dshdc-dialog:not(#dshdc-manager)')
    try {
      await manager.locator('.dshdc-record').first().waitFor()
      await manager.getByRole('searchbox').fill('session-duplicate-b')
      await manager.locator('.dshdc-record button').click()
      await confirmation.waitFor()
      for (const palette of palettes) {
        await setPalette(palette)
        for (const modal of [manager, confirmation]) {
          const style = await modal.evaluate((element) => {
            const css = getComputedStyle(element)
            return { background: css.backgroundColor, text: css.color, scheme: css.colorScheme,
              radius: css.borderRadius, font: css.fontFamily }
          })
          assert.deepEqual(style, { background: rgb(palette.surface), text: rgb(palette.text),
            scheme: palette.scheme, radius: palette.radius, font: palette.font })
        }
        assert.equal(await manager.getByRole('searchbox').evaluate((el) => getComputedStyle(el).backgroundColor), rgb(palette.field))
        assert.equal(await manager.locator('.dshdc-actions').evaluate((el) => getComputedStyle(el).backgroundColor), rgb(palette.surface))
        assert.equal(await page.locator('#dshdc-notice').evaluate((el) => getComputedStyle(el).backgroundColor), rgb(palette.surface))
        assert.equal(await confirmation.evaluate((el) => getComputedStyle(el, '::backdrop').backgroundColor), palette.mask)
        const danger = confirmation.getByRole('button', { name: '确认删除', exact: true })
        await danger.hover()
        assert.equal(await danger.evaluate((el) => getComputedStyle(el).color), rgb(palette.danger))
        assert.equal(await danger.evaluate((el) => getComputedStyle(el).backgroundColor), rgb(palette.dangerHover))
        const cancel = confirmation.getByRole('button', { name: '取消', exact: true })
        await cancel.hover()
        assert.equal(await cancel.evaluate((el) => getComputedStyle(el).backgroundColor), rgb(palette.hover))
        await cancel.focus()
        await page.keyboard.press('Tab')
        assert.equal(await danger.evaluate((el) => getComputedStyle(el).outlineColor), rgb(palette.focus))
        assert.equal(await manager.getByRole('searchbox').inputValue(), 'session-duplicate-b')
        if (process.env.DSHDC_SCREENSHOTS || process.argv.includes('--screenshots')) {
          await mkdir(new URL('./artifacts/', import.meta.url), { recursive: true })
          await page.screenshot({ path: fileURLToPath(new URL(`./artifacts/theme-${palette.name}.png`, import.meta.url)) })
        }
      }
    } finally {
      if (await confirmation.count()) await confirmation.getByRole('button', { name: '取消', exact: true }).click()
      await manager.getByRole('button', { name: '关闭', exact: true }).click()
      await manager.waitFor({ state: 'detached' })
      await page.evaluate((tokens) => {
        for (const name of Object.values(tokens)) document.body.style.removeProperty(name)
        for (const name of ['background-color', 'color']) document.body.style.removeProperty(name)
        document.documentElement.style.removeProperty('color-scheme')
      }, tokens)
    }
  })
  await t.test('manager is keyboard reachable, searchable and supports same-title or untitled records', async () => {
    await page.locator('#dshdc-manage').focus()
    await page.keyboard.press('Enter')
    const manager = page.locator('#dshdc-manager')
    await manager.locator('.dshdc-record').first().waitFor()
    assert.equal(await manager.locator('.dshdc-record').count(), 5)
    const search = manager.getByRole('searchbox')
    await search.fill('同名对话')
    assert.equal(await manager.locator('.dshdc-record').count(), 2)
    await search.fill('session-duplicate-a')
    await manager.locator('.dshdc-record button').click()
    const confirm = page.getByRole('dialog').filter({ hasText: '确认删除' })
    assert.match(await confirm.innerText(), /session-duplicate-a/)
    await confirm.getByRole('button', { name: '确认删除', exact: true }).click()
    await manager.locator('.dshdc-record').waitFor({ state: 'hidden' })
    await search.fill('无标题')
    // Search IDs and workspace too; an untitled row is explicitly identified by ID.
    await search.fill('session-untitled')
    assert.match(await manager.locator('.dshdc-record').innerText(), /无标题对话/)
  })
  await t.test('loaded sessions are disabled and record titles are escaped as text', async () => {
    const manager = page.locator('#dshdc-manager')
    await manager.getByRole('searchbox').fill('session-loaded')
    assert.equal(await manager.locator('.dshdc-record button').isDisabled(), true)
    await manager.getByRole('searchbox').fill('session-unsafe-html')
    assert.match(await manager.locator('.dshdc-record').innerText(), /<img/)
    assert.equal(await manager.locator('img').count(), 0)
  })
  await t.test('failed host catalog refresh preserves deletion success and can be retried', async () => {
    const manager = page.locator('#dshdc-manager')
    await manager.getByRole('searchbox').fill('session-untitled')
    await page.evaluate(() => { window.fixtureFailRefresh = true })
    await manager.locator('.dshdc-record button').click()
    await page.getByRole('dialog').filter({ hasText: '确认删除' })
      .getByRole('button', { name: '确认删除', exact: true }).click()
    await manager.locator('.dshdc-record').waitFor({ state: 'detached' })
    assert.match(await manager.locator('#dshdc-manager-notice').innerText(), /删除已完成.*列表刷新失败/)
    assert.equal(await page.evaluate(() => window.fixtureRefreshCalls.includes('session-untitled')), true)
    await manager.getByRole('button', { name: '刷新列表' }).click()
    await page.waitForFunction(() => !document.querySelector('#dshdc-manager-notice')?.textContent.includes('刷新失败'))
    assert.equal(await page.evaluate(() => window.fixtureRefreshCalls.at(-1)), undefined)
  })
  await t.test('refresh errors are visible in modal and can be retried', async () => {
    const manager = page.locator('#dshdc-manager')
    failList = true
    await manager.getByRole('button', { name: '刷新列表' }).click()
    await page.waitForFunction(() => document.querySelector('#dshdc-manager-notice')?.textContent.includes('fixture offline'))
    failList = false
    await manager.getByRole('button', { name: '刷新列表' }).click()
    await page.waitForFunction(() => !document.querySelector('#dshdc-manager-notice')?.textContent.includes('fixture offline'))
  })
  await t.test('narrow viewport keeps dialog inside screen and closes with focus restored', async () => {
    await page.setViewportSize({ width: 375, height: 700 })
    const manager = page.locator('#dshdc-manager')
    await manager.getByRole('searchbox').fill('')
    const box = await manager.boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= 375)
    if (process.env.DSHDC_SCREENSHOTS || process.argv.includes('--screenshots')) {
      await mkdir(new URL('./artifacts/', import.meta.url), { recursive: true })
      await page.screenshot({ path: fileURLToPath(new URL('./artifacts/manager-mobile.png', import.meta.url)) })
      await page.setViewportSize({ width: 1100, height: 760 })
      await page.screenshot({ path: fileURLToPath(new URL('./artifacts/manager-desktop.png', import.meta.url)) })
    }
    await manager.getByRole('button', { name: '关闭', exact: true }).click()
    await manager.waitFor({ state: 'detached' })
    assert.equal(await manager.count(), 0)
    assert.equal(await page.locator('#dshdc-manage').evaluate((el) => el === document.activeElement), true)
    assert.deepEqual(errors, [])
  })
  await t.test('page lifecycle cleanup and back-forward restore install exactly one layer', async () => {
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    assert.equal(await page.locator('#dshdc-layer').count(), 0)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await page.locator('#dshdc-manage').waitFor()
    assert.equal(await page.locator('#dshdc-layer').count(), 1)
    await page.getByRole('textbox', { name: '宿主输入框' }).fill('恢复后仍可输入')
    assert.deepEqual(errors, [])
  })
})
