import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, rename, rm, writeFile, mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const sourceMutations = new Map()

function sourceError(status, message) {
  return Object.assign(new Error(message), { status })
}

function pathKey(path) {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function endpointUrl(value) {
  if (!value) return null
  let url
  try { url = new URL(value) } catch { throw sourceError(400, '请输入有效的本机 DSH HTTP 地址') }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw sourceError(400, '连接地址必须是本机 DSH 的 http://localhost:端口/ 地址，可保留认证查询参数')
  }
  return url
}

// Each source delegates mutations to the host that owns its writers and index.
// A directory without a connected host remains available for inventory/search.
export function createSessionSources({ home, listLocal }) {
  const file = join(home, 'storages', 'dsh-chat-prune-sources.json')

  async function load() {
    let saved
    try { saved = JSON.parse(await readFile(file, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error; saved = [] }
    if (!Array.isArray(saved)) throw sourceError(500, '对话来源配置格式无效')
    const resolved = []
    for (const entry of saved) {
      if (typeof entry?.home !== 'string' || !isAbsolute(entry.home)) throw sourceError(400, '来源需要绝对 DSH 数据目录')
      const path = resolve(entry.home)
      if (pathKey(path) === pathKey(home) || resolved.some((item) => pathKey(item.home) === pathKey(path))) continue
      endpointUrl(entry.endpoint)
      resolved.push({ id: createHash('sha256').update(pathKey(path)).digest('hex').slice(0, 16),
        name: String(entry.name || path).slice(0, 200), home: path, endpoint: entry.endpoint || '' })
    }
    return resolved
  }

  function publicSource(source, extra = {}) {
    return { id: source.id, name: source.name, home: source.home, connected: Boolean(source.endpoint), ...extra }
  }

  async function remote(source, route, method = 'GET', body) {
    const url = endpointUrl(source.endpoint)
    if (!url) throw sourceError(409, '此目录尚未连接所属 DSH 宿主；请在路径设置中填写其本机访问地址后操作')
    url.pathname = `/dsh-chat-prune/${route}`
    url.searchParams.set('local', '1')
    let response, payload
    try {
      response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined })
      payload = await response.json()
    } catch {
      throw Object.assign(sourceError(502, '无法确认来源宿主的响应，请刷新检查结果后再试'), { outcomeUnknown: method !== 'GET' })
    }
    if (!response.ok || payload?.ok !== true) {
      throw Object.assign(sourceError(response.status || 502, payload?.error || '来源宿主请求失败'), {
        deletion: { partial: payload?.partial, backupDir: payload?.backupDir },
        outcomeUnknown: payload?.outcomeUnknown === true,
      })
    }
    return payload
  }

  async function verify(source) {
    const ping = await remote(source, 'ping')
    if (!ping.home || pathKey(ping.home) !== pathKey(source.home)) {
      throw sourceError(409, '连接宿主的数据目录与填写路径不一致，请核对后重试')
    }
  }

  async function save(operation) {
    const key = pathKey(file)
    const previous = sourceMutations.get(key) || Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      await mkdir(join(home, 'storages'), { recursive: true })
      const temporary = `${file}.tmp-${randomUUID()}`
      try {
        const next = await operation(await load())
        await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
        await rename(temporary, file)
      } finally {
        await rm(temporary, { force: true })
      }
    })
    sourceMutations.set(key, pending)
    try { return await pending }
    finally { if (sourceMutations.get(key) === pending) sourceMutations.delete(key) }
  }

  return {
    async add(input) {
      if (typeof input?.home !== 'string' || !isAbsolute(input.home)) throw sourceError(400, '请输入绝对 DSH 数据目录路径')
      const path = await realpath(input.home).catch(() => { throw sourceError(400, '数据目录不存在或无法读取') })
      if (pathKey(path) === pathKey(await realpath(home))) throw sourceError(400, '此路径已是当前来源')
      const sessionDirectory = await lstat(join(path, 'sessions')).catch(() => null)
      if (!sessionDirectory?.isDirectory()) throw sourceError(400, '此路径下没有 sessions 目录')
      const previous = (await load()).find((entry) => pathKey(entry.home) === pathKey(path))
      const endpoint = endpointUrl(input.endpoint ?? previous?.endpoint)?.href || ''
      const source = { id: createHash('sha256').update(pathKey(path)).digest('hex').slice(0, 16),
        name: String(input.name || path).trim().slice(0, 200), home: path, endpoint }
      if (endpoint) await verify(source)
      await save((current) => [...current.filter((entry) => entry.id !== source.id), source])
      return publicSource(source)
    },
    async remove(id) {
      if (!id || id === 'local') throw sourceError(400, '不能移除当前来源')
      await save((current) => current.filter((source) => source.id !== id))
    },
    async list() {
      const entries = await load()
      const results = await Promise.all(entries.map(async (source) => {
        try {
          let rows, actions = [], backup = false
          if (source.endpoint) {
            await verify(source)
            const payload = await remote(source, 'sessions')
            if (payload.apiVersion !== 1 || payload.managementVersion !== 1) throw sourceError(409, '来源插件版本不兼容，请更新并重启该宿主')
            rows = payload.sessions
            actions = payload.actions || []
            backup = payload.config?.backup === true
          } else rows = await listLocal({ profileContext: { home: source.home } })
          return { source: publicSource(source), rows: rows.map((row) => ({
            ...row, key: `${source.id}:${row.id}`, sourceId: source.id, sourceName: source.name,
            sourceHome: source.home, readOnly: !source.endpoint, actions, backup,
            workspaceKey: `${source.id}:${row.workspaceKey}`,
          })) }
        } catch (error) {
          return { source: publicSource(source, { error: error.message }), rows: [] }
        }
      }))
      return { sources: results.map((entry) => entry.source), sessions: results.flatMap((entry) => entry.rows) }
    },
    async forward(id, route, method, body) {
      const source = (await load()).find((entry) => entry.id === id)
      if (!source) throw sourceError(404, '来源已被移除，请刷新列表')
      await verify(source)
      return remote(source, route, method, { ...body, sourceId: undefined })
    },
  }
}
