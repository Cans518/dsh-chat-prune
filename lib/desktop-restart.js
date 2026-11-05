/**
 * Host half of the sidebar "restart DSH" button (Windows desktop only).
 *
 * The desktop main process starts this host as a Node-mode child of its own
 * executable, so `process.ppid` is the DSH window process and `process.execPath`
 * is the DSH executable. A restart:
 *   1. starts lib/restart-watcher.js detached, outside the DSH process tree;
 *   2. runs the host's own graceful shutdown (the SIGTERM path of `dsh` profile
 *      boot): session writers close, tasks stop and every plugin is disposed;
 *   3. instead of exiting, touches a marker and waits, so the window process does
 *      not report a crashed backend; the watcher then closes the window process
 *      and opens DSH again.
 */

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Image name of a Windows process, or '' when it cannot be read. */
export function windowsImageName(pid) {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 },
      (error, stdout) => resolve(error ? '' : (/^"([^"]+)"/m.exec(String(stdout))?.[1] ?? '')))
  })
}

export function createRestartController({
  platform = process.platform, env = process.env, ppid = process.ppid, pid = process.pid,
  execPath = process.execPath, electron = process.versions.electron, imageName = windowsImageName,
  spawnImpl = spawn, watcherPath = join(here, 'restart-watcher.js'), closeScript = join(here, 'request-close.ps1'),
  tmp = tmpdir(), proc = process, schedule = setTimeout, keepAlive = () => setInterval(() => {}, 1000),
  writeMarker = (file) => writeFileSync(file, ''), delayMs = 500, teardownFallbackMs = 12000,
  relaunchArgs, // tests only: arguments for the reopened executable
} = {}) {
  let support, restarting = false

  async function supported() {
    support ??= (async () => {
      if (platform !== 'win32' || env.ELECTRON_RUN_AS_NODE !== '1' || !electron || !(ppid > 1)) return false
      // Only act when the parent really is the desktop window of this installation.
      return (await imageName(ppid)).toLowerCase() === basename(execPath).toLowerCase()
    })().catch(() => false)
    return support
  }

  async function status() {
    return { ok: true, supported: await supported(), restarting }
  }

  function teardown(marker) {
    const exit = proc.exit.bind(proc)
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      try { writeMarker(marker) } catch {}
    }
    // Every exit path of the graceful shutdown ends in process.exit(); report it instead,
    // and keep the process alive so the window process sees no backend failure.
    proc.exit = () => { finish() }
    keepAlive()
    // The IPC channel closes when the window process is gone; leave with it.
    proc.once?.('disconnect', () => exit(0))
    const fallback = schedule(finish, teardownFallbackMs)
    fallback?.unref?.()
    proc.emit('SIGTERM')
  }

  async function restart() {
    if (!await supported()) return { ...await status(), ok: false, error: '当前环境无法自动重启 DSH' }
    if (restarting) return status()
    const marker = join(tmp, `dsh-chat-prune-restart-${randomUUID()}.done`)
    spawnImpl(execPath, [watcherPath, String(ppid), String(pid), execPath, marker, closeScript,
      ...relaunchArgs ? [JSON.stringify(relaunchArgs)] : []], {
      detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    }).unref?.()
    restarting = true
    // Let the HTTP response reach the page before the web server is disposed.
    schedule(() => teardown(marker), delayMs)
    return status()
  }

  return { status, restart }
}
