import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.NEXUSMIND_BASE_URL = 'http://fake-backend.test'
process.env.NEXUSMIND_API_KEY = 'nm_test_key'

const { getContextPack, formatContextPack } = await import('./client.js')
type Response = Awaited<ReturnType<typeof getContextPack>>

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
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

afterEach(() => {
  globalThis.fetch = originalFetch
})

const response: Response = {
  pack: {
    schema_version: 1,
    task_id: '73c1e1a7-8751-487e-a1d0-58146f5b4e22',
    repository: { commit: COMMIT },
    artifacts: [
      { path: 'src/pages/SaleDetail.tsx', symbol: 'SaleDetail', kind: 'code', reason: 'rank 1 for the task text; matches sale, detail', content_hash: 'sha256:aa', retrieval_score: 4.2 },
      { path: 'src/api/refunds.ts', symbol: null, kind: 'code', reason: 'imported by src/pages/SaleDetail.tsx', content_hash: 'sha256:bb' },
    ],
    constraints: [],
    acceptance_tests: [],
  },
  evidence: [
    { artifact: 0, path: 'src/pages/SaleDetail.tsx', start_line: 1, end_line: 2, content: 'export function SaleDetail() {}', truncated: false },
    { artifact: 1, path: 'src/api/refunds.ts', start_line: 1, end_line: 1, content: 'export async function createRefund', truncated: true },
  ],
  index: { commit: 'fedcba9876543210fedcba9876543210fedcba98', last_indexed: '2026-10-03T05:00:00Z', stale: true },
}

test('getContextPack posts only the given fields to /v1/code/context-pack', async () => {
  body = response
  const result = await getContextPack({ project: 'app', query: 'refund from the sale page', commit: COMMIT })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/code/context-pack')
  assert.equal(calls[0].init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { project: 'app', query: 'refund from the sale page', commit: COMMIT })
  assert.equal(result.pack.artifacts.length, 2)
})

test('the formatted pack shows each artifact with its reason, code and staleness', () => {
  const text = formatContextPack(response)
  assert.match(text, /STALE: index built at fedcba987654/)
  assert.match(text, /\[1\] src\/pages\/SaleDetail\.tsx — SaleDetail \(code\) · rank 1 for the task text/)
  assert.match(text, /\[2\] src\/api\/refunds\.ts \(code\) · imported by src\/pages\/SaleDetail\.tsx/)
  assert.match(text, /export function SaleDetail\(\) \{\}/)
  assert.match(text, /lines 1-1 \(truncated\):/)
})

test('code containing a fence cannot close the formatted block', () => {
  const tricky = { ...response, evidence: [{ ...response.evidence[0], content: 'const md = "```\\nescape"' }] }
  const text = formatContextPack(tricky)
  assert.match(text, /\n````\n/)
})
