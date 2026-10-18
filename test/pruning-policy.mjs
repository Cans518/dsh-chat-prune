import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPrunePlan, filterSessions, formatBytes } from '../lib/pruning-policy.js'

const now = Date.UTC(2026, 9, 18)
const day = 86400000
const row = (id, age, overrides = {}) => ({
  id, title: id, workspace: 'Project', workspaceKey: 'a',
  mtime: now - age * day, bytes: 1024, ...overrides,
})

test('filters compose workspace, text, archive, age and size without mutating the list', () => {
  const rows = [row('a', 40, { archived: true, bytes: 2 ** 21 }), row('b', 40),
    row('c', 40, { archived: true, workspaceKey: 'b' }), row('d', 2, { archived: true })]
  const result = filterSessions(rows, { query: 'project', workspace: 'a', status: 'archived', olderDays: 30, minMiB: 1 }, now)
  assert.deepEqual(result.map((entry) => entry.id), ['a'])
  assert.deepEqual(rows.map((entry) => entry.id), ['a', 'b', 'c', 'd'])
})

test('stable ID ordering breaks equal-date ties and keeps the same recent records', () => {
  const rows = [row('b', 50), row('a', 50), row('c', 60)]
  assert.deepEqual(filterSessions(rows).map((entry) => entry.id), ['a', 'b', 'c'])
  assert.deepEqual(buildPrunePlan(rows, rows, { keepRecent: 1, now }).sessions.map((entry) => entry.id), ['b', 'c'])
})

test('retention counts the full workspace, independently for each workspace and outside the search', () => {
  const rows = [row('new', 2), row('old', 60), row('other-new', 40, { workspaceKey: 'b' }),
    row('other-old', 80, { workspaceKey: 'b' })]
  const plan = buildPrunePlan(rows, rows.slice(1), { keepRecent: 1, olderDays: 30, now })
  assert.deepEqual(plan.sessions.map((entry) => entry.id), ['old', 'other-old'])
  assert.equal(plan.skipped.recent, 1)
})

test('identical IDs in different source paths have independent retention and filter identities', () => {
  const rows = [
    row('same', 90, { key: 'A:same', sourceId: 'A', workspaceKey: 'A:main' }),
    row('new', 1, { key: 'A:new', sourceId: 'A', workspaceKey: 'A:main' }),
    row('same', 10, { key: 'B:same', sourceId: 'B', workspaceKey: 'B:main' }),
    row('old', 100, { key: 'B:old', sourceId: 'B', workspaceKey: 'B:main' }),
  ]
  const plan = buildPrunePlan(rows, rows, { keepRecent: 1, olderDays: 30, now })
  assert.deepEqual(plan.sessions.map((entry) => entry.key), ['A:same', 'B:old'])
  assert.deepEqual(filterSessions(rows, { source: 'B' }).map((entry) => entry.key), ['B:same', 'B:old'])
})

test('pruning protects pins, loaded, missing and unknown dates even with keep zero', () => {
  const rows = [row('pin', 90, { pinned: true }), row('loaded', 90, { running: true }),
    row('missing', 90, { missing: true }), row('unknown', 90, { mtime: 0 }),
    row('future', -5), row('eligible', 90)]
  const plan = buildPrunePlan(rows, rows, { keepRecent: 0, olderDays: 0, now })
  assert.deepEqual(plan.sessions.map((entry) => entry.id), ['eligible'])
  assert.equal(plan.bytes, 1024)
  assert.deepEqual(plan.skipped, { pinned: 1, loaded: 1, missing: 1, recent: 1, age: 1 })
})

test('age boundary is strict and retention re-evaluation excludes newly updated records', () => {
  const rows = [row('boundary', 30), row('older', 31)]
  assert.deepEqual(buildPrunePlan(rows, rows, { keepRecent: 0, olderDays: 30, now }).sessions.map((entry) => entry.id), ['older'])
  const updated = rows.map((entry) => entry.id === 'older' ? { ...entry, mtime: now } : entry)
  assert.equal(buildPrunePlan(updated, updated, { keepRecent: 0, olderDays: 30, now }).sessions.length, 0)
})

test('invalid rules fail explicitly and byte sizes use binary units', () => {
  assert.throws(() => buildPrunePlan([], [], { keepRecent: -1 }))
  assert.throws(() => buildPrunePlan([], [], { olderDays: NaN }))
  assert.equal(formatBytes(1024 ** 2), '1.0 MiB')
  assert.equal(formatBytes(0), '0 B')
})
