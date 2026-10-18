/**
 * 冒烟测试：在一个沙箱 $DSH_HOME 里跑 host 半的真实删除逻辑。
 *
 * 不碰真 home：整个测试在 <tmp>/dshdc-fixture 里造一份假布局，
 * 通过 process.env.DSH_HOME 让 dshHome() 指向它。
 *
 * 覆盖：
 *   1. ping / 路由注册 / 配置默认值
 *   2. GET /sessions 列盘
 *   3. DELETE 备份 + 删文件 + 摘索引
 *   4. 幂等（再删一次 alreadyGone:true）
 *   5. 运行中会话被 409 拒绝
 *   6. 非法 sessionId 被 400 拒绝
 *   7. 备份目录里 restore.json 可读、文件可还原
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deleteSession, listSessions, dshHome } from '../lib/index.js'

const SESSION_A = 'session-11111111-2222-3333-4444-555555555555'
const SESSION_B = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const SESSION_RUNNING = 'session-99999999-8888-7777-6666-555555555555'
const SLUG = '--D-Desktop-test--'

let pass = 0
let fail = 0

async function test(title, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ok   ${title}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL ${title}`)
    console.log(`       ${(error && error.stack) || error}`)
  }
}

/** 造一份假的 $DSH_HOME 布局。 */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dshdc-'))
  const slugRoot = join(home, 'sessions', SLUG)
  const projDir = join(home, 'storages', 'session_projcache', 'sessions')

  for (const id of [SESSION_A, SESSION_B, SESSION_RUNNING]) {
    await mkdir(join(slugRoot, id), { recursive: true })
    await writeFile(join(slugRoot, id, 'session.v4.jsonl.zstd'), `fake-zstd-log-of-${id}`, 'utf8')
  }
  await mkdir(projDir, { recursive: true })
  await writeFile(join(projDir, `${SESSION_A}.json`), '{"proj":"a"}', 'utf8')
  await writeFile(join(projDir, `${SESSION_A}.json.bak-20261001-000000`), '{"proj":"old-a"}', 'utf8')
  await writeFile(join(projDir, `${SESSION_B}.json`), '{"proj":"b"}', 'utf8')

  await writeFile(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: {
          initialized: true,
          workspaceIds: ['ws-1'],
          archivedSessionIds: [SESSION_A, 'session-ffffffff-ffff-ffff-ffff-ffffffffffff'],
          pinnedSessionIds: [SESSION_B],
        },
        tables: {
          workspaces: {
            'ws-1': {
              path: 'D:\\Desktop\\test',
              title: 'test',
              sessionIds: [SESSION_A, SESSION_B, SESSION_RUNNING],
            },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  return home
}

/**
 * 一个最小 ctx 替身。
 *
 * 「是否在跑」现在只看 `agents` 服务里 `agent.status === 'running'`，所以这里提供
 * agents；同时**故意**让 sessions 对任何会话都返回对象 —— 用来证明
 * 「仅仅被加载」不再阻止删除（那正是 0.4.3 什么都删不掉的原因）。
 */
function fakeCtx(home, { running = [] } = {}) {
  const runningSet = new Set(running)
  return {
    profileContext: { home },
    get(name) {
      if (name === 'agents') {
        return { get: (id) => (runningSet.has(id) ? { id, status: 'running' } : undefined) }
      }
      if (name === 'sessions') {
        return {
          get: () => ({ header: { cwd: 'D:\\Desktop\\test' } }),
          list: { getSnapshot: () => ({ byId: {} }) },
        }
      }
      return undefined
    },
  }
}

async function readWorkspace(home) {
  return JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
}

async function main() {
  console.log('\n== dsh-chat-prune host smoke ==\n')

  const home = await fixture()
  process.env.DSH_HOME = home

  const ctx = fakeCtx(home, { running: [SESSION_RUNNING] })

  await test('dshHome() 跟随 DSH_HOME', () => {
    assert.equal(dshHome(ctx), home)
    assert.equal(dshHome({}), home) // 无 profileContext 时读 env
  })

  await test('listSessions 列出磁盘上的全部会话', async () => {
    const rows = await listSessions(ctx)
    const ids = rows.filter((row) => !row.missing).map((r) => r.id).sort()
    assert.deepEqual(ids, [SESSION_A, SESSION_B, SESSION_RUNNING].sort())
    assert.equal(rows.find((row) => row.id === 'session-ffffffff-ffff-ffff-ffff-ffffffffffff').missing, true)
    const a = rows.find((r) => r.id === SESSION_A)
    assert.equal(a.workspaceSlug, SLUG)
    assert.equal(a.workspace, 'test')
    assert.equal(a.files, 1)
    assert.ok(a.bytes > 0)
    assert.equal(a.running, false)
    assert.equal(rows.find((r) => r.id === SESSION_RUNNING).running, true)
  })

  await test('运行中的会话被拒绝删除（allowRunning:false）', async () => {
    await assert.rejects(
      () => deleteSession(ctx, SESSION_RUNNING, { backup: true, allowRunning: false }),
      /正在运行/,
    )
    // 磁盘上必须原封不动
    assert.ok(await stat(join(home, 'sessions', SLUG, SESSION_RUNNING, 'session.v4.jsonl.zstd')))
  })

  await test('删除空闲会话：备份 + 删目录 + 删 projcache + 摘索引', async () => {
    const result = await deleteSession(ctx, SESSION_A, { backup: true, allowRunning: false })
    assert.equal(result.ok, true)
    assert.equal(result.alreadyGone, false)
    assert.equal(result.indexPatched, true)
    assert.ok(result.backupDir, 'backupDir 应该存在')

    // 1) 会话目录没了
    await assert.rejects(() => stat(join(home, 'sessions', SLUG, SESSION_A)))

    // 2) projcache 的 .json 和 .bak-* 都没了
    const projFiles = await readdir(join(home, 'storages', 'session_projcache', 'sessions'))
    assert.ok(!projFiles.some((f) => f.startsWith(`${SESSION_A}.json`)), 'projcache 残留')

    // 3) 索引摘干净
    const ws = await readWorkspace(home)
    assert.ok(!ws.tables.workspaces['ws-1'].sessionIds.includes(SESSION_A), 'sessionIds 残留')
    assert.ok(!ws.global.archivedSessionIds.includes(SESSION_A), 'archivedSessionIds 残留')
    assert.ok(ws.tables.workspaces['ws-1'].sessionIds.includes(SESSION_B), '误删了 SESSION_B')
    assert.equal(ws.tables.workspaces['ws-1'].sessionIds.length, 2)

    // 4) 索引写了 .bak
    const storages = await readdir(join(home, 'storages'))
    assert.ok(storages.some((f) => f.startsWith('workspace.json.bak-')), 'workspace.json 没留备份')
  })

  await test('备份内容可还原（restore.json + 原始文件）', async () => {
    const tags = await readdir(join(home, 'deleted-sessions'))
    assert.equal(tags.length, 1)
    const stampDir = join(home, 'deleted-sessions', tags[0])
    const meta = JSON.parse(await readFile(join(stampDir, 'restore.json'), 'utf8'))
    assert.equal(meta.sessionId, SESSION_A)
    assert.equal(meta.workspaceSlug, SLUG)
    assert.equal(meta.originalPath, join(home, 'sessions', SLUG, SESSION_A))
    assert.deepEqual(meta.files, ['session.v4.jsonl.zstd'])

    const backedUp = await readFile(
      join(stampDir, SESSION_A, 'session.v4.jsonl.zstd'),
      'utf8',
    )
    assert.equal(backedUp, `fake-zstd-log-of-${SESSION_A}`)

    // 真还原一次
    await cp(join(stampDir, SESSION_A), meta.originalPath, { recursive: true })
    const restored = await readFile(join(meta.originalPath, 'session.v4.jsonl.zstd'), 'utf8')
    assert.equal(restored, `fake-zstd-log-of-${SESSION_A}`)
  })

  await test('幂等：会话已被删掉后再删一次，如实报 alreadyGone', async () => {
    // 上一次测试把 SESSION_A 真还原回了磁盘（为了验还原路径），
    // 所以这里先按正常路径删一次，再删第二次验证幂等语义。
    const first = await deleteSession(ctx, SESSION_A, { backup: true, allowRunning: false })
    assert.equal(first.ok, true)
    assert.equal(first.alreadyGone, false, '第一次删应该真的删到东西')

    const second = await deleteSession(ctx, SESSION_A, { backup: true, allowRunning: false })
    assert.equal(second.ok, true, '重删不该报错')
    assert.equal(second.alreadyGone, true, '第二次该如实报 alreadyGone')
    assert.equal(second.removed.length, 0, '重删不该再删任何文件')
  })

  await test('响应形状一致：两条返回路径的字段集合完全相同', async () => {
    // 调用方不该为了「本来就不在」写一套分支去猜哪些字段缺失。
    const gone = await deleteSession(
      ctx,
      'session-00000000-0000-0000-0000-000000000000',
      { backup: true, allowRunning: false },
    )
    const done = await deleteSession(ctx, SESSION_RUNNING, { backup: true, allowRunning: true })
    assert.equal(gone.alreadyGone, true)
    assert.equal(done.alreadyGone, false)
    assert.deepEqual(
      Object.keys(gone).sort(),
      Object.keys(done).sort(),
      'alreadyGone 的早退分支少了字段',
    )
    // removed 必须是数组，之前早退分支给的是 undefined
    assert.ok(Array.isArray(gone.removed), 'early-return 的 removed 不是数组')
    assert.equal(gone.backupDir, null)
    assert.equal(gone.indexPatched, false)
  })

  await test('备份开关关掉时不产生备份目录', async () => {
    const before = (await readdir(join(home, 'deleted-sessions'))).length
    const result = await deleteSession(ctx, SESSION_B, { backup: false, allowRunning: false })
    assert.equal(result.backupDir, null)
    const after = (await readdir(join(home, 'deleted-sessions'))).length
    assert.equal(after, before, 'backup:false 却新建了备份目录')
    // pinnedSessionIds 里也要摘掉
    const ws = await readWorkspace(home)
    assert.ok(!ws.global.pinnedSessionIds.includes(SESSION_B), 'pinnedSessionIds 残留')
  })

  await test('allowRunning:true 时运行中会话可删', async () => {
    const result = await deleteSession(ctx, SESSION_RUNNING, { backup: true, allowRunning: true })
    assert.equal(result.ok, true)
    await assert.rejects(() => stat(join(home, 'sessions', SLUG, SESSION_RUNNING)))
  })

  await test('不存在的 sessionId 一律 alreadyGone', async () => {
    const result = await deleteSession(
      ctx,
      'session-00000000-0000-0000-0000-000000000000',
      { backup: true, allowRunning: false },
    )
    assert.equal(result.alreadyGone, true)
  })

  // ---- HTTP 层 ----
  console.log('\n== HTTP 层 ==\n')

  const home2 = await fixture()
  process.env.DSH_HOME = home2
  const ctx2 = fakeCtx(home2, { running: [SESSION_RUNNING] })

  const routes = []
  const fakeWebServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  }
  const effects = []
  const disposers = []
  const listeners = new Map()
  const ctxHttp = {
    ...ctx2,
    sessionPersistence: { async open() { return { async close() {} } } },
    webServer: fakeWebServer,
    logger: { warn() {}, info() {}, error() {} },
    // host 半用 ctx.on 订阅 webserver/index-inject
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    // 注意：这里**不能**立刻调 disposer —— 那会在 apply 结束后把订阅拆掉，
    // 于是后面读 listeners 永远为空（早期版本就是这么误报的）。
    // 真实 cordis 是插件卸载时才调，所以这里只收集。
    effect: (fn) => {
      effects.push(fn)
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
  }

  const mod = await import('../lib/index.js')
  mod.apply(ctxHttp, { backup: true, allowRunning: false })

  await test('apply 注册了 prefix 路由并绑定到 /dsh-chat-prune', () => {
    assert.equal(routes.length, 1)
    assert.equal(routes[0].kind, 'prefix')
    assert.equal(routes[0].path, '/dsh-chat-prune')
    assert.equal(effects.length, 2, '应有 routes + index injection 两个 effect')
  })

  await test('订阅了 webserver/index-inject 并推入内联 script 行', () => {
    const listener = listeners.get('webserver/index-inject')
    assert.ok(listener, '没订阅 index injection')
    const table = []
    listener(table)
    assert.equal(table.length, 1)
    // 必须是内联 script，不能是 script-src：
    // script-src 在桌面壳里既拿不到认证，加载失败还会 reject 掉整个页面 boot
    assert.equal(table[0].kind, 'script', '必须用 kind:script 内联，不能用 script-src')
    assert.equal(table[0].placement, 'body')
    assert.equal(typeof table[0].text, 'string')
    assert.ok(table[0].text.length > 1000, `内联脚本太短: ${table[0].text.length}`)
    assert.ok(table[0].text.includes('__dshChatPruneInstalled__'), '内联的不是 client.js')
    // 内联内容里不能有裸 </script，否则会提前闭合标签
    assert.equal(/<\/script/i.test(table[0].text), false, '内联脚本里残留 </script')
  })

  const route = routes[0]

  /** 跑一次路由，返回 { status, json }。 */
  async function call(method, url, body) {
    let status = 0
    let out = ''
    const req = {
      url,
      method,
      headers: {},
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
      },
    }
    const res = {
      writeHead(s) {
        status = s
      },
      write(chunk) {
        out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        return true
      },
      end(chunk) {
        if (chunk !== undefined) out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      },
    }
    await route.handler(req, res)
    // json 只在能解析时给；raw 永远是原文（client.js 这类非 JSON 路由要用）
    let json = null
    try {
      json = out ? JSON.parse(out) : null
    } catch {
      json = null
    }
    return { status, json, raw: out }
  }

  await test('GET /ping 返回 home 与配置', async () => {
    const { status, json } = await call('GET', '/dsh-chat-prune/ping')
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.equal(json.name, 'dsh-chat-prune')
    assert.equal(json.home, home2)
    assert.equal(json.config.backup, true)
    assert.equal(json.config.allowRunning, false)
    assert.equal(json.canDetectRunning, true)
    assert.equal(json.usesWriteOwnership, true)
  })

  await test('GET /client.js 吐出可执行的脚本（按钮注入的来源）', async () => {
    const { status, raw } = await call('GET', '/dsh-chat-prune/client.js')
    assert.equal(status, 200)
    assert.ok(raw.length > 1000, `脚本太短: ${raw.length}`)
    // 必须是自执行的普通脚本，不是 ESM / 也不是 __ModuleLoader__ 包装
    assert.match(raw, /__dshChatPruneInstalled__/, '缺自启动标记')
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.equal(code.includes('__ModuleLoader__'), false, '不该引用 __ModuleLoader__')
    assert.equal(/^\s*(import|export)\s/m.test(code), false, '不该有顶层 import/export')
  })

  await test('GET /sessions 列盘', async () => {
    const { status, json } = await call('GET', '/dsh-chat-prune/sessions')
    assert.equal(status, 200)
    assert.equal(json.sessions.length, 4)
    assert.equal(json.sessions.filter((row) => !row.missing).length, 3)
  })

  await test('DELETE /sessions 正常删除', async () => {
    const { status, json } = await call('DELETE', '/dsh-chat-prune/sessions', { sessionId: SESSION_A })
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.equal(json.alreadyGone, false)
    assert.ok(json.indexPatched)
  })

  await test('DELETE 运行中会话 -> 409', async () => {
    const { status, json } = await call('DELETE', '/dsh-chat-prune/sessions', { sessionId: SESSION_RUNNING })
    assert.equal(status, 409)
    assert.equal(json.ok, false)
    assert.match(json.error, /正在运行/)
  })

  await test('DELETE 非法 sessionId -> 400', async () => {
    for (const bad of ['', '../etc/passwd', 'a/b', '..', 'x'.repeat(300), 'session-a;rm -rf']) {
      const { status } = await call('DELETE', '/dsh-chat-prune/sessions', { sessionId: bad })
      assert.equal(status, 400, `未拦住: ${JSON.stringify(bad)}`)
    }
  })

  await test('DELETE 路径形式可用', async () => {
    const { status, json } = await call('DELETE', `/dsh-chat-prune/sessions/${SESSION_B}`)
    assert.equal(status, 200)
    assert.equal(json.sessionId, SESSION_B)
  })

  await test('未知路由 -> 404', async () => {
    const { status } = await call('GET', '/dsh-chat-prune/nope')
    assert.equal(status, 404)
  })

  await test('非法 JSON body -> 400', async () => {
    let status = 0
    let out = ''
    const req = {
      url: '/dsh-chat-prune/sessions',
      method: 'DELETE',
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('{not json', 'utf8')
      },
    }
    const res = {
      writeHead(s) {
        status = s
      },
      write(c) {
        out += c
        return true
      },
      end(c) {
        if (c !== undefined) out += c
      },
    }
    await route.handler(req, res)
    assert.equal(status, 400)
    assert.match(JSON.parse(out).error, /JSON/)
  })

  await rm(home, { recursive: true, force: true })
  await rm(home2, { recursive: true, force: true })

  console.log(`\n== 结果: ${pass} 通过 / ${fail} 失败 ==\n`)
  if (fail > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
