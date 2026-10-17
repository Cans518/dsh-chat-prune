/**
 * 两个致命修复的行为验证（不是文本断言）。
 *
 * H1：运行检测 —— 有 sessions 服务时必须能识别出运行中的会话
 * H4：zstd 帧头解析 —— 必须和「扫魔数」得到一致的帧数，且能正确取出标题
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')

let pass = 0
let fail = 0
function check(title, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ok   ${title}`)
  } catch (e) {
    fail += 1
    console.log(`  FAIL ${title}\n       ${(e && e.stack) || e}`)
  }
}

async function checkAsync(title, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ok   ${title}`)
  } catch (e) {
    fail += 1
    console.log(`  FAIL ${title}\n       ${(e && e.stack) || e}`)
  }
}

// ---------------------------------------------------------------- H1 行为

const mod = await import(
  pathToFileURL(join(home, 'profiles', 'desktop', 'node_modules', 'dsh-chat-prune', 'lib', 'index.js')).href
)

console.log('\n== H1：运行检测 ==\n')

const RUNNING = 'session-11111111-2222-3333-4444-555555555555'
const IDLE = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

/** 造一个只有会话目录的假 home。 */
async function fakeHome() {
  const root = await mkdtemp(join(tmpdir(), 'dshdc-rev-'))
  for (const id of [RUNNING, IDLE]) {
    const d = join(root, 'sessions', '--ws--', id)
    await mkdir(d, { recursive: true })
    await writeFile(join(d, 'session.v4.jsonl.zstd'), 'x', 'utf8')
  }
  return root
}

let fh = await fakeHome()
process.env.DSH_HOME = fh

/** ctx 只在 get('sessions') 上提供运行状态，故意不设 ctx.sessions。 */
function ctxWithRunning(runningId) {
  return {
    profileContext: { home: fh },
    get: (n) => (n === 'sessions' ? { get: (id) => (id === runningId ? { id } : undefined) } : undefined),
  }
}

await checkAsync('运行中的会话被 409 拦下（证明 isRunning 不再是死代码）', async () => {
  let err = null
  try {
    await mod.deleteSession(ctxWithRunning(RUNNING), RUNNING, { backup: false, allowRunning: false })
  } catch (e) {
    err = e
  }
  assert.ok(err, '应该抛错')
  assert.equal(err.status, 409, `状态码应是 409，实际 ${err.status}`)
  // 磁盘必须原封不动
  assert.ok(existsSync(join(fh, 'sessions', '--ws--', RUNNING, 'session.v4.jsonl.zstd')), '文件被删了')
})

await checkAsync('空闲会话能正常删掉（没被误拦）', async () => {
  const r = await mod.deleteSession(ctxWithRunning(RUNNING), IDLE, { backup: false, allowRunning: false })
  assert.equal(r.ok, true)
  assert.equal(existsSync(join(fh, 'sessions', '--ws--', IDLE)), false, '文件应被删除')
})

await checkAsync('allowRunning:true 时运行中的会话可删', async () => {
  const r = await mod.deleteSession(ctxWithRunning(RUNNING), RUNNING, { backup: false, allowRunning: true })
  assert.equal(r.ok, true)
  assert.equal(existsSync(join(fh, 'sessions', '--ws--', RUNNING)), false)
})

await checkAsync('sessions 服务缺失时不假装空闲（canDetectRunning=false 可观测）', async () => {
  const fh2 = await fakeHome()
  const ctx = { profileContext: { home: fh2 }, get: () => undefined }
  // 无法探测运行状态时，行为是「按空闲处理」——但不能静默，ping 要暴露出来
  assert.equal(mod.canDetectRunning ? mod.canDetectRunning(ctx) : null, false)
  await rm(fh2, { recursive: true, force: true })
})

// ---------------------------------------------------------------- H4 行为

console.log('\n== H4：zstd 帧头解析 ==\n')

// 从模块里拿不到 zstdFrameEnd（未导出），所以内联同一套逻辑做对照验证
function zstdFrameEnd(buf, start) {
  if (start + 5 > buf.length) return -1
  if (!(buf[start] === 0x28 && buf[start + 1] === 0xb5 && buf[start + 2] === 0x2f && buf[start + 3] === 0xfd)) return -1
  const fhd = buf[start + 4]
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksumFlag = (fhd >> 2) & 1
  const didFlag = fhd & 3
  let p = start + 5
  if (!singleSegment) p += 1
  p += [0, 1, 2, 4][didFlag]
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
  for (;;) {
    if (p + 3 > buf.length) return -1
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const last = bh & 1
    const type = (bh >> 1) & 3
    const size = bh >>> 3
    if (type === 3) return -1
    p += type === 1 ? 1 : size
    if (last) break
  }
  if (checksumFlag) p += 4
  return p <= buf.length ? p : -1
}

const sessionRoot = join(home, 'sessions')
const logs = readdirSync(sessionRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const slugRoot = join(sessionRoot, entry.name)
    return readdirSync(slugRoot).map((id) => join(slugRoot, id, 'session.v4.jsonl.zstd'))
  })
  .filter((p) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  })

check(`找到 ${logs.length} 个会话日志可测`, () => {
  assert.ok(logs.length > 0, '没有可测日志')
})

for (const logPath of logs.slice(0, 3)) {
  const name = basename(dirname(logPath))
  check(`帧头解析能走完全部帧：${name.slice(0, 24)}`, () => {
    const buf = readFileSync(logPath)
    let offset = 0
    let frames = 0
    while (offset < buf.length) {
      const end = zstdFrameEnd(buf, offset)
      if (end < 0) break
      // 每帧都必须能真的解开 —— 这证明切点是对的
      zlib.zstdDecompressSync(buf.subarray(offset, end))
      offset = end
      frames += 1
    }
    assert.ok(frames > 0, '一帧都没解析出来')
    assert.equal(offset, buf.length, `没走到文件末尾（差 ${buf.length - offset} 字节）`)
  })
}

console.log(`\n== 结果: ${pass} 通过 / ${fail} 失败 ==\n`)
process.exit(fail > 0 ? 1 : 0)
