/**
 * 发布前的元数据/结构自检。
 *
 * 商店的「DSH 插件规范检查」看的就是这些：字段齐不齐、声明的入口文件在不在、
 * files 白名单有没有漏掉运行期需要的东西。本地先跑一遍，别等被筛下来才知道。
 *
 *   node scripts/check-metadata.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = []
const checks = []

function check(name, fn) {
  try {
    const detail = fn()
    checks.push([true, name, detail ?? ''])
  } catch (e) {
    checks.push([false, name, e.message])
    problems.push(`${name}: ${e.message}`)
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const REQUIRED = ['name', 'version', 'description', 'license', 'repository', 'homepage', 'author', 'keywords', 'files', 'main']

check('必要字段齐全', () => {
  const missing = REQUIRED.filter((k) => pkg[k] === undefined || pkg[k] === '')
  if (missing.length) throw new Error(`缺 ${missing.join(', ')}`)
  return REQUIRED.length + ' 个'
})

check('engines.dsh 存在（商店兼容性缓存读它）', () => {
  const range = pkg.engines?.dsh
  if (!range) throw new Error('缺少 engines.dsh')
  if (!/^[<>=~^0-9]/.test(range)) throw new Error(`范围看起来不合法: ${range}`)
  return range
})

check('dsh.manifestVersion', () => {
  if (pkg.dsh?.manifestVersion !== 1) throw new Error(`期望 1，实际 ${JSON.stringify(pkg.dsh?.manifestVersion)}`)
  return '1'
})

check('dsh.bundle.patch 指向存在的文件', () => {
  const p = pkg.dsh?.bundle?.patch
  if (!p) throw new Error('缺少 dsh.bundle.patch')
  if (!existsSync(join(root, p))) throw new Error(`文件不存在: ${p}`)
  return p
})

check('dsh.client 声明了 platform', () => {
  const c = pkg.dsh?.client
  if (!c) throw new Error('缺少 dsh.client')
  if (c.platform !== 'web') throw new Error(`platform 期望 web，实际 ${c.platform}`)
  return `${c.platform}, inject ${c.inject?.length ?? 0} 项`
})

check('exports["./client"] 指向存在的文件', () => {
  const p = pkg.exports?.['./client']
  if (!p) throw new Error('缺少 ./client 导出')
  const file = typeof p === 'string' ? p : p.default
  if (!existsSync(join(root, file))) throw new Error(`文件不存在: ${file}`)
  return file
})

check('main 与 exports["."] 指向存在的文件', () => {
  const main = pkg.main
  if (!main || !existsSync(join(root, main))) throw new Error(`main 不存在: ${main}`)
  const dot = pkg.exports?.['.']
  const file = typeof dot === 'string' ? dot : dot?.default
  if (file && !existsSync(join(root, file))) throw new Error(`exports["."] 不存在: ${file}`)
  return main
})

check('icon 指向存在的文件', () => {
  const icon = pkg.icon
  if (!icon) throw new Error('缺少 icon')
  if (!existsSync(join(root, icon))) throw new Error(`文件不存在: ${icon}`)
  return icon
})

check('cordis.patch.yml 里的 insert 与包名一致', () => {
  const text = readFileSync(join(root, pkg.dsh.bundle.patch), 'utf8')
  if (!text.includes(`id: ${pkg.name}`)) throw new Error(`patch 里没有 id: ${pkg.name}`)
  if (!text.includes(`name: '${pkg.name}'`) && !text.includes(`name: "${pkg.name}"`)) {
    throw new Error(`patch 里没有 name: '${pkg.name}'`)
  }
  return pkg.name
})

check('files 白名单覆盖所有运行期文件', () => {
  // 运行期真正会被 import 的东西 + 补丁 + 图标
  const runtime = ['lib/index.js', pkg.dsh.bundle.patch.replace(/^\.\//, ''), pkg.icon.replace(/^\.\//, '')]
  const entry = pkg.exports?.['./client']
  if (entry) runtime.push((typeof entry === 'string' ? entry : entry.default).replace(/^\.\//, ''))
  runtime.push(pkg.main)

  const patterns = pkg.files ?? []
  const covered = (rel) =>
    patterns.some((p) => rel === p || rel.startsWith(p.replace(/\/$/, '') + '/'))

  const missing = runtime.filter((rel) => !covered(rel))
  if (missing.length) throw new Error(`files 未覆盖: ${missing.join(', ')}`)
  return runtime.length + ' 个'
})

check('没有会破坏 git 安装的 prepare 脚本', () => {
  if (pkg.scripts?.prepare) {
    throw new Error('prepare 会让 pnpm 拒绝 git 依赖（ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED）')
  }
  return 'ok'
})

check('构建产物已提交', () => {
  // 两个都要：client.js 是 host 半内联注入的构建产物；
  // client-slot.js 是 dsh.client 声明的原生 slot 入口。
  const built = join(root, 'client.js')
  if (!existsSync(built)) throw new Error('client.js 不存在（需要 npm run build 并提交）')
  const builtSize = statSync(built).size
  if (builtSize < 10_000) throw new Error(`client.js 只有 ${builtSize}B，不像构建产物`)

  const entry = pkg.exports?.['./client']
  const file = (typeof entry === 'string' ? entry : entry?.default)?.replace(/^\.\//, '')
  if (!file || !existsSync(join(root, file))) throw new Error(`client 入口不存在: ${file}`)
  return `client.js ${builtSize}B + ${file}`
})

// ---------------------------------------------------------------- 输出

for (const [ok, name, detail] of checks) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  —  ${detail}` : ''}`)
}

console.log('')
if (problems.length > 0) {
  console.log(`元数据检查失败 ${problems.length} 项：`)
  for (const p of problems) console.log(`  - ${p}`)
  process.exit(1)
}
console.log(`元数据检查通过（${checks.length} 项）`)
