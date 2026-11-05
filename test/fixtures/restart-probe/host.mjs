// The probe backend: runs the real restart controller. Its SIGTERM handler copies
// the `dsh` profile boot (interrupt -> dispose -> process.exit) with a session write.
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = process.env.PROBE_OUT
const log = (line) => appendFileSync(join(out, 'events.log'), `${Date.now()} host ${line}\n`)
const { createRestartController } = await import(pathToFileURL(process.env.PROBE_RESTART_MODULE).href)

process.on('SIGTERM', () => {
  log('dispose start')
  setTimeout(() => {
    writeFileSync(join(out, 'session.flushed'), 'ok')
    log('dispose done')
    process.exit(0)
  }, 400)
})
setInterval(() => {}, 1000)
const restart = createRestartController({
  imageName: async () => 'electron.exe', tmp: out, delayMs: 100,
  relaunchArgs: [join(import.meta.dirname, 'main.cjs')],
})
const result = await restart.restart()
log(`restart ok=${result.ok} supported=${result.supported}`)
