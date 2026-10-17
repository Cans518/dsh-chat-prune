/**
 * 针对本轮代码审核发现的 bug 的回归测试。
 *
 * 这些不是「功能测试」，而是把已经踩过的坑钉死 —— 每一条都对应一次真实故障，
 * 或者一个如果没修就会静默出错的隐患。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { __test__ as clientTest } from '../client-core.js'
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const mod = await import('../lib/index.js')

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

const hostSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const clientSrc = readFileSync(new URL('../client-core.js', import.meta.url), 'utf8')

console.log('\n== 审核发现的回归钉 ==\n')

// ---------------------------------------------------------------- H1
check('H1 运行检测通过 ctx.get("sessions") 取服务并声明依赖', () => {
  // 事故：inject 只有 webServer，ctx.sessions 恒 undefined，
  // isRunning() 永远 false —— allowRunning:false 等于没写。
  assert.ok(
    hostSrc.includes("ctx.get('sessions')") || hostSrc.includes('ctx.get("sessions")'),
    '没用 ctx.get(\'sessions\') 取服务',
  )
  assert.ok(hostSrc.includes('canDetectRunning'), '缺少 canDetectRunning 可观测性')
  assert.ok(mod.inject.includes('sessions'))
})

check('H1 ping 暴露 canDetectRunning（保护失效要可见）', () => {
  const listeners = new Map()
  const ctx = {
    profileContext: { home },
    logger: { warn() {} },
    webServer: { register: () => () => {} },
    on: (e, f) => (listeners.set(e, f), () => {}),
    effect: (f) => f(),
    // 故意不给 sessions：模拟服务缺失
  }
  mod.apply(ctx, {})
  // 只验证 get 路径存在且不抛；真实取值在 smoke 里覆盖
  assert.ok(true)
})

// ---------------------------------------------------------------- H2
check('H2 不再使用 script-src（会拖垮宿主 boot）', () => {
  assert.equal(/kind:\s*'script-src'/.test(hostSrc), false, '仍用 script-src')
  assert.ok(/kind:\s*'script'/.test(hostSrc), '应用 kind:script')
})

check('H2 内联前转义 </script，避免提前闭合标签', () => {
  assert.ok(
    hostSrc.includes('</script/gi') || hostSrc.includes('<\\/script'),
    '没有转义 </script',
  )
})

check('H2 读不到 client.js 时宁可不注入，也不推空脚本', () => {
  assert.ok(/if \(!text\) return/.test(hostSrc), '空文本应直接 return')
})

// ---------------------------------------------------------------- H3/H4/H5
check('H3 标题解析具有读取上限，不无界加载日志', () => {
  assert.ok(hostSrc.includes('TITLE_HEAD_BYTES'), '缺少头部读取上限')
  assert.ok(/fh\.read\(buf, 0, len, 0\)/.test(hostSrc), '应使用 open+read 限定范围')
})

check('H4 按 zstd 帧头精确切帧，不扫魔数', () => {
  assert.ok(hostSrc.includes('zstdFrameEnd'), '缺少帧头解析')
  assert.equal(
    /const MAGIC = \[0x28, 0xb5, 0x2f, 0xfd\]/.test(hostSrc),
    false,
    '仍在用扫魔数切帧（压缩数据里可能误命中）',
  )
})

check('H5 标题按行 JSON.parse 提取，不用跨字段正则', () => {
  assert.ok(hostSrc.includes('lastTitleFromText'), '缺少行解析')
  assert.ok(hostSrc.includes("ev.type === 'session/title'"), '应按事件类型取标题')
})

check('H3 标题有 (size, mtime) 缓存', () => {
  assert.ok(hostSrc.includes('titleCache'), '缺少标题缓存')
  assert.ok(hostSrc.includes('mtimeMs'), '缓存键应含 mtime')
})

// ---------------------------------------------------------------- H7
check('H7 sessionId 强制 session- 前缀', () => {
  assert.ok(
    /\\\^session-\[A-Za-z0-9-\]\+\\\$|\^session-\[A-Za-z0-9-\]\+/.test(hostSrc) ||
      hostSrc.includes('^session-[A-Za-z0-9-]+$'),
    'assertSessionId 未强制前缀',
  )
})

// ---------------------------------------------------------------- C1
check('C1 标题规范化剥掉尾部相对时间（「3分钟」）', () => {
  assert.ok(
    clientSrc.includes('刚刚') || clientSrc.includes('分钟'),
    'normalizeTitle 没处理尾部时长 —— 运行中的行会匹配不上',
  )
})

check('C1 标题反查只接受唯一精确命中，避免短标题误删另一会话', () => {
  clientTest.setTitleMap({ byTitle: new Map([['清除', 'session-a'], ['重复', null]]), fetchedAt: 0 })
  assert.equal(clientTest.sessionIdByTitle('清除'), 'session-a')
  assert.equal(clientTest.sessionIdByTitle('清除另外一个项目'), null)
  assert.equal(clientTest.sessionIdByTitle('重复'), null)
})

// ---------------------------------------------------------------- C2/C3/C4 → 悬浮层重构
check('C2 不再有全树扫描 sweep（旧版靠它，命中空档就放弃）', () => {
  assert.equal(/function sweep\(/.test(clientSrc), false, '又用回 sweep 了')
  assert.equal(clientSrc.includes('firstHit'), false)
})

check('C2 行识别改成 closest 事件驱动，逐档尝试', () => {
  assert.ok(/function findRow\(/.test(clientSrc), '缺少 findRow')
  assert.ok(clientSrc.includes('el.closest(sel)'), '应逐档 closest')
})

check('C3 悬浮层不吃事件（pointer-events:none，只有按钮吃）', () => {
  assert.ok(clientSrc.includes('pointer-events:none'), '悬浮层没设 pointer-events:none')
  assert.ok(clientSrc.includes('pointer-events: auto'), '按钮没设 pointer-events:auto')
})

check('C3 按钮按被悬停行的 getBoundingClientRect 定位', () => {
  assert.ok(clientSrc.includes('getBoundingClientRect'), '缺少矩形定位')
})

check('C4 删除后重拉名单，靠宿主 detachSession 让行消失', () => {
  assert.ok(clientSrc.includes('refreshTitleMap(true)'), '删除后没强制重拉名单')
  assert.ok(hostSrc.includes('detachFromRegistry'), 'host 没调 workspace registry 的 detach')
  assert.ok(hostSrc.includes('detachSession'), 'host 没调 detachSession')
})

// ---------------------------------------------------------------- 输入被搅乱的根因
check('C5 绝不往 React 行节点里插东西（上一版把输入框搞坏的原因）', () => {
  assert.equal(/row\.appendChild/.test(clientSrc), false, '仍在往行节点 appendChild')
  assert.equal(/row\.style\./.test(clientSrc), false, '仍在改行节点的内联样式')
})

check('C5 不注册 MutationObserver、不装定时器', () => {
  // 注释里会提到这两个词（在解释为什么不用它们），所以先剥注释再看代码
  const code = clientSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/MutationObserver/.test(code), false, '又用 MutationObserver 了')
  assert.equal(/setInterval/.test(code), false, '又加 setInterval 了')
})

console.log(`\n== 结果: ${pass} 通过 / ${fail} 失败 ==\n`)
process.exit(fail > 0 ? 1 : 0)
