/**
 * 检查本插件在两个 DSH 商店目录里的收录状态。
 *
 *   node scripts/check-listing.mjs dsh-chat-prune
 *
 * 两个目录都是只读公开 API：
 *   - 1024Store  https://deepseek1024.com/api/v2/plugins
 *   - dshfind    https://api.dshfind.com/market/v1/plugins
 *
 * 退出码 0 = 至少一个目录已收录；1 = 都还没有（通常只是还没到同步时间）。
 */

const query = process.argv[2] || 'dsh-chat-prune'
const owner = process.argv[3] || 'Cans518'

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return r.json()
}

function line(label, value) {
  console.log(`  ${label.padEnd(14)} ${value}`)
}

let listed = 0

// ---------------------------------------------------------------- 1024Store

console.log(`\n== 1024Store ==`)
try {
  const url = `https://deepseek1024.com/api/v2/plugins?page=1&limit=20&q=${encodeURIComponent(query)}`
  const data = await getJson(url)
  const hits = (data.plugins || []).filter(
    (p) =>
      p.name === query ||
      String(p.id || '').toLowerCase().includes(owner.toLowerCase()) ||
      String(p.url || '').toLowerCase().includes(owner.toLowerCase()),
  )
  line('目录总量', String(data.catalogTotal ?? '?'))
  line('数据时间', data.generatedAt || '?')
  line('命中', String(hits.length))
  if (hits.length > 0) {
    listed += 1
    for (const p of hits.slice(0, 5)) {
      line('  · 条目', `${p.id}  (${p.category})`)
      line('    安装', p.install || '(无)')
    }
  } else {
    console.log('  → 尚未收录。该目录需要先通过 DSH 插件规范检查与人工筛查。')
  }
} catch (e) {
  console.log(`  查询失败: ${e.message}`)
}

// ---------------------------------------------------------------- dshfind

console.log(`\n== dshfind ==`)
try {
  const url = `https://api.dshfind.com/market/v1/plugins?limit=20&q=${encodeURIComponent(query)}`
  const data = await getJson(url)
  const items = data.items || []
  line('快照时间', data.generatedAt || '?')
  line('命中', String(items.length))
  if (items.length > 0) {
    listed += 1
    for (const p of items.slice(0, 5)) {
      line('  · 条目', `${p.id}  ${p.latestVersion || ''}`)
      if (p.repository?.url) line('    仓库', p.repository.url)
      if (p.installSource) line('    安装源', JSON.stringify(p.installSource))
    }
  } else {
    console.log('  → 尚未收录。该目录按 GitHub topic `dsh-plugin` 每日 02:17 UTC 同步。')
  }
} catch (e) {
  console.log(`  查询失败: ${e.message}`)
}

console.log('')
if (listed > 0) {
  console.log(`已收录于 ${listed} 个目录。`)
} else {
  console.log('两个目录都还没有。确认：仓库公开、有 dsh-plugin topic、package.json 合规，然后等同步。')
  process.exitCode = 1
}
