import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const archive = process.env.DSH_ASAR
assert.ok(archive, 'Set DSH_ASAR before running test:install')
const resources = dirname(archive)
const executable = process.env.DSH_EXECUTABLE || join(dirname(resources), 'DSH NEXT.exe')
const runtime = join(resources, 'runtime', process.arch, 'primary-runtime', 'dependencies')
const nodeCommand = process.env.DSH_NODE_EXECUTABLE || join(runtime, 'node', 'bin', 'node.exe')
const pnpm = process.env.DSH_PNPM || join(runtime, 'pnpm', 'bin', 'pnpm.cjs')
const redact = (text) => text.replace(/([?&#](?:token|key|auth|secret)=)[^&\s"']+/gi, '$1[redacted]')

async function runChild(home, mode, args, logName) {
  const child = spawn(executable, [
    '--expose-internals', fileURLToPath(import.meta.url), mode, ...args,
  ], {
    cwd: sourceRoot, windowsHide: true, timeout: 120000,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      output += chunk
    })
  }
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  process.stdout.write(redact(output))
  await writeFile(join(home, logName), redact(output))
  assert.equal(code, 0, `DSH command failed; see ${join(home, logName)}`)
}

if (process.argv[2] === '--cli') {
  assert.match(relative(join(sourceRoot, '.diagnostics'), resolve(process.env.DSH_HOME)), /^cli-install-[A-Za-z0-9]+$/)
  const require = createRequire(join(archive, 'package.json'))
  const { runCli } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh/lib/bin.js')).href)
  process.argv = [process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(3)]
  await runCli({ manageDesktopProfile: true, packageManager: { command: nodeCommand, args: [pnpm] } })
} else if (process.argv[2] === '--boot') {
  const home = resolve(process.env.DSH_HOME)
  assert.match(relative(join(sourceRoot, '.diagnostics'), home), /^cli-install-[A-Za-z0-9]+$/)
  const require = createRequire(join(archive, 'package.json'))
  const load = async (name) => import(pathToFileURL(require.resolve(name)).href)
  const { runProfile } = await load('@deepseek-ai/dsh/profile-boot')
  const { loadProfileDirectory, loadLayeredEnv } = await load('@deepseek-ai/dsh-app-boot')
  const profile = loadProfileDirectory('dsh', join(home, 'profiles', 'desktop'), join(archive, 'package.json'))
  assert.deepEqual(profile.skippedBundles, [])
  const app = await runProfile({
    environment: loadLayeredEnv('dsh'), profile: 'install-audit',
    resolvedProfile: { profile, installAnchor: join(archive, 'package.json') },
    patchFiles: [], args: ['--no-open', '--port', '0'],
  })
  try {
    assert.equal(app.ctx.get('profileContext').home, home)
    const url = app.ctx.get('connection').authenticatedUrl(`http://127.0.0.1:${app.ctx.get('webServer').port}/dsh-delete-chat/ping`)
    const response = await fetch(url)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).version, process.argv[3])
    console.log('Installed bundle boots and serves its versioned API')
  } finally {
    await app.shutdown.shutdown(0)
  }
} else {
  test('DSH plugin add installs a prebuilt package and enables its bundle without manual profile edits', async () => {
    await mkdir(join(sourceRoot, '.diagnostics'), { recursive: true })
    const home = await mkdtemp(join(sourceRoot, '.diagnostics', 'cli-install-'))
    const profile = join(home, 'profiles', 'desktop')
    await mkdir(profile, { recursive: true })
    const initialBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-delete-chat-install-fixture', private: true,
      dsh: { profile: { bundles: initialBundles } },
    }, null, 2))
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
    const manifest = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
    const spec = process.env.DSH_INSTALL_SPEC || resolve(sourceRoot, `dsh-delete-chat-${manifest.version}.tgz`)
    console.log(`Installing through real DSH CLI into ${home}`)
    await runChild(home, '--cli', ['plugin', '--profile', 'desktop', 'add', spec,
      '--fetch-retries=0', '--fetch-timeout=30000'], 'install.log')
    const installed = join(profile, 'node_modules', manifest.name)
    const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
    assert.equal(installedManifest.version, manifest.version)
    const saved = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    assert.ok(saved.dependencies[manifest.name])
    assert.deepEqual(saved.dsh.profile.bundles, [...initialBundles, manifest.name])
    assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), '[]\n')
    for (const file of ['lib/index.js', 'client.js', 'client-core.js', 'client-slot.js', 'cordis.patch.yml']) {
      assert.equal(await readFile(join(installed, file), 'utf8'), await readFile(join(sourceRoot, file), 'utf8'))
    }
    await runChild(home, '--boot', [manifest.version], 'boot.log')
    await runChild(home, '--cli', ['plugin', '--profile', 'desktop', 'remove', manifest.name], 'remove.log')
    const removed = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    assert.equal(removed.dependencies?.[manifest.name], undefined)
    assert.deepEqual(removed.dsh.profile.bundles, initialBundles)
    console.log('DSH_ADD_INSTALL_PASS: automatic enablement, runtime files, actual Host boot and removal verified')
  })
}
