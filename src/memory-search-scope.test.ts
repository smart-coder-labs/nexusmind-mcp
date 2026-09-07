import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// client.ts reads the env once at module load, so it must be set before the import.
process.env.NEXUSMIND_BASE_URL = 'http://fake-backend.test'
process.env.NEXUSMIND_API_KEY = 'nm_test_key'

const { searchMemories } = await import('./client.js')

interface RecordedCall { url: string; init?: RequestInit }
let calls: RecordedCall[] = []
const originalFetch = globalThis.fetch

beforeEach(() => {
  calls = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => [], text: async () => '[]',
    } as Response
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch })

const bodyOf = (c: RecordedCall) => JSON.parse(String(c.init?.body ?? '{}'))

// The defect this closes: the backend gained `project` on POST /v1/memory/search,
// but the client never sent it, so the scoping fix was inert for every real user.
// Measured consequence on a 2,907-entry corpus across three clients: an unscoped
// question about one client's deploy setup returned three of five results from
// another client's storefront.
test('a project-scoped search sends project to the backend', async () => {
  await searchMemories({ query: 'deploy setup', project: 'kasymir' })
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/v1\/memory\/search$/)
  assert.equal(bodyOf(calls[0]).project, 'kasymir')
})

// Absent must stay absent rather than becoming null/"" — the server treats a
// missing project as "whole organization", which is the right default for a
// single-project org.
test('an unscoped search omits project entirely', async () => {
  await searchMemories({ query: 'deploy setup' })
  assert.ok(!('project' in bodyOf(calls[0])), 'project must not be sent at all')
})

test('the string overload still works and stays unscoped', async () => {
  await searchMemories('deploy setup', 5)
  const body = bodyOf(calls[0])
  assert.equal(body.query, 'deploy setup')
  assert.equal(body.limit, 5)
  assert.ok(!('project' in body))
})

// Scoping must narrow BEFORE ranking. Filtering the ranked top-100 client-side
// cannot recover rows that never entered the window, which is why this moved
// server-side at all — a scoped search could return nothing while plenty of
// matching memories existed.
test('scoping does not force the wide top-100 fetch that client-side filters need', async () => {
  await searchMemories({ query: 'deploy setup', project: 'kasymir', limit: 5 })
  assert.equal(bodyOf(calls[0]).limit, 5, 'the requested limit reaches the backend unchanged')
})
