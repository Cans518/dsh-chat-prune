// A DSH-shaped Electron app: the window process copies the DSH 0.2.2 quit logic
// (hide to tray on close, graceful quit only after session end, backend failure
// reporting), and the backend is a Node-mode child like the DSH host.
const { app, BrowserWindow, Tray, nativeImage } = require('electron')
const { spawn } = require('node:child_process')
const { appendFileSync, existsSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const out = process.env.PROBE_OUT
const log = (line) => appendFileSync(join(out, 'events.log'), `${Date.now()} main ${line}\n`)
const second = existsSync(join(out, 'first.pid'))
app.setPath('userData', join(out, second ? 'userData2' : 'userData'))
let quitting = false, sessionEnding = false, tray

app.whenReady().then(() => {
  if (second) {
    writeFileSync(join(out, 'second.pid'), String(process.pid))
    log(`relaunched pid=${process.pid} runAsNode=${process.env.ELECTRON_RUN_AS_NODE ?? 'unset'}`)
    quitting = true
    app.quit()
    return
  }
  tray = new Tray(nativeImage.createEmpty())
  const window = new BrowserWindow({ width: 400, height: 300, show: process.env.PROBE_SHOW === '1', title: 'Probe Harness' })
  window.loadURL('data:text/html,<title>Probe Harness</title>probe')
  window.on('close', (event) => {
    log(`window-close sessionEnding=${sessionEnding}`)
    if (quitting || sessionEnding) return
    event.preventDefault()
    window.hide()
  })
  window.on('session-end', () => { sessionEnding = true; log('session-end') })
  const host = spawn(process.execPath, [join(__dirname, 'host.mjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  host.on('close', (code, signal) => log(code === 0 || code === null || signal ? 'host-closed' : `host-failed code=${code}`))
  host.on('message', (message) => { if (message === 'shutdown-complete') log('host-failed unrequested-shutdown') })
  writeFileSync(join(out, 'first.pid'), String(process.pid))
  log('ready')
})
app.on('window-all-closed', () => app.quit())
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  log(sessionEnding ? 'before-quit graceful' : 'before-quit needs-confirmation')
})
