import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as zlib from 'node:zlib'
import { readSessionTitle, zstdFrameEnd } from '../lib/index.js'

async function fixture(t, frames) {
  const dir = await mkdtemp(join(tmpdir(), 'dshdc-title-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames.map(
    (text) => zlib.zstdCompressSync(Buffer.from(text)),
  )))
  return dir
}

test('latest rename after twenty frames replaces the original title', {
  skip: typeof zlib.zstdCompressSync !== 'function' && 'Node runtime has no zstd support',
}, async (t) => {
  const title = (value) => `${JSON.stringify({ type: 'session/title', data: { title: value } })}\n`
  const dir = await fixture(t, [title('旧标题'), ...Array(25).fill('{"type":"other"}\n'), title('新标题')])
  assert.equal(await readSessionTitle(dir), '新标题')
})

test('JSON lines and UTF-8 characters can span independent compressed frames', {
  skip: typeof zlib.zstdCompressSync !== 'function' && 'Node runtime has no zstd support',
}, async (t) => {
  const raw = Buffer.from('{"type":"session/title","data":{"title":"中文跨帧"}}\n')
  const split = raw.indexOf(Buffer.from('中')) + 1
  const dir = await fixture(t, [raw.subarray(0, split), raw.subarray(split)])
  assert.equal(await readSessionTitle(dir), '中文跨帧')
})

test('frame boundaries and truncated or reserved frames are checked', {
  skip: typeof zlib.zstdCompressSync !== 'function' && 'Node runtime has no zstd support',
}, () => {
  const frame = zlib.zstdCompressSync(Buffer.from('frame'))
  assert.equal(zstdFrameEnd(frame, 0), frame.length)
  assert.equal(zstdFrameEnd(frame.subarray(0, frame.length - 1), 0), -1)
  assert.equal(zstdFrameEnd(Buffer.alloc(12), 0), -1)
})
