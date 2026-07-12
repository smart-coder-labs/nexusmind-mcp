import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// client.ts reads NEXUSMIND_BASE_URL/NEXUSMIND_API_KEY once at module load time,
// so the env vars must be set BEFORE the dynamic import below.
process.env.NEXUSMIND_BASE_URL = 'http://fake-backend.test'
process.env.NEXUSMIND_API_KEY = 'nm_test_key'

const {
  saveSddArtifact,
  getSddArtifact,
  getSddArtifactByKey,
  listSddArtifactRevisions,
  getSddArtifactRevision,
  listSddChanges,
  getSddChange,
  updateSddChange,
  searchSddArtifacts,
  linkSddChangeMemory,
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

// ── saveSddArtifact ─────────────────────────────────────────────────────────

test('saveSddArtifact calls PUT /v1/sdd/artifacts with only the provided fields', async () => {
  mockResponse = {
    status: 200,
    body: { artifact: { id: 'a1', change_id: 'c1', kind: 'design', capability: '', latest_revision: 1 }, created_revision: true },
  }
  const result = await saveSddArtifact({
    project: 'nexus-mind',
    change_name: 'sdd-artifacts',
    kind: 'design',
    content: '# Design',
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sdd/artifacts')
  assert.equal(calls[0].init?.method, 'PUT', 'PUT, never POST — the save is an idempotent upsert')
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
    project: 'nexus-mind',
    change_name: 'sdd-artifacts',
    kind: 'design',
    content: '# Design',
  })
  assert.equal(result.created_revision, true)
  assert.equal(result.artifact.latest_revision, 1)
})

test('saveSddArtifact forwards capability, path, git_commit and git_ref when present', async () => {
  mockResponse = {
    status: 200,
    body: { artifact: { id: 'a2', change_id: 'c1', kind: 'spec', capability: 'sdd-artifact-store', latest_revision: 3 }, created_revision: false },
  }
  await saveSddArtifact({
    project: 'nexus-mind',
    change_name: 'sdd-artifacts',
    kind: 'spec',
    capability: 'sdd-artifact-store',
    content: '## Requirement',
    path: 'openspec/changes/sdd-artifacts/specs/sdd-artifact-store/spec.md',
    git_commit: 'deadbeef',
    git_ref: 'main',
  })
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
    project: 'nexus-mind',
    change_name: 'sdd-artifacts',
    kind: 'spec',
    content: '## Requirement',
    capability: 'sdd-artifact-store',
    path: 'openspec/changes/sdd-artifacts/specs/sdd-artifact-store/spec.md',
    git_commit: 'deadbeef',
    git_ref: 'main',
  })
})

// ── getSddArtifact / getSddArtifactByKey ────────────────────────────────────

test('getSddArtifact calls GET /v1/sdd/artifacts/:id and URL-encodes the id', async () => {
  mockResponse = { status: 200, body: { id: 'a 1', change_id: 'c1', kind: 'design', capability: '', latest_revision: 2, content: 'FULL DOC' } }
  const result = await getSddArtifact('a 1')
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sdd/artifacts/a%201')
  assert.equal(calls[0].init?.method, undefined)
  assert.equal(result.content, 'FULL DOC')
})

test('getSddArtifactByKey calls GET /v1/sdd/artifacts with the natural key as query params', async () => {
  mockResponse = { status: 200, body: { id: 'a1', change_id: 'c1', kind: 'spec', capability: 'sdd-artifact-store', latest_revision: 1, content: 'STORE SPEC' } }
  await getSddArtifactByKey({
    project: 'nexus-mind',
    change_name: 'sdd-artifacts',
    kind: 'spec',
    capability: 'sdd-artifact-store',
  })
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v1/sdd/artifacts')
  assert.equal(url.searchParams.get('project'), 'nexus-mind')
  assert.equal(url.searchParams.get('change_name'), 'sdd-artifacts')
  assert.equal(url.searchParams.get('kind'), 'spec')
  assert.equal(url.searchParams.get('capability'), 'sdd-artifact-store')
})

test('getSddArtifactByKey omits capability entirely when it is not given', async () => {
  mockResponse = { status: 200, body: { id: 'a1', change_id: 'c1', kind: 'design', capability: '', latest_revision: 1, content: 'D' } }
  await getSddArtifactByKey({ project: 'nexus-mind', change_name: 'sdd-artifacts', kind: 'design' })
  const url = new URL(calls[0].url)
  assert.equal(url.searchParams.has('capability'), false, 'an absent capability must not be sent as an empty param')
})

test('listSddArtifactRevisions calls GET /v1/sdd/artifacts/:id/revisions', async () => {
  mockResponse = { status: 200, body: [{ id: 'r3', artifact_id: 'a1', revision: 3, content_hash: 'h', byte_size: 12 }] }
  const revs = await listSddArtifactRevisions('a1')
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sdd/artifacts/a1/revisions')
  assert.equal(revs[0].revision, 3)
  assert.equal('content' in revs[0], false, 'revision metadata carries no content')
})

test('getSddArtifactRevision calls GET /v1/sdd/artifacts/:id/revisions/:rev', async () => {
  mockResponse = { status: 200, body: { id: 'r2', artifact_id: 'a1', revision: 2, content: 'REV 2 BODY', content_hash: 'h', byte_size: 10 } }
  const rev = await getSddArtifactRevision('a1', 2)
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sdd/artifacts/a1/revisions/2')
  assert.equal(rev.content, 'REV 2 BODY')
})

// ── changes ─────────────────────────────────────────────────────────────────

test('listSddChanges calls GET /v1/sdd/changes with no query params by default', async () => {
  mockResponse = { status: 200, body: [] }
  await listSddChanges()
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sdd/changes')
})

test('listSddChanges forwards project/status/phase/sprint_id/include_archived', async () => {
  mockResponse = { status: 200, body: [] }
  await listSddChanges({
    project: 'nexus-mind',
    status: 'active',
    phase: 'design',
    sprint_id: 's1',
    include_archived: true,
  })
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v1/sdd/changes')
  assert.equal(url.searchParams.get('project'), 'nexus-mind')
  assert.equal(url.searchParams.get('status'), 'active')
  assert.equal(url.searchParams.get('phase'), 'design')
  assert.equal(url.searchParams.get('sprint_id'), 's1')
  assert.equal(url.searchParams.get('include_archived'), 'true')
})

test('getSddChange calls GET /v1/sdd/changes/:id', async () => {
  mockResponse = { status: 200, body: { id: 'c1', project: 'nexus-mind', name: 'sdd-artifacts', phase: 'design', status: 'active', artifacts: [] } }
  const change = await getSddChange('c1')
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sdd/changes/c1')
  assert.equal(change.name, 'sdd-artifacts')
})

test('updateSddChange calls PATCH /v1/sdd/changes/:id with only provided fields', async () => {
  mockResponse = { status: 200, body: { id: 'c1', project: 'nexus-mind', name: 'sdd-artifacts', phase: 'apply', status: 'active' } }
  await updateSddChange('c1', { phase: 'apply' })
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sdd/changes/c1')
  assert.equal(calls[0].init?.method, 'PATCH')
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { phase: 'apply' })
})

test('updateSddChange never sends project or name — the identity tuple is not patchable', async () => {
  mockResponse = { status: 200, body: { id: 'c1', project: 'nexus-mind', name: 'sdd-artifacts', phase: 'apply', status: 'active' } }
  await updateSddChange('c1', { phase: 'apply', title: 'New title', status: 'active', sprint_id: 's1' })
  const body = JSON.parse(calls[0].init?.body as string)
  assert.deepEqual(body, { title: 'New title', status: 'active', phase: 'apply', sprint_id: 's1' })
  assert.equal('project' in body, false, 'the backend deny_unknown_fields would 422 on project')
  assert.equal('name' in body, false, 'the backend deny_unknown_fields would 422 on name')
})

// ── search + memory links ───────────────────────────────────────────────────

test('searchSddArtifacts calls GET /v1/sdd/search with q and limit', async () => {
  mockResponse = { status: 200, body: [{ artifact_id: 'a1', change_id: 'c1', change_name: 'sdd-artifacts', project: 'nexus-mind', kind: 'spec', capability: 'rate-limits', snippet: '…rate limiting…' }] }
  const hits = await searchSddArtifacts('rate limiting', 5)
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v1/sdd/search')
  assert.equal(url.searchParams.get('q'), 'rate limiting')
  assert.equal(url.searchParams.get('limit'), '5')
  assert.equal(hits[0].capability, 'rate-limits')
})

test('searchSddArtifacts omits limit when it is not given', async () => {
  mockResponse = { status: 200, body: [] }
  await searchSddArtifacts('anything')
  const url = new URL(calls[0].url)
  assert.equal(url.searchParams.has('limit'), false)
})

test('linkSddChangeMemory calls POST /v1/sdd/changes/:id/memories with memory_id and relation', async () => {
  mockResponse = { status: 200, body: [{ id: 'm1', content: 'a decision', tags: [], revision_count: 1 }] }
  const memories = await linkSddChangeMemory('c1', { memory_id: 'm1', relation: 'produced' })
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/sdd/changes/c1/memories')
  assert.equal(calls[0].init?.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { memory_id: 'm1', relation: 'produced' })
  assert.equal(memories.length, 1)
})

test('linkSddChangeMemory omits relation when it is not given (backend defaults to produced)', async () => {
  mockResponse = { status: 200, body: [] }
  await linkSddChangeMemory('c1', { memory_id: 'm1' })
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { memory_id: 'm1' })
})

// ── error surfacing ─────────────────────────────────────────────────────────

test('a 422 from PUT /v1/sdd/artifacts rejects with the backend error text (artifact_too_large)', async () => {
  mockResponse = { status: 422, body: { error: 'artifact_too_large', code: 'artifact_too_large' } }
  await assert.rejects(
    () => saveSddArtifact({ project: 'nexus-mind', change_name: 'c', kind: 'design', content: 'x' }),
    /artifact_too_large/,
  )
})

test('a 404 from the natural-key read rejects rather than resolving to an empty document', async () => {
  mockResponse = { status: 404, body: { error: 'Not found', code: 'not_found' } }
  await assert.rejects(
    () => getSddArtifactByKey({ project: 'nexus-mind', change_name: 'c', kind: 'design' }),
    (err: Error & { status?: number }) => {
      assert.equal(err.status, 404)
      return true
    },
  )
})
