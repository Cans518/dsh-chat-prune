import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRestartController } from '../lib/desktop-restart.js'
import { relaunchEnvironment, restartAfterTeardown } from '../lib/restart-watcher.js'

const desktop = { platform: 'win32', env: { ELECTRON_RUN_AS_NODE: '1', PATH: 'x' }, ppid: 4242, pid: 5151,
  execPath: 'D:\\DSH\\DeepSeek Harness.exe', electron: '44.7.0', imageName: async () => 'DeepSeek Harness.exe' }

function harness(overrides = {}) {
  const spawned = [], timers = [], markers = [], exits = []
  const proc = new EventEmitter()
  proc.exit = (code) => exits.push(code)
  let keptAlive = 0
  const restart = createRestartController({ ...desktop, proc, tmp: 'T',
    spawnImpl: (file, args, options) => { spawned.push({ file, args, options }); return { unref() { this.unrefed = true } } },
    schedule: (callback, ms) => { timers.push({ callback, ms }); return { unref() {} } },
    keepAlive: () => { keptAlive++ }, writeMarker: (file) => markers.push(file),
    watcherPath: 'W.js', closeScript: 'C.ps1', ...overrides })
  return { restart, proc, spawned, timers, markers, exits, keptAlive: () => keptAlive }
}

test('restart is offered only to a Node-mode host whose parent is this DSH executable', async () => {
  assert.equal((await createRestartController(desktop).status()).supported, true)
  for (const override of [{ platform: 'darwin' }, { env: {} }, { electron: undefined }, { ppid: 0 },
    { imageName: async () => 'explorer.exe' }, { imageName: async () => { throw new Error('denied') } }]) {
    assert.equal((await createRestartController({ ...desktop, ...override }).status()).supported, false, JSON.stringify(Object.keys(override)))
  }
})

test('restart starts the detached watcher, then runs the host shutdown without letting the host exit', async () => {
  const h = harness()
  let disposed = false
  h.proc.on('SIGTERM', () => { disposed = true; h.proc.exit(0) })
  const result = await h.restart.restart()
  assert.deepEqual([result.ok, result.restarting], [true, true])
  assert.equal(h.spawned.length, 1)
  const [{ file, args, options }] = h.spawned
  assert.equal(file, desktop.execPath)
  assert.deepEqual(args.slice(0, 4), ['W.js', '4242', '5151', desktop.execPath])
  assert.match(args[4], /^T[\\/]dsh-chat-prune-restart-[0-9a-f-]{36}\.done$/)
  assert.equal(args[5], 'C.ps1')
  assert.deepEqual([options.detached, options.stdio, options.env.ELECTRON_RUN_AS_NODE], [true, 'ignore', '1'])
  assert.equal(disposed, false, 'The page receives its response before shutdown starts')
  assert.equal(h.timers[0].ms, 500)
  h.timers[0].callback()
  assert.equal(disposed, true, 'The host runs its own graceful shutdown')
  assert.deepEqual(h.markers, [args[4]], 'Shutdown completion is reported to the watcher')
  assert.deepEqual(h.exits, [], 'The host stays alive so DSH does not report a crashed backend')
  assert.equal(h.keptAlive(), 1)
  h.proc.emit('disconnect')
  assert.deepEqual(h.exits, [0], 'The host leaves once the window process is gone')
  await h.restart.restart()
  assert.equal(h.spawned.length, 1, 'A second click does not start another watcher')
})

test('a shutdown that never calls exit still releases the watcher', async () => {
  const h = harness()
  await h.restart.restart()
  h.timers[0].callback()
  assert.deepEqual(h.markers, [])
  const fallback = h.timers.find((timer) => timer.ms === 12000)
  fallback.callback()
  assert.equal(h.markers.length, 1)
})

test('restart is refused where DSH cannot be restarted', async () => {
  const h = harness({ platform: 'linux' })
  const result = await h.restart.restart()
  assert.deepEqual([result.ok, result.supported], [false, false])
  assert.equal(h.spawned.length, 0)
  assert.equal(h.timers.length, 0)
})

function watcherDeps({ mainExitsOn = 'close', hostExits = true } = {}) {
  let clock = 0, mainAlive = true, hostAlive = true, marker = false
  const calls = []
  return {
    calls, setMarker: () => { marker = true },
    deps: {
      now: () => clock, sleep: async (ms) => { clock += ms; if (clock > 300) marker = true },
      exists: () => marker,
      alive: (pid) => pid === 1 ? mainAlive : hostAlive,
      requestClose: async (pid) => { calls.push(['close', pid]); if (mainExitsOn === 'close') { mainAlive = false; if (hostExits) hostAlive = false }; return 'ok' },
      terminate: async (pid) => { calls.push(['terminate', pid]); if (mainExitsOn !== 'never') { if (pid === 1) mainAlive = false; else hostAlive = false }; return 'ok' },
      launch: (file, args) => calls.push(['launch', file, args]),
      log: () => {},
    },
  }
}

test('the watcher closes DSH only after the host shut down, then reopens it once', async () => {
  const w = watcherDeps()
  assert.equal(await restartAfterTeardown({ mainPid: 1, hostPid: 2, executable: 'DSH.exe', marker: 'm',
    closeScript: 'C.ps1', deps: w.deps }), 'relaunched')
  assert.deepEqual(w.calls, [['close', 1], ['launch', 'DSH.exe', []]])
})

test('the watcher terminates a window process that ignores the close request', async () => {
  const w = watcherDeps({ mainExitsOn: 'terminate' })
  assert.equal(await restartAfterTeardown({ mainPid: 1, hostPid: 2, executable: 'DSH.exe', marker: 'm',
    closeScript: 'C.ps1', deps: w.deps }), 'relaunched')
  assert.deepEqual(w.calls.map(([name, pid]) => [name, pid]), [['close', 1], ['terminate', 1], ['terminate', 2], ['launch', 'DSH.exe']])
})

test('the watcher never opens a second DSH while the old one is still running', async () => {
  const w = watcherDeps({ mainExitsOn: 'never' })
  assert.equal(await restartAfterTeardown({ mainPid: 1, hostPid: 2, executable: 'DSH.exe', marker: 'm',
    closeScript: 'C.ps1', deps: w.deps }), 'stuck')
  assert.equal(w.calls.some(([name]) => name === 'launch'), false)
})

test('the relaunched app does not inherit the host-only Node mode', () => {
  assert.deepEqual(relaunchEnvironment({ ELECTRON_RUN_AS_NODE: '1', DSH_CLIENT_VERSION: '1', PATH: 'p' }), { PATH: 'p' })
})

// Opt-in: a DSH-shaped Electron app (window process + Node-mode backend child) on the
// same Electron version as DSH. Set ELECTRON_EXECUTABLE to an electron.exe to run it.
const electron = process.env.ELECTRON_EXECUTABLE
test('Electron: one click shuts the backend down, closes the window process and reopens the app', {
  skip: process.platform !== 'win32' || !electron ? 'set ELECTRON_EXECUTABLE (Windows) to run' : false,
}, async () => {
  const out = await mkdtemp(join(tmpdir(), 'dshdc-restart-e2e-'))
  try {
    const env = { ...process.env, PROBE_OUT: out, PROBE_SHOW: '0',
      PROBE_RESTART_MODULE: fileURLToPath(new URL('../lib/desktop-restart.js', import.meta.url)) }
    delete env.ELECTRON_RUN_AS_NODE
    spawn(electron, [fileURLToPath(new URL('./fixtures/restart-probe/main.cjs', import.meta.url))], { env, stdio: 'ignore' }).unref()
    const deadline = Date.now() + 45000
    while (!existsSync(join(out, 'second.pid')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250))
    const events = existsSync(join(out, 'events.log')) ? await readFile(join(out, 'events.log'), 'utf8') : ''
    assert.equal(existsSync(join(out, 'second.pid')), true, `The app reopened\n${events}`)
    assert.equal(existsSync(join(out, 'session.flushed')), true, 'The backend completed its graceful shutdown first')
    assert.ok(events.indexOf('host dispose done') < events.indexOf('main relaunched'), events)
    assert.doesNotMatch(events, /host-failed/, 'DSH would not report a crashed backend')
    assert.match(events, /main relaunched pid=\d+ runAsNode=unset/)
    const first = Number(await readFile(join(out, 'first.pid'), 'utf8'))
    assert.throws(() => process.kill(first, 0), 'The old window process is gone')
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 500))
    await rm(out, { recursive: true, force: true }).catch(() => {})
  }
})
