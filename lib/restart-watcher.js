/**
 * Finish a one-click DSH restart from outside the DSH process tree.
 *
 * DSH 0.2.x offers plugins no quit API and hides its window to the tray on close.
 * The host (see desktop-restart.js) first runs its own graceful shutdown, which
 * closes session writers, stops tasks and disposes plugins, and then touches
 * `marker`. Only after that does this watcher end the desktop window process:
 * first with the Windows close-application notification (request-close.ps1, the
 * same path Windows uses at sign-out), and only if that is ignored with taskkill.
 * Once the old processes are gone it starts the executable again.
 *
 * Run as: <electron> restart-watcher.js <mainPid> <hostPid> <executable> <marker> <closeScript|-> [argsJson]
 * with ELECTRON_RUN_AS_NODE=1. `argsJson` is only used by tests.
 */

import { execFile, spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Environment the desktop main process adds when it starts the host child. */
const HOST_ONLY_KEYS = ['ELECTRON_RUN_AS_NODE', 'DSH_CLIENT_VERSION']
export const RESTART_LOG = join(tmpdir(), 'dsh-chat-prune-restart.log')

export function relaunchEnvironment(environment) {
  const next = { ...environment }
  for (const key of HOST_ONLY_KEYS) delete next[key]
  return next
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const run = (file, args, timeout) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout }, (error, stdout, stderr) =>
    resolve(`${error ? `exit ${error.code ?? error.signal} ` : ''}${String(stdout).trim()} ${String(stderr).trim()}`.trim()))
})

const defaults = {
  alive: isAlive,
  exists: existsSync,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  requestClose: (pid, script) => run('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProcessId', String(pid)], 20000),
  terminate: (pid) => run('taskkill', ['/PID', String(pid), '/T', '/F'], 10000),
  launch: (executable, args) => spawn(executable, args, {
    detached: true, stdio: 'ignore', windowsHide: false, env: relaunchEnvironment(process.env),
  }).unref(),
  log: (line) => { try { appendFileSync(RESTART_LOG, `${new Date().toISOString()} ${line}\n`) } catch {} },
}

/** @returns 'relaunched' | 'stuck' */
export async function restartAfterTeardown(options) {
  const { mainPid, hostPid, executable, marker, closeScript, relaunchArgs = [],
    teardownMs = 15000, closeMs = 10000, terminateMs = 5000, settleMs = 1500, pollMs = 200 } = options
  const d = { ...defaults, ...options.deps }
  const until = async (done, ms) => {
    const deadline = d.now() + ms
    while (!done()) {
      if (d.now() >= deadline) return false
      await d.sleep(pollMs)
    }
    return true
  }
  const gone = (pid) => () => !(pid > 0) || !d.alive(pid)

  d.log(`restart requested main=${mainPid} host=${hostPid}`)
  const toreDown = await until(() => d.exists(marker) || !d.alive(mainPid), teardownMs)
  d.log(toreDown ? 'host teardown finished' : 'host teardown timed out; continuing')
  if (d.alive(mainPid) && closeScript) d.log(`close request: ${await d.requestClose(mainPid, closeScript)}`)
  if (!await until(gone(mainPid), closeMs)) {
    // The backend has already shut down; only the window process is left.
    d.log(`window did not close; terminating: ${await d.terminate(mainPid)}`)
    if (!await until(gone(mainPid), terminateMs)) { d.log('window process is still running; not relaunching'); return 'stuck' }
  }
  if (!await until(gone(hostPid), terminateMs)) {
    d.log(`host did not exit; terminating: ${await d.terminate(hostPid)}`)
    if (!await until(gone(hostPid), terminateMs)) { d.log('host is still running; not relaunching'); return 'stuck' }
  }
  // Let the single-instance lock and file handles of the old processes go first.
  await d.sleep(settleMs)
  d.launch(executable, relaunchArgs)
  d.log('relaunched')
  return 'relaunched'
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mainText, hostText, executable, marker, script, argsText] = process.argv.slice(2)
  const mainPid = Number(mainText), hostPid = Number(hostText)
  let relaunchArgs = []
  try { relaunchArgs = argsText ? JSON.parse(argsText) : [] } catch { relaunchArgs = null }
  if (!Number.isInteger(mainPid) || mainPid <= 0 || !Number.isInteger(hostPid) || !executable || !marker || !script ||
      !Array.isArray(relaunchArgs) || !relaunchArgs.every((value) => typeof value === 'string')) {
    process.exitCode = 2
  } else {
    restartAfterTeardown({ mainPid, hostPid, executable, marker, closeScript: script === '-' ? '' : script, relaunchArgs })
      .then((outcome) => { process.exitCode = outcome === 'relaunched' ? 0 : 3 },
        (error) => { defaults.log(`failed: ${error?.stack || error}`); process.exitCode = 1 })
  }
}
