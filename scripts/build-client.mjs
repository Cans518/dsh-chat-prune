/**
 * 把 client-core.js（可单测的 ESM）打成 client.js（浏览器直接执行的自包含脚本）。
 *
 * 为什么需要这一步：
 *   client-core.js 是 ESM（export 函数），便于 node 单测；
 *   而浏览器侧本插件以**普通 <script>** 加载（由 host 半通过 webserver 的
 *   index injection 表插入 <script src="/dsh-delete-chat/client.js">），
 *   不经过任何打包器，也不经过 __ModuleLoader__。
 *
 * 做法：
 *   1. 读 client-core.js
 *   2. 剥掉 ESM 语法（export 标记 → 普通声明；去掉 import 行）
 *   3. 包进一个 IIFE：定义完就地用最小 ctx 替身启动
 *
 * client.js 是产物，不要手改 —— 改 client-core.js 后重跑本脚本。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Script } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

const src = readFileSync(join(root, 'client-core.js'), 'utf8')

/** 剥掉 ESM 语法，保留缩进结构。 */
function stripEsm(code) {
  const lines = code.split('\n')
  const out = []

  for (const line of lines) {
    // 顶层 import —— 本文件本来就没有，有的话直接丢掉
    if (/^\s*import\s.+from\s.+$/.test(line) || /^\s*import\s+['"]/.test(line)) continue

    // export const x = ...        -> const x = ...
    // export function f() {...}   -> function f() {...}
    // export default {...}        -> 丢掉（factory 自己造 exports）
    if (/^\s*export\s+default\b/.test(line)) continue
    if (/^\s*export\s*\{[^}]*\}\s*;?\s*$/.test(line)) continue

    const m = /^(\s*)export\s+(const|let|var|function|class|async\s+function)\b/.exec(line)
    if (m) {
      out.push(line.replace(/^(\s*)export\s+/, '$1'))
      continue
    }

    out.push(line)
  }

  return out.join('\n')
}

const body = stripEsm(src)

// 单测用的 CJS 兜底在浏览器里没有意义，剥掉那段（它引用了 module/exports）
const bodyNoCjs = body.replace(
  /\/\* __CJS_EXPORT_START__ \*\/[\s\S]*?\/\* __CJS_EXPORT_END__ \*\//g,
  '',
)

// 单测用的内部函数表同样剥掉：浏览器里没人引用，留着只是白占体积
const bodyNoTest = bodyNoCjs.replace(
  /\/\* __TEST_SURFACE_START__ \*\/[\s\S]*?\/\* __TEST_SURFACE_END__ \*\//g,
  '',
)

const output = `/**
 * dsh-delete-chat — client 入口（构建产物，勿手改）。
 *
 * 由 scripts/build-client.mjs 从 client-core.js 生成。
 * 改逻辑请改 client-core.js，然后重跑：
 *     node scripts/build-client.mjs
 *
 * 加载方式：宿主渲染 index.html 时读 webserver 的 index injection 表，
 * 我们通过 host 半推一行 { kind: 'script', placement: 'body', text }，
 * 本文件以内联普通 <script> 被加载。
 *
 * 因此它不是 ESM（没有 import/export，也没走 __ModuleLoader__），
 * 而是一段直接执行的自包含脚本：定义完函数就地启动。
 * 此入口负责管理窗口与兼容层；原生 React 槽入口为 client-slot.js。
 */
(function () {
  "use strict";
  if (typeof document === "undefined") return;
  // 防重复注入（HMR / 路由重渲染可能多次插入同一 script）
  if (window.__dshDeleteChatInstalled__) return;
  window.__dshDeleteChatBuildVersion__ = ${JSON.stringify(version)};

// ---------- begin client-core.js ----------
${bodyNoTest}
// ---------- end client-core.js ----------

  /**
   * 直接启动。这里没有宿主 ctx，于是给一个最小替身：
   * client-core 只用到 ctx.locale（可选）与 ctx.effect（清理钩子）。
   */
  var hostCtx = {
    locale: undefined,
    effect: function (fn) {
      var dispose = fn();
      window.addEventListener("pagehide", function () {
        try { if (typeof dispose === "function") dispose(); } catch (e) {}
      }, { once: true });
    },
  };

  function start() {
    if (window.__dshDeleteChatInstalled__ || !document.body) return;
    try {
      apply(hostCtx);
      window.__dshDeleteChatInstalled__ = true;
      console.info("[dsh-delete-chat] client installed");
    } catch (error) {
      window.__dshDeleteChatInstalled__ = false;
      console.error("[dsh-delete-chat] client apply failed:", error);
    }
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) start();
  });
})();
`

// 产物自检：不许有任何顶层 import/export
const bad = output
  .split('\n')
  .map((l, i) => ({ l, i: i + 1 }))
  .filter(({ l }) => /^\s*(import|export)\s/.test(l))

if (bad.length > 0) {
  console.error('build 失败：产物里仍有顶层 import/export')
  for (const { l, i } of bad) console.error(`  ${i}: ${l.trim()}`)
  process.exit(1)
}

// 自检：不许再有 __ModuleLoader__ 的**代码调用**（那是 dsh.client 机制的入口）。
// 注释里提到它是允许的 —— 前面那段说明性文字就在解释为什么不用它。
const codeOnly = output
  .replace(/\/\*[\s\S]*?\*\//g, '') // 去块注释
  .replace(/^\s*\/\/.*$/gm, '') // 去行注释
if (codeOnly.includes('__ModuleLoader__')) {
  console.error('build 失败：产物代码里仍引用 __ModuleLoader__')
  process.exit(1)
}

// Parse before replacing a working artifact.
new Script(output, { filename: 'client.js' })
writeFileSync(join(root, 'client.js'), output, 'utf8')
console.log(`client.js 已生成 (${output.length} bytes, 零 import, 自执行脚本)`)
