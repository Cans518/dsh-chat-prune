import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

const compress = promisify(gzip)
const decompress = promisify(gunzip)
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 })
}

export function validateFilePath(path) {
  if (typeof path !== 'string' || path.length > 1000 || path.split('/').some((part) =>
    !part || part === '.' || part === '..' || /[\\:<>"|?*\x00-\x1f]/.test(part) ||
    /[. ]$/.test(part) || /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i.test(part))) {
    throw invalid('压缩包包含不安全的文件路径')
  }
}

export function fileRecord(path, content, mtime) {
  validateFilePath(path)
  return { path, content: content.toString('base64'), mtime,
    sha256: createHash('sha256').update(content).digest('hex') }
}

export function fileContent(file) {
  const content = Buffer.from(file.content, 'base64')
  if (content.toString('base64') !== file.content ||
      createHash('sha256').update(content).digest('hex') !== file.sha256) {
    throw invalid('压缩包文件校验失败')
  }
  return content
}

export async function encodePackage(sessions) {
  validateSessions(sessions)
  const raw = Buffer.from(JSON.stringify({ format: 'dsh-chat-prune', version: 1, sessions }))
  if (raw.length > MAX_EXPANDED_BYTES) throw Object.assign(new Error('对话包超过 256 MiB，请分批导出'), { status: 413 })
  const archive = await compress(raw, { level: 9 })
  if (archive.length > MAX_PACKAGE_BYTES) throw Object.assign(new Error('压缩包超过 64 MiB，请分批导出'), { status: 413 })
  return archive
}

export async function decodePackage(archive) {
  if (!Buffer.isBuffer(archive) || archive.length > MAX_PACKAGE_BYTES) {
    throw Object.assign(new Error('压缩包超过 64 MiB'), { status: 413 })
  }
  let doc
  try {
    doc = JSON.parse((await decompress(archive, { maxOutputLength: MAX_EXPANDED_BYTES })).toString('utf8'))
  } catch (cause) {
    throw Object.assign(new Error('无法读取对话压缩包，文件已损坏或超过解压限制', { cause }), { status: 400 })
  }
  if (doc?.format !== 'dsh-chat-prune' || doc.version !== 1) throw invalid('不支持的对话压缩包格式')
  validateSessions(doc.sessions)
  return doc.sessions
}

function validateSessions(sessions) {
  if (!Array.isArray(sessions) || !sessions.length || sessions.length > 1000) throw invalid('不支持的对话数量')
  const ids = new Set()
  let fileCount = 0
  for (const session of sessions) {
    if (typeof session?.id !== 'string' || !/^session-[A-Za-z0-9-]{1,192}$/.test(session.id) ||
        ids.has(session.id.toLowerCase()) || !Array.isArray(session.files) || !session.files.length ||
        typeof session.workspace !== 'string' || session.workspace.length > 1000 ||
        typeof session.title !== 'string' || session.title.length > 10000) throw invalid('对话清单无效或 ID 重复')
    ids.add(session.id.toLowerCase())
    const paths = new Set()
    for (const file of session.files) {
      if (++fileCount > 20000) throw invalid('压缩包文件数量过多')
      if (!file || typeof file !== 'object') throw invalid('压缩包文件记录无效')
      validateFilePath(file.path)
      const key = file.path.toLowerCase()
      if (paths.has(key) || typeof file.content !== 'string' ||
          !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isFinite(file.mtime) || file.mtime < 0 ||
          file.path.split('/').some((part) => part.toLowerCase().startsWith('.dsh-') || part.toLowerCase().endsWith('.lock'))) {
        throw invalid('压缩包包含重复文件或保留路径')
      }
      paths.add(key)
      fileContent(file)
    }
    for (const path of paths) {
      const parts = path.split('/')
      while (parts.length > 1) {
        parts.pop()
        if (paths.has(parts.join('/'))) throw invalid('压缩包文件与目录路径冲突')
      }
    }
  }
}
