const DAY_MS = 86400000

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4)
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`
}

export function filterSessions(rows, filters = {}, now = Date.now()) {
  const query = (filters.query || '').trim().toLocaleLowerCase()
  return rows.filter((row) => {
    if (query && !`${row.title || ''} ${row.workspace || ''} ${row.id}`.toLocaleLowerCase().includes(query)) return false
    if (filters.workspace && row.workspaceKey !== filters.workspace) return false
    if (filters.status === 'archived' && !row.archived) return false
    if (filters.status === 'active' && (row.archived || row.missing)) return false
    if (filters.status === 'pinned' && !row.pinned) return false
    if (filters.status === 'loaded' && !row.running) return false
    if (filters.status === 'missing' && !row.missing) return false
    if (filters.olderDays > 0 && (!(row.mtime > 0) || row.mtime >= now - filters.olderDays * DAY_MS)) return false
    if (filters.minMiB > 0 && row.bytes < filters.minMiB * 1024 ** 2) return false
    return true
  }).sort((a, b) => {
    const compared = filters.sort === 'oldest' ? a.mtime - b.mtime
      : filters.sort === 'largest' ? b.bytes - a.bytes
      : filters.sort === 'title' ? (a.title || '').localeCompare(b.title || '')
      : b.mtime - a.mtime
    return compared || a.id.localeCompare(b.id)
  })
}

// Rank against the entire workspace before applying the current view's filters.
// Otherwise a search could silently redefine which records count as "recent".
export function buildPrunePlan(allRows, candidates, { keepRecent = 10, olderDays = 30, now = Date.now() } = {}) {
  if (!Number.isInteger(keepRecent) || keepRecent < 0 || !Number.isFinite(olderDays) || olderDays < 0) {
    throw new Error('Invalid pruning rule')
  }
  const retained = new Set()
  const counts = new Map()
  for (const row of filterSessions(allRows.filter((entry) => !entry.missing), { sort: 'newest' })) {
    const workspace = row.workspaceKey || row.workspace
    const count = counts.get(workspace) || 0
    if (count < keepRecent || !(row.mtime > 0)) retained.add(row.id)
    counts.set(workspace, count + 1)
  }
  const selected = []
  const skipped = { pinned: 0, loaded: 0, missing: 0, recent: 0, age: 0 }
  for (const row of candidates) {
    const reason = row.missing ? 'missing' : row.running ? 'loaded' : row.pinned ? 'pinned'
      : retained.has(row.id) ? 'recent'
      : !(row.mtime > 0) || row.mtime >= now - olderDays * DAY_MS ? 'age' : null
    if (reason) skipped[reason] += 1
    else selected.push(row)
  }
  return { sessions: selected, skipped, bytes: selected.reduce((sum, row) => sum + row.bytes, 0) }
}
