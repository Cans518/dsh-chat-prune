import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, cp, writeFile, readFile } from 'node:fs/promises'
import { join, dirname, relative, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measureManagerContrast } from './helpers/manager-contrast.mjs'

const archive = process.env.DSH_ASAR
assert.ok(archive, 'Set DSH_ASAR to your DSH installation resources/app.asar before running test:host')
const executable = process.env.DSH_EXECUTABLE || join(dirname(dirname(archive)), 'DSH NEXT.exe')
const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const redact = (text) => text.replace(/([?&#](?:token|key|auth|secret)=)[^&\s"']+/gi, '$1[redacted]')

async function childMain() {
  const profileDir = process.argv[3]
  const home = resolve(process.env.DSH_HOME || '')
  const relativeHome = relative(join(sourceRoot, '.diagnostics'), home)
  assert.match(relativeHome, /^live-host-[A-Za-z0-9]+$/, 'Live host must use its own generated artifact directory')
  assert.equal(resolve(profileDir), join(home, 'profiles', 'audit'), 'Live host must use its own audit profile')
  const require = createRequire(join(archive, 'package.json'))
  const load = async (name) => import(pathToFileURL(require.resolve(name)).href)
  const { runProfile } = await load('@deepseek-ai/dsh/profile-boot')
  const { loadProfileDirectory, loadLayeredEnv } = await load('@deepseek-ai/dsh-app-boot')
  const profile = loadProfileDirectory('dsh', profileDir, join(archive, 'package.json'))
  if (profile.skippedBundles.length) {
    throw new Error(`Skipped profile bundles: ${JSON.stringify(profile.skippedBundles)}`)
  }
  const application = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'audit',
    resolvedProfile: { profile, installAnchor: join(archive, 'package.json') },
    patchFiles: [],
    args: ['--no-open', '--port', '0'],
  })
  const { ctx } = application
  assert.equal(ctx.get('profileContext').home, home)
  const persistence = ctx.get('sessionPersistence')
  const registry = ctx.get('workspaceRegistry')
  const workspacePath = join(process.env.DSH_HOME, 'workspace')
  await mkdir(workspacePath, { recursive: true })
  const workspace = await registry.create(workspacePath, '真实宿主验收')
  const ids = [0, 1, 2].map(() => `session-${randomUUID()}`)
  for (const id of ids) {
    const writer = await persistence.create({
      version: 4, id, createdAt: Date.now(), cwd: workspacePath,
      isSeeded: id === ids[2], delegationDepth: 0,
    }, { inheritedEventCount: id === ids[2] ? 1 : 0 })
    await writer.append([{ type: 'session/title', seq: 0, time: Date.now(),
      data: { title: '压缩迁移验收', messageSeqs: [], source: { kind: 'user' } } }])
    if (id === ids[2]) await writer.append([{
      type: 'session/end-seed', seq: 1, time: Date.now(), data: { inherited: true },
    }])
    await writer.flush()
    await writer.close()
    const sessionDir = dirname(persistence.locate(writer.header).path)
    await mkdir(join(sessionDir, 'attachments'))
    await writeFile(join(sessionDir, 'attachments', 'transfer.txt'), '对话附件验收\n'.repeat(20000))
    await workspace.attachSession(id)
  }
  await registry.pinSession(ids[1])
  await registry.archiveSession(ids[2])
  const webServer = ctx.get('webServer')
  const url = ctx.get('connection').authenticatedUrl(`http://127.0.0.1:${webServer.port}`)
  process.send({ type: 'ready', url, port: webServer.port, ids, workspaceId: workspace.id })
  process.on('message', async (message) => {
    if (message.type === 'shutdown') {
      await application.shutdown.shutdown(0)
      process.disconnect?.()
    }
  })
  process.once('disconnect', () => application.shutdown.shutdown(0).catch(console.error))
}

async function parentMain() {
  assert.equal(process.platform, 'win32', 'Live DSH ownership deletion is verified on Windows')
  await mkdir(join(sourceRoot, '.diagnostics'), { recursive: true })
  const sourceManifest = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
  const home = await mkdtemp(join(sourceRoot, '.diagnostics', 'live-host-'))
  const profileDir = join(home, 'profiles', 'audit')
  const installed = join(profileDir, 'node_modules', 'dsh-chat-prune')
  await mkdir(join(installed, 'lib'), { recursive: true })
  for (const file of ['lib/index.js', 'lib/pruning-policy.js', 'lib/agent-lifecycle.js', 'lib/session-sources.js',
    'lib/conversation-package.js', 'lib/conversation-storage.js', 'lib/conversation-maintenance.js',
    'package.json', 'client.js', 'client-core.js', 'client-manager.js', 'client-slot.js', 'cordis.patch.yml']) {
    await cp(join(sourceRoot, file), join(installed, file))
  }
  for (const dependency of ['@deepseek-ai/schemastery', '@deepseek-ai/cosmokit', '@standard-schema/spec']) {
    const destination = join(profileDir, 'node_modules', dependency)
    await mkdir(dirname(destination), { recursive: true })
    await cp(join(sourceRoot, 'node_modules', dependency), destination, { recursive: true })
  }
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-chat-prune-real-host-audit', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-chat-prune'] } },
    dependencies: { 'dsh-chat-prune': sourceManifest.version },
  }, null, 2))
  await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n')
  console.log(`Starting real DSH host in ${home}`)
  const child = spawn(executable, ['--expose-internals', fileURLToPath(import.meta.url), '--child', profileDir], {
    cwd: home, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  let browser, page
  const failedResponses = []
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Real host startup deadline exceeded')), 45000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('message', (message) => {
        if (message.type === 'ready') { clearTimeout(timer); resolve(message) }
        if (message.type === 'fatal') { clearTimeout(timer); reject(new Error(message.error)) }
      })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Real host exited before ready (${code})`)) })
    })
    console.log(`Real host ready, port=${ready.port}`)
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1400, height: 960 } })
    // The isolated Host can lack this optional desktop icon. Keep that OS
    // asset independent of the real theme, session and deletion APIs tested.
    await page.route('**/open-in-app/icon/explorer', async (route) => {
      const response = await route.fetch()
      if (response.status() !== 404) return route.fulfill({ response })
      return route.fulfill({
        status: 200, contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#81858c" d="M1 3h5l2 2h7v9H1z"/></svg>',
      })
    })
    const pageErrors = []
    const consoleErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('response', async (response) => {
      if (response.status() >= 400) {
        failedResponses.push({ status: response.status(), url: redact(response.url()),
          body: await response.text().catch(() => '') })
      }
    })
    await page.goto(ready.url)
    const managerEntry = page.locator('.dshdc-sidebar-manage')
    await managerEntry.waitFor({ timeout: 30000 })
    assert.equal(await page.locator('[data-slot="sidebar.footer.action"] .dshdc-sidebar-manage').count(), 1)
    assert.equal(await page.locator('#dshdc-manage').isVisible(), false)
    await page.screenshot({ path: join(home, 'boot.png') })
    const status = await page.evaluate(() => window.dshChatPrune.status())
    assert.equal(status.nativeRowAction, true)
    assert.equal(status.version, sourceManifest.version)
    assert.equal(status.hostVersion, sourceManifest.version)
    console.log('Actual host and native client versions match:', sourceManifest.version)
    console.log('Workspace rows:', await page.locator('[data-row-key^="workspace:"]').allTextContents())
    await writeFile(join(home, 'boot.html'), await page.content())
    const preview = page.getByRole('dialog', { name: '预览版说明' })
    await preview.waitFor({ state: 'visible', timeout: 15000 })
    await preview.getByRole('button', { name: '继续', exact: true }).click()
    const setup = page.getByRole('dialog', { name: /^(添加一个 API Key 开始使用|开始使用)$/ })
    await setup.waitFor({ state: 'visible', timeout: 15000 })
    const setupDismiss = await setup.getAttribute('aria-label') === '开始使用' ? '关闭' : '稍后配置'
    await setup.getByRole('button', { name: setupDismiss, exact: true }).click()
    await setup.waitFor({ state: 'detached' })
    // Model initialization can reopen onboarding after a later session switch.
    // Handle it at action time so it cannot race an earlier isVisible() check.
    const exposedSetup = page.locator('body:not(:has(.dshdc-dialog[open]))')
      .getByRole('dialog', { name: /^(添加一个 API Key 开始使用|开始使用)$/ })
    await page.addLocatorHandler(exposedSetup, async (dialog) => {
      await dialog.getByRole('button', { name: setupDismiss, exact: true }).click()
    })
    console.log('Fresh-host onboarding dismissed through its normal controls')
    async function openSettings() {
      const settings = page.getByRole('button', { name: '设置', exact: true })
      if (await settings.count()) {
        await settings.click()
      } else {
        await page.getByRole('button', { name: '账号菜单', exact: true }).click()
        await page.getByText('设置', { exact: true }).click()
      }
    }
    for (const theme of [
      { name: '深色', scheme: 'dark', surface: 'rgb(44, 44, 46)', text: 'rgb(249, 250, 251)' },
      { name: '浅色', scheme: 'light', surface: 'rgb(255, 255, 255)', text: 'rgb(15, 17, 21)' },
    ]) {
      await openSettings()
      await page.getByRole('button', { name: theme.name, exact: true }).click()
      await page.waitForFunction((scheme) => document.documentElement.style.colorScheme === scheme, theme.scheme)
      await page.keyboard.press('Escape')
      await page.getByRole('dialog', { name: '设置', exact: true }).waitFor({ state: 'detached' })
      await managerEntry.click()
      const themeManager = page.locator('#dshdc-manager')
      const actual = await themeManager.evaluate((element) => {
        const css = getComputedStyle(element)
        return { surface: css.backgroundColor, text: css.color, scheme: css.colorScheme }
      })
      assert.deepEqual(actual, { surface: theme.surface, text: theme.text, scheme: theme.scheme })
      await themeManager.locator('.dshdc-record').first().waitFor()
      await themeManager.locator('.dshdc-record input').first().check()
      assert.equal(await themeManager.getByRole('button', { name: '预览所选操作', exact: true }).isEnabled(), true)
      const contrast = await themeManager.evaluate(measureManagerContrast)
      for (const [role, ratio] of Object.entries(contrast)) {
        assert.ok(ratio >= 4.5, `Actual host ${theme.scheme} ${role} contrast is ${ratio}`)
      }
      await page.screenshot({ path: join(home, `theme-${theme.scheme}.png`) })
      await themeManager.getByRole('button', { name: '关闭', exact: true }).click()
      await themeManager.waitFor({ state: 'detached' })
    }
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: '设置', exact: true }).waitFor({ state: 'detached' })
    console.log('Plugin dialogs match themes selected through actual DSH settings')
    const group = page.locator(`[data-row-key="workspace:${ready.workspaceId}"]`)
    if (await group.getAttribute('aria-expanded') === 'false') await group.click()
    await managerEntry.click()
    const management = page.locator('#dshdc-manager')
    for (const [action, label] of [
      ['unarchive', '取消归档'], ['pin', '置顶'], ['archive', '归档'],
      ['unarchive', '取消归档'], ['archive', '归档'],
    ]) {
      await management.getByRole('searchbox').fill(ready.ids[2])
      await management.locator('.dshdc-record input[type="checkbox"]').check()
      await management.getByLabel('批量操作', { exact: true }).selectOption(action)
      await management.getByRole('button', { name: '预览所选操作', exact: true }).click()
      await page.locator('#dshdc-batch-preview').getByRole('button', { name: `确认${label}`, exact: true }).click()
      await page.waitForFunction(() => document.querySelector('#dshdc-manager-notice')?.textContent.includes('成功 1，失败 0'))
      const metadata = await page.evaluate(async (id) =>
        (await (await fetch('/dsh-chat-prune/sessions')).json()).sessions.find((entry) => entry.id === id), ready.ids[2])
      assert.equal(metadata.archived, action === 'archive')
      assert.equal(metadata.pinned, action === 'pin')
      const disk = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
      assert.equal(disk.global.archivedSessionIds.includes(ready.ids[2]), metadata.archived)
      assert.equal(disk.global.pinnedSessionIds.includes(ready.ids[2]), metadata.pinned)
    }
    await management.getByRole('button', { name: '关闭', exact: true }).click()
    await management.waitFor({ state: 'detached' })
    console.log('Actual manager archive/unarchive/pin round trips match durable workspace state')
    await managerEntry.click()
    await management.getByRole('searchbox').fill(ready.ids[0])
    await management.locator('.dshdc-record input[type="checkbox"]').check()
    await management.getByLabel('批量操作', { exact: true }).selectOption('compress')
    await management.getByRole('button', { name: '预览所选操作', exact: true }).click()
    await page.locator('#dshdc-batch-preview').getByRole('button', { name: '确认压缩记录', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('#dshdc-manager-notice')?.textContent.includes('成功 1，失败 0'))
    const compressed = await page.evaluate(async (sessionId) =>
      (await (await fetch('/dsh-chat-prune/sessions')).json()).sessions.find((row) => row.id === sessionId), ready.ids[0])
    assert.equal(compressed.compressed, true, JSON.stringify(compressed))
    assert.ok(compressed.originalBytes - compressed.bytes > 100000, JSON.stringify(compressed))
    await management.locator('.dshdc-record input[type="checkbox"]').check()
    await management.getByLabel('批量操作', { exact: true }).selectOption('export')
    await management.getByRole('button', { name: '预览所选操作', exact: true }).click()
    const downloading = page.waitForEvent('download')
    await page.locator('#dshdc-batch-preview').getByRole('button', { name: '确认导出压缩包', exact: true }).click()
    const download = await downloading
    assert.match(download.suggestedFilename(), /\.dsh-chat\.gz$/)
    await download.saveAs(join(home, 'exported.dsh-chat.gz'))
    console.log('Actual manager compresses selected records and downloads their compressed package')
    await page.reload()
    await managerEntry.waitFor()
    const compressedGroup = page.locator(`[data-row-key="workspace:${ready.workspaceId}"]`)
    if (await compressedGroup.getAttribute('aria-expanded') === 'false') await compressedGroup.click()
    const row = page.locator(`[data-row-key="session:${ready.ids[0]}"]`)
    await row.waitFor({ timeout: 15000 })
    await row.click()
    await page.waitForFunction(async (id) =>
      (await (await fetch('/dsh-chat-prune/sessions')).json()).sessions.some((entry) => entry.id === id && entry.releasable),
    ready.ids[0])
    const restored = await page.evaluate(async (sessionId) =>
      (await (await fetch('/dsh-chat-prune/sessions')).json()).sessions.find((row) => row.id === sessionId), ready.ids[0])
    assert.equal(restored.compressed, undefined)
    const restoredDir = join(home, 'sessions', restored.workspaceSlug, ready.ids[0])
    assert.equal(await readFile(join(restoredDir, 'attachments', 'transfer.txt'), 'utf8'), '对话附件验收\n'.repeat(20000))
    console.log('Compressed record survives official frontend reload and restores its full attachment on native open')
    await page.locator(`[data-row-key="session:${ready.ids[1]}"]`).click()
    await row.hover()
    await row.locator('.dshdc-native-del').waitFor({ state: 'visible', timeout: 15000 })
    console.log('Native action visible on actual host-rendered row')
    await page.screenshot({ path: join(home, 'native-action.png') })
    await row.locator('.dshdc-native-del').click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    assert.match(await dialog.innerText(), new RegExp(ready.ids[0]))
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await row.hover()
    await row.locator('.dshdc-native-del').click()
    await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click()
    await row.waitFor({ state: 'detached', timeout: 15000 })
    const list = await page.evaluate(async () => (await fetch('/dsh-chat-prune/sessions')).json())
    assert.equal(list.sessions.some((entry) => entry.id === ready.ids[0]), false)
    assert.equal(list.sessions.some((entry) => entry.id === ready.ids[1]), true)
    const ungrouped = page.locator('[data-row-key="workspace:"]')
    if (await ungrouped.count() && await ungrouped.getAttribute('aria-expanded') === 'false') {
      await ungrouped.click()
    }
    await page.locator(`[data-row-key="session:${ready.ids[0]}"]`).waitFor({ state: 'detached', timeout: 5000 })
    assert.equal(await page.locator(`[data-row-key="session:${ready.ids[0]}"]`).count(), 0,
      'Deleted session must also disappear from the ungrouped sidebar')
    console.log('Actual persistence deletion and live workspace list refresh passed')
    await managerEntry.click()
    const manager = page.locator('#dshdc-manager')
    await manager.getByRole('searchbox').fill(ready.ids[2])
    await manager.locator('.dshdc-record').waitFor()
    await manager.locator('.dshdc-record input[type="checkbox"]').check()
    await manager.getByLabel('批量操作', { exact: true }).selectOption('delete')
    await manager.getByRole('button', { name: '预览所选操作', exact: true }).click()
    await page.locator('#dshdc-batch-preview').getByRole('button', { name: '确认删除记录', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('#dshdc-manager-notice')?.textContent.includes('成功 1，失败 0'))
    await manager.locator('.dshdc-record').waitFor({ state: 'detached' })
    await manager.getByRole('button', { name: '关闭', exact: true }).click()
    await page.screenshot({ path: join(home, 'after-archived-delete.png') })
    if (await ungrouped.count() && await ungrouped.getAttribute('aria-expanded') === 'false') {
      await ungrouped.click()
    }
    assert.equal(await page.locator(`[data-row-key="session:${ready.ids[2]}"]`).count(), 0,
      'Deleted archived session must not reappear in an unarchived workspace')
    const doc = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
    assert.equal(doc.global.archivedSessionIds.includes(ready.ids[2]), false)
    assert.equal(doc.global.pinnedSessionIds.includes(ready.ids[1]), true)
    const selectedRow = page.locator(`[data-row-key="session:${ready.ids[1]}"]`)
    await selectedRow.click()
    await page.waitForFunction(async (id) => {
      const list = await (await fetch('/dsh-chat-prune/sessions')).json()
      return list.sessions.some((entry) => entry.id === id && entry.releasable)
    }, ready.ids[1])
    await managerEntry.click()
    await manager.getByRole('searchbox').fill(ready.ids[1])
    await manager.locator('.dshdc-record').waitFor()
    assert.equal(await manager.locator('.dshdc-record button').isDisabled(), false)
    assert.match(await manager.locator('.dshdc-record').innerText(), /空闲可删除/)
    console.log('Previously opened idle sessions use the actual lifecycle handle and remain deletable')
    await page.evaluate(() => window.dshChatPrune.notify('删除失败：提示交互验收', { tone: 'error' }))
    await manager.getByRole('button', { name: '关闭提示', exact: true }).click()
    assert.equal(await page.locator('#dshdc-notice').isVisible(), false)
    await page.clock.install()
    try {
      await page.evaluate(() => window.dshChatPrune.notify('自动关闭验收', { tone: 'error' }))
      assert.equal(await page.locator('#dshdc-notice').isVisible(), true)
      await page.clock.fastForward(12000)
      assert.equal(await page.locator('#dshdc-notice').isVisible(), false)
    } finally {
      await page.clock.resume()
    }
    console.log('Error notices can be closed and expire inside the actual host manager')
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(consoleErrors, [])
    console.log('REAL_HOST_E2E_PASS', home)
  } catch (error) {
    console.log('Failed host responses:', failedResponses)
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(home, 'failure.png') })
      await writeFile(join(home, 'failure.html'), await page.content())
      console.log('Remaining dialogs:', await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map(
        (element) => ({
          html: element.outerHTML.slice(0, 14000),
          rect: element.getBoundingClientRect().toJSON(),
          styles: {
            display: getComputedStyle(element).display, position: getComputedStyle(element).position,
            opacity: getComputedStyle(element).opacity, zIndex: getComputedStyle(element).zIndex,
          },
          parent: element.parentElement.outerHTML.slice(0, 1000),
        }),
      )))
    }
    console.error(redact(output.slice(-14000)))
    throw error
  } finally {
    await browser?.close()
    if (child.connected) child.send({ type: 'shutdown' })
    let deadline
    await Promise.race([exited, new Promise((resolve) => { deadline = setTimeout(resolve, 8000) })])
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill()
    await writeFile(join(home, 'host.log'), redact(output))
  }
}

if (process.argv[2] === '--child') {
  childMain().catch((error) => {
    process.send?.({ type: 'fatal', error: error.stack || String(error) })
    console.error(error)
    process.exitCode = 1
    process.disconnect?.()
  })
} else {
  test('Actual DSH Host and official frontend: native action, confirmation, disk deletion and registry refresh', parentMain)
}
