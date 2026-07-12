import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// client.ts reads NEXUSMIND_BASE_URL/NEXUSMIND_API_KEY once at module load time,
// so the env vars must be set BEFORE the dynamic import below.
process.env.NEXUSMIND_BASE_URL = 'http://fake-backend.test'
process.env.NEXUSMIND_API_KEY = 'nm_test_key'

const {
  saveSddSpec,
  getSddSpec,
  getSddSpecByCapability,
  listSddSpecRevisions,
  getSddSpecRevision,
  listSddSpecs,
  listSddSpecsForChange,
} = await import('./client.js')

interface RecordedCall {
  url: string
  init?: RequestInit
}

let calls: RecordedCall[] = []
let mockResponse: { status: number; body: unknown } = { status: 200, body: [] }
const originalFetch = globalThis.fetch

beforeEach(() => {
  calls = []
  mockResponse = { status: 200, body: [] }
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return {
      ok: mockResponse.status >= 200 && mockResponse.status < 300,
      status: mockResponse.status,
      statusText: 'Mock Status',
      json: async () => mockResponse.body,
      text: async () => mockResponse.body === undefined ? '' : JSON.stringify(mockResponse.body),
    } as Response
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ── saveSddSpec ─────────────────────────────────────────────────────────────

test('saveSddSpec calls PUT /v1/sdd/specs with only the provided fields', async () => {
  mockResponse = {
    status: 200,
    body: {
      spec: { id: 's1', project: 'nexus-mind', capability: 'harness-library', latest_revision: 1 },
      created_revision: true,
    },
  }
  const result = await saveSddSpec({
    project: 'nexus-mind',
    capability: 'harness-library',
    content: '# Harness Library',
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sdd/specs')
  assert.equal(calls[0].init?.method, 'PUT', 'PUT, never POST — the save is an idempotent upsert')
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
    project: 'nexus-mind',
    capability: 'harness-library',
    content: '# Harness Library',
  }, 'optional fields the caller omitted must not be sent as nulls')
  assert.equal(result.created_revision, true)
  assert.equal(result.spec.latest_revision, 1)
})

test('saveSddSpec sends merged_from_change_name — the provenance is the point of the call', async () => {
  mockResponse = {
    status: 200,
    body: {
      spec: { id: 's1', capability: 'cap', latest_revision: 2, last_merged_from_change_name: 'sdd-specs' },
      created_revision: true,
    },
  }
  await saveSddSpec({
    project: 'nexus-mind',
    capability: 'cap',
    content: 'C',
    title: 'Cap',
    path: 'openspec/specs/cap/spec.md',
    merged_from_change_name: 'sdd-specs',
    git_commit: 'abc123',
  })

  assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
    project: 'nexus-mind',
    capability: 'cap',
    content: 'C',
    title: 'Cap',
    path: 'openspec/specs/cap/spec.md',
    merged_from_change_name: 'sdd-specs',
    git_commit: 'abc123',
  })
})

test('saveSddSpec surfaces a 404 (unknown change) as an error carrying the status', async () => {
  mockResponse = { status: 404, body: { error: 'change_not_found', code: 'change_not_found' } }

  await assert.rejects(
    () => saveSddSpec({
      project: 'p',
      capability: 'cap',
      content: 'C',
      merged_from_change_name: 'no-such-change',
    }),
    (err: any) => {
      assert.equal(err.status, 404, 'the status must survive, so the tool can branch on not-found')
      return true
    },
  )
})

// ── getSddSpec ──────────────────────────────────────────────────────────────

test('getSddSpec fetches by id and returns the flattened detail with content', async () => {
  mockResponse = {
    status: 200,
    body: { id: 's1', capability: 'cap', project: 'p', latest_revision: 3, content: '# The contract' },
  }
  const spec = await getSddSpec('s1')

  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sdd/specs/s1')
  // The response is serde-FLATTENED: the spec's fields are inline, not under `.spec`.
  assert.equal(spec.capability, 'cap')
  assert.equal(spec.content, '# The contract')
  assert.equal(spec.latest_revision, 3)
})

test('getSddSpecByCapability uses the natural-key route, not client-side resolution', async () => {
  mockResponse = { status: 200, body: { id: 's1', capability: 'harness-library', content: 'C' } }
  await getSddSpecByCapability('nexus-mind', 'harness-library')

  assert.equal(calls.length, 1, 'one request — the backend owns the resolution')
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v1/sdd/specs')
  assert.equal(url.searchParams.get('project'), 'nexus-mind')
  assert.equal(url.searchParams.get('capability'), 'harness-library')
})

test('getSddSpec propagates a 404 with its status intact', async () => {
  mockResponse = { status: 404, body: { error: 'Not found', code: 'not_found' } }
  await assert.rejects(
    () => getSddSpec('nope'),
    (err: any) => {
      assert.equal(err.status, 404)
      return true
    },
  )
})

// ── revisions ───────────────────────────────────────────────────────────────

test('listSddSpecRevisions hits the revisions route and carries no content', async () => {
  mockResponse = {
    status: 200,
    body: [
      { id: 'r2', spec_id: 's1', revision: 2, content_hash: 'h2', byte_size: 20, merged_from_change_name: 'sdd-specs', source: 'agent' },
      { id: 'r1', spec_id: 's1', revision: 1, content_hash: 'h1', byte_size: 10, source: 'import' },
    ],
  }
  const revisions = await listSddSpecRevisions('s1')

  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sdd/specs/s1/revisions')
  assert.equal(revisions.length, 2)
  assert.equal(revisions[0].revision, 2, 'newest first')
  assert.equal(revisions[0].merged_from_change_name, 'sdd-specs')
  assert.equal('content' in revisions[0], false, 'the metadata type cannot carry a document')
})

test('getSddSpecRevision fetches one revision with its full content', async () => {
  mockResponse = {
    status: 200,
    body: { id: 'r1', spec_id: 's1', revision: 1, content: 'the original contract', content_hash: 'h1', byte_size: 21, source: 'import' },
  }
  const revision = await getSddSpecRevision('s1', 1)

  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sdd/specs/s1/revisions/1')
  assert.equal(revision.content, 'the original contract')
})

// ── lists ───────────────────────────────────────────────────────────────────

test('listSddSpecs sends only the filters the caller set', async () => {
  mockResponse = { status: 200, body: [] }

  await listSddSpecs()
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sdd/specs', 'no filters, no query string')

  await listSddSpecs({ project: 'nexus-mind', include_archived: true })
  const url = new URL(calls[1].url)
  assert.equal(url.searchParams.get('project'), 'nexus-mind')
  assert.equal(url.searchParams.get('include_archived'), 'true')
})

test('listSddSpecsForChange asks the change which contracts it merged into', async () => {
  mockResponse = {
    status: 200,
    body: [{ id: 's1', capability: 'harness-library', latest_revision: 3, merged_revision: 3 }],
  }
  const merged = await listSddSpecsForChange('c1')

  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sdd/changes/c1/specs')
  assert.equal(merged[0].capability, 'harness-library')
  assert.equal(merged[0].merged_revision, 3, 'the revision THIS change produced')
})
