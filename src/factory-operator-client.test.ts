import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.NEXUSMIND_BASE_URL = 'http://fake-backend.test'
process.env.NEXUSMIND_API_KEY = 'nm_test_key'

const { decideFactoryMerge, submitFactoryTask, listFactoryTasks, getFactoryEconomics, formatFactoryDigest } = await import('./client.js')

let calls: { url: string; init?: RequestInit }[] = []
let body: unknown = {}
const originalFetch = globalThis.fetch
beforeEach(() => {
  calls = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) }
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch })

const SUBJECT = 'acme/app#7@0123456789abcdef0123456789abcdef01234567'

test('approve_factory_action posts one merge decision', async () => {
  body = { id: 'd1', merges_after: '2026-10-04 01:10:00' }
  await decideFactoryMerge({ subject: SUBJECT, approve: true, reason: 'checked' })
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/factory/decisions')
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { subject: SUBJECT, action: 'merge', approve: true, reason: 'checked' })
})

test('submit and list factory tasks go to the factory endpoint and the factory label', async () => {
  body = { id: 't1', title: 'x', project: 'app', labels: ['factory'] }
  await submitFactoryTask({ project: 'app', title: 'Document refunds', task_class: 'docs' })
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/factory/tasks')
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { project: 'app', title: 'Document refunds', task_class: 'docs' })
  body = []
  await listFactoryTasks({ project: 'app' })
  assert.match(calls[1].url, /\/v1\/tasks\?.*label=factory/)
  assert.match(calls[1].url, /project=app/)
  body = { days: 7 }
  await getFactoryEconomics({ days: 7 })
  assert.equal(calls[2].url, 'http://fake-backend.test/v1/factory/economics?days=7')
})

test('the digest text lists what waits and says when nothing does', () => {
  assert.equal(formatFactoryDigest({ held_merges: [], blocked_runs: [], factory_tasks: [], unlabeled_shadow: 0, unlabeled_shadow_allows: 0 }), 'Nothing is waiting on a person.')
  const text = formatFactoryDigest({
    held_merges: [{ subject: SUBJECT, reason: 'manual policy', source: 'policy', created_at: 'now' }],
    blocked_runs: [],
    factory_tasks: [{ id: 't1', project: 'app', title: 'Document refunds', status: 'backlog', created_at: 'now' }],
    unlabeled_shadow: 3,
    unlabeled_shadow_allows: 1,
  })
  assert.match(text, /Merges held for a person \(1\)/)
  assert.match(text, new RegExp(SUBJECT))
  assert.match(text, /Document refunds/)
  assert.match(text, /3 decision-model shadow decisions/)
})
