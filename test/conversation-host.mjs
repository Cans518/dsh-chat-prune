import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePackage } from '../lib/conversation-package.js'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const archive = process.env.DSH_ASAR
const executable = process.env.DSH_EXECUTABLE || (archive && join(dirname(dirname(archive)), 'DSH NEXT.exe'))

async function startHost(t, existingHome) {
  await mkdir(join(root, '.diagnostics'), { recursive: true })
  const home = existingHome || await mkdtemp(join(root, '.diagnostics', 'live-host-'))
  const profile = join(home, 'profiles', 'audit')
  const installed = join(profile, 'node_modules', 'dsh-chat-prune')
  await mkdir(installed, { recursive: true })
  for (const file of ['lib', 'package.json', 'client.js', 'client-slot.js', 'cordis.patch.yml']) {
    await cp(join(root, file), join(installed, file), { recursive: true })
  }
  for (const dependency of ['@deepseek-ai/schemastery', '@deepseek-ai/cosmokit', '@standard-schema/spec']) {
    const destination = join(profile, 'node_modules', dependency)
    await mkdir(dirname(destination), { recursive: true })
    await cp(join(root, 'node_modules', dependency), destination, { recursive: true })
  }
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-compression-migration-test', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-chat-prune'] } },
  }))
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  const child = spawn(executable, ['--expose-internals', join(root, 'test', 'host-e2e.mjs'), '--child', profile], {
    cwd: home, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    if (child.connected) child.send({ type: 'shutdown' })
    let timer
    await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 8000) })])
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    await writeFile(join(home, 'host.log'), output.replace(/([?&]token=)[^&\s]+/g, '$1[redacted]'))
  }
  t.after(stop)
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Host startup timeout')), 45000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Host exited: ${code}`)) })
    child.on('message', (message) => {
      if (message.type === 'ready') { clearTimeout(timer); resolve(message) }
      if (message.type === 'fatal') { clearTimeout(timer); reject(new Error(message.error)) }
    })
  })
  const request = async (path, payload, raw) => {
    const url = new URL(ready.url)
    url.pathname = `/dsh-chat-prune/${path}`
    const response = await fetch(url, {
      method: raw || payload ? 'POST' : 'GET',
      headers: { 'content-type': raw ? 'application/gzip' : 'application/json' },
      body: raw || (payload && JSON.stringify(payload)), signal: AbortSignal.timeout(30000),
    })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.ok, true, JSON.stringify(body))
    return body
  }
  return { home, ready, request, stop }
}

test('real hosts: compressed batch package migrates events and attachments into a fresh plugin installation', {
  skip: !archive && 'Set DSH_ASAR to run real-host conversation migration',
}, async (t) => {
  const source = await startHost(t)
  const target = await startHost(t)
  await source.request('sessions/action', { sessionId: source.ready.ids[0], action: 'compress' })
  await source.stop()
  const restarted = await startHost(t, source.home)
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const restartedPage = await browser.newPage({ locale: 'zh-CN' })
  await restartedPage.goto(restarted.ready.url)
  const restartedPreview = restartedPage.getByRole('dialog', { name: '预览版说明' })
  await restartedPreview.waitFor({ state: 'visible', timeout: 15000 })
  await restartedPreview.getByRole('button', { name: '继续', exact: true }).click()
  const restartedSetup = restartedPage.getByRole('dialog', { name: /^(添加一个 API Key 开始使用|开始使用)$/ })
  await restartedSetup.waitFor({ state: 'visible', timeout: 15000 })
  await restartedSetup.getByRole('button', {
    name: await restartedSetup.getAttribute('aria-label') === '开始使用' ? '关闭' : '稍后配置', exact: true,
  }).click()
  const originalGroup = restartedPage.locator(`[data-row-key="workspace:${source.ready.workspaceId}"]`)
  await originalGroup.waitFor({ timeout: 30000 })
  if (await originalGroup.getAttribute('aria-expanded') === 'false') await originalGroup.click()
  // Inspect startup state before opening management or explicitly refreshing sessions.
  await restartedPage.waitForFunction((ids) => ids.every((id) =>
    document.querySelector(`[data-row-key="session:${id}"]`)), source.ready.ids.slice(0, 2),
  { timeout: 15000 })
  assert.equal(await restartedPage.locator('#dshdc-manager').count(), 0)
  await restartedPage.close()
  const retained = (await restarted.request('sessions')).sessions.find((row) => row.id === source.ready.ids[0])
  assert.equal(retained.compressed, true)
  assert.equal(retained.workspaceKey, source.ready.workspaceId)
  const exported = await restarted.request('conversations/export', { sessionIds: source.ready.ids })
  const page = await browser.newPage({ locale: 'zh-CN' })
  await page.goto(target.ready.url)
  const preview = page.getByRole('dialog', { name: '预览版说明' })
  await preview.waitFor({ state: 'visible', timeout: 15000 })
  await preview.getByRole('button', { name: '继续', exact: true }).click()
  const setup = page.getByRole('dialog', { name: /^(添加一个 API Key 开始使用|开始使用)$/ })
  await setup.waitFor({ state: 'visible', timeout: 15000 })
  await setup.getByRole('button', {
    name: await setup.getAttribute('aria-label') === '开始使用' ? '关闭' : '稍后配置', exact: true,
  }).click()
  await page.locator('.dshdc-sidebar-manage').click()
  const manager = page.locator('#dshdc-manager')
  await manager.locator('#dshdc-compression summary').click()
  const days = manager.getByLabel('多少天未更新后自动压缩（0 为关闭）', { exact: true })
  await days.fill('30')
  await manager.getByRole('button', { name: '保存自动压缩设置', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#dshdc-compression')?.textContent.includes('已保存。'))
  assert.equal(await days.inputValue(), '30')
  assert.equal((await target.request('sessions')).compression.afterDays, 30)
  await manager.getByRole('button', { name: '立即检查自动压缩', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#dshdc-compression')?.textContent.includes('已压缩 0 条'))
  await manager.getByLabel('对话压缩包', { exact: true }).setInputFiles({
    name: 'conversations.dsh-chat.gz', mimeType: 'application/gzip', buffer: Buffer.from(exported.archive, 'base64'),
  })
  await manager.getByRole('button', { name: '导入对话压缩包', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#dshdc-compression')?.textContent.includes('已导入 3 条对话'))
  const imported = { imported: source.ready.ids }
  assert.deepEqual(imported.imported, source.ready.ids)
  const targetRows = (await target.request('sessions')).sessions.filter((row) => imported.imported.includes(row.id))
  assert.equal(targetRows.length, 3)
  assert.ok(targetRows.every((row) => row.title === '压缩迁移验收' && !row.missing))
  assert.equal(targetRows.find((row) => row.id === source.ready.ids[1]).pinned, true)
  assert.equal(targetRows.find((row) => row.id === source.ready.ids[2]).archived, true)
  const roundTrip = await target.request('conversations/export', { sessionIds: imported.imported })
  const before = await decodePackage(Buffer.from(exported.archive, 'base64'))
  const after = await decodePackage(Buffer.from(roundTrip.archive, 'base64'))
  for (const session of after) {
    const original = before.find((entry) => entry.id === session.id)
    assert.deepEqual(session.logical.events, original.logical.events)
    assert.equal(session.logical.inheritedEventCount, original.logical.inheritedEventCount)
    assert.equal(session.logical.header.cwd, join(target.home, 'imported-conversations'))
    const row = targetRows.find((row) => row.id === session.id)
    assert.equal(await readFile(join(target.home, 'sessions', row.workspaceSlug, row.id, 'attachments', 'transfer.txt'), 'utf8'),
      '对话附件验收\n'.repeat(20000))
  }
  const disk = JSON.parse(await readFile(join(target.home, 'storages', 'workspace.json'), 'utf8'))
  assert.ok(Object.values(disk.tables.workspaces).some((workspace) =>
    imported.imported.every((id) => workspace.sessionIds.includes(id))))
})
