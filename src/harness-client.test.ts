import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// client.ts reads NEXUSMIND_BASE_URL/NEXUSMIND_API_KEY once at module load time
// (top-level `const BASE_URL = process.env.NEXUSMIND_BASE_URL ?? ''`), so the
// env vars must be set BEFORE the dynamic import below, not just before each test.
process.env.NEXUSMIND_BASE_URL = 'http://fake-backend.test'
process.env.NEXUSMIND_API_KEY = 'nm_test_key'

const {
  listHarnesses,
  recommendHarnesses,
  getHarnessVersion,
  listHarnessConfigReviews,
  downloadHarnessVersion,
  approveHarnessInstall,
  recordHarnessInstallResult,
  createHarness,
  publishHarnessVersion,
  createHarnessConfigReview,
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
      text: async () => JSON.stringify(mockResponse.body),
    } as Response
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('listHarnesses calls GET /v1/harnesses with no query params by default', async () => {
  mockResponse = { status: 200, body: [{ id: 'h1', slug: 'foo', name: 'Foo' }] }
  const result = await listHarnesses()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/harnesses')
  assert.equal(calls[0].init?.method, undefined)
  assert.deepEqual(result, [{ id: 'h1', slug: 'foo', name: 'Foo' }])
})

test('listHarnesses forwards target and owner_user_id as query params', async () => {
  mockResponse = { status: 200, body: [] }
  await listHarnesses({ target: 'cursor', owner_user_id: 'user-1' })
  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v1/harnesses')
  assert.equal(url.searchParams.get('target'), 'cursor')
  assert.equal(url.searchParams.get('owner_user_id'), 'user-1')
})

test('recommendHarnesses calls GET /v1/harness-recommendations with optional target', async () => {
  mockResponse = { status: 200, body: [{ harness_id: 'h1', version: '1.0.0', name: 'Foo', targets: ['claude'], format: 'agent' }] }
  const result = await recommendHarnesses({ target: 'claude' })
  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v1/harness-recommendations')
  assert.equal(url.searchParams.get('target'), 'claude')
  assert.equal(result.length, 1)
  assert.equal(result[0].harness_id, 'h1')
})

test('recommendHarnesses omits target query param when not provided', async () => {
  mockResponse = { status: 200, body: [] }
  await recommendHarnesses()
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/harness-recommendations')
})

test('getHarnessVersion calls GET /v1/harnesses/:id/versions/:version', async () => {
  mockResponse = {
    status: 200,
    body: { harness_id: 'h1', version: '1.0.0', format: 'agent', targets: ['claude'], manifest_hash: 'sha256:abc' },
  }
  const result = await getHarnessVersion('h1', '1.0.0')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/harnesses/h1/versions/1.0.0')
  assert.equal(result.manifest_hash, 'sha256:abc')
})

test('getHarnessVersion URL-encodes harness id and version', async () => {
  mockResponse = { status: 200, body: {} }
  await getHarnessVersion('h/1', 'v 1.0')
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/harnesses/h%2F1/versions/v%201.0')
})

test('listHarnessConfigReviews calls GET /v1/harness-config-reviews with optional status', async () => {
  mockResponse = { status: 200, body: [{ id: 'r1', source_tool: 'claude', status: 'pending' }] }
  const result = await listHarnessConfigReviews({ status: 'pending' })
  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v1/harness-config-reviews')
  assert.equal(url.searchParams.get('status'), 'pending')
  assert.equal(result[0].id, 'r1')
})

test('listHarnessConfigReviews omits status query param when not provided', async () => {
  mockResponse = { status: 200, body: [] }
  await listHarnessConfigReviews()
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/harness-config-reviews')
})

test('listHarnessConfigReviews propagates a permission-denied (403) error without returning data', async () => {
  mockResponse = { status: 403, body: { error: 'harness:read permission required' } }
  await assert.rejects(
    () => listHarnessConfigReviews({ status: 'pending' }),
    /harness:read permission required/,
  )
})

test('none of the harness read methods ever request a manifest download/content endpoint', async () => {
  mockResponse = { status: 200, body: [] }
  await listHarnesses({ target: 'cursor' })
  await recommendHarnesses({ target: 'cursor' })
  await getHarnessVersion('h1', '1.0.0')
  await listHarnessConfigReviews({ status: 'pending' })
  for (const call of calls) {
    assert.doesNotMatch(call.url, /\/download\b/, `unexpected download call: ${call.url}`)
  }
})

// ── Install core (Phase 2) ───────────────────────────────────────────────────

test('downloadHarnessVersion calls GET /v1/harnesses/:id/versions/:version/download', async () => {
  mockResponse = {
    status: 200,
    body: {
      harness_id: 'h1',
      version: '1.0.0',
      manifest: { schema_version: '1.1', format: 'agent', targets: ['claude'], components: [] },
      manifest_hash: 'sha256:abc',
    },
  }
  const result = await downloadHarnessVersion('h1', '1.0.0')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/harnesses/h1/versions/1.0.0/download')
  assert.equal(calls[0].init?.method, undefined)
  assert.equal(result.manifest_hash, 'sha256:abc')
})

test('downloadHarnessVersion propagates approval-required denial without returning manifest content', async () => {
  mockResponse = { status: 403, body: { error: 'install approval required' } }
  await assert.rejects(() => downloadHarnessVersion('h1', '1.0.0'), /install approval required/)
})

test('approveHarnessInstall calls POST .../approval with target_tool, target_scope, manifest_hash, metadata', async () => {
  mockResponse = {
    status: 200,
    body: { approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:abc' },
  }
  const result = await approveHarnessInstall('h1', '1.0.0', {
    target_tool: 'claude',
    target_scope: 'project',
    manifest_hash: 'sha256:abc',
    metadata: { warning_acknowledged: true },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/harnesses/h1/versions/1.0.0/approval')
  assert.equal(calls[0].init?.method, 'POST')
  const body = JSON.parse(calls[0].init?.body as string)
  assert.equal(body.target_tool, 'claude')
  assert.equal(body.target_scope, 'project')
  assert.equal(body.manifest_hash, 'sha256:abc')
  assert.deepEqual(body.metadata, { warning_acknowledged: true })
  assert.equal(result.approval_id, 'appr-1')
})

test('approveHarnessInstall propagates executable-without-acknowledgement rejection', async () => {
  mockResponse = { status: 422, body: { error: 'warning_acknowledged metadata required for executable manifest' } }
  await assert.rejects(
    () => approveHarnessInstall('h1', '1.0.0', {
      target_tool: 'claude', target_scope: 'project', manifest_hash: 'sha256:abc',
    }),
    /warning_acknowledged metadata required/,
  )
})

test('recordHarnessInstallResult calls POST .../install-result with approval_id, manifest_hash, status, metadata', async () => {
  mockResponse = { status: 200, body: { approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:abc', status: 'installed' } }
  const result = await recordHarnessInstallResult('h1', '1.0.0', {
    approval_id: 'appr-1',
    manifest_hash: 'sha256:abc',
    status: 'installed',
    metadata: { changed_files_count: 3 },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/harnesses/h1/versions/1.0.0/install-result')
  assert.equal(calls[0].init?.method, 'POST')
  const body = JSON.parse(calls[0].init?.body as string)
  assert.equal(body.approval_id, 'appr-1')
  assert.equal(body.status, 'installed')
  assert.deepEqual(body.metadata, { changed_files_count: 3 })
  // Never sends raw file contents.
  assert.equal(body.content, undefined)
  assert.equal(body.written, undefined)
  assert.equal(result.status, 'installed')
})

// ── Create / upload (Phase 3) ────────────────────────────────────────────────

test('createHarness calls POST /v1/harnesses with slug/name/description/project_id/visibility/owner_user_id', async () => {
  mockResponse = { status: 200, body: { id: 'h1', slug: 'foo', owner_user_id: 'u1' } }
  const result = await createHarness({
    slug: 'foo',
    name: 'Foo',
    description: 'A foo harness',
    project_id: 'proj-1',
    visibility: 'org',
    owner_user_id: 'u1',
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/harnesses')
  assert.equal(calls[0].init?.method, 'POST')
  const body = JSON.parse(calls[0].init?.body as string)
  assert.equal(body.slug, 'foo')
  assert.equal(body.name, 'Foo')
  assert.equal(body.description, 'A foo harness')
  assert.equal(body.project_id, 'proj-1')
  assert.equal(body.visibility, 'org')
  assert.equal(body.owner_user_id, 'u1')
  assert.equal(result.id, 'h1')
})

test('createHarness omits optional fields when not provided', async () => {
  mockResponse = { status: 200, body: { id: 'h1', slug: 'foo' } }
  await createHarness({ slug: 'foo', name: 'Foo' })
  const body = JSON.parse(calls[0].init?.body as string)
  assert.equal(body.description, undefined)
  assert.equal(body.project_id, undefined)
  assert.equal(body.visibility, undefined)
  assert.equal(body.owner_user_id, undefined)
})

test('createHarness propagates a permission-denied (403) error without creating anything', async () => {
  mockResponse = { status: 403, body: { error: 'harness:write permission required' } }
  await assert.rejects(
    () => createHarness({ slug: 'foo', name: 'Foo' }),
    /harness:write permission required/,
  )
})

test('publishHarnessVersion calls POST /v1/harnesses/:id/versions with version + manifest + manifest_hash', async () => {
  mockResponse = { status: 200, body: { id: 'h1', version: '1.0.0', manifest_hash: 'sha256:abc' } }
  const manifest = { schema_version: '1.1', format: 'agent', targets: ['claude'], components: [] }
  const result = await publishHarnessVersion('h1', {
    version: '1.0.0',
    manifest,
    manifest_hash: 'sha256:abc',
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/harnesses/h1/versions')
  assert.equal(calls[0].init?.method, 'POST')
  const body = JSON.parse(calls[0].init?.body as string)
  assert.equal(body.version, '1.0.0')
  assert.deepEqual(body.manifest, manifest)
  assert.equal(body.manifest_hash, 'sha256:abc')
  assert.equal(result.manifest_hash, 'sha256:abc')
})

test('publishHarnessVersion omits manifest_hash when not provided', async () => {
  mockResponse = { status: 200, body: { id: 'h1', version: '1.0.0' } }
  await publishHarnessVersion('h1', { version: '1.0.0', manifest: { schema_version: '1.1' } })
  const body = JSON.parse(calls[0].init?.body as string)
  assert.equal(body.manifest_hash, undefined)
})

test('publishHarnessVersion propagates a permission-denied (403) error without publishing anything', async () => {
  mockResponse = { status: 403, body: { error: 'harness:write permission required' } }
  await assert.rejects(
    () => publishHarnessVersion('h1', { version: '1.0.0', manifest: {} }),
    /harness:write permission required/,
  )
})

test('createHarnessConfigReview calls POST /v1/harness-config-reviews with redacted content + report + hash', async () => {
  mockResponse = { status: 200, body: { id: 'r1', source_tool: 'claude', status: 'pending' } }
  const result = await createHarnessConfigReview({
    source_tool: 'claude',
    redacted_config: { model: 'claude' },
    redaction_report: { findings: [] },
    content_hash: 'sha256:def',
    status: 'pending',
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://fake-backend.test/v1/harness-config-reviews')
  assert.equal(calls[0].init?.method, 'POST')
  const body = JSON.parse(calls[0].init?.body as string)
  assert.equal(body.source_tool, 'claude')
  assert.deepEqual(body.redacted_config, { model: 'claude' })
  assert.deepEqual(body.redaction_report, { findings: [] })
  assert.equal(body.content_hash, 'sha256:def')
  assert.equal(result.id, 'r1')
})

test('createHarnessConfigReview propagates rejection when raw content is unredacted', async () => {
  mockResponse = { status: 422, body: { error: 'unredacted secret indicators detected' } }
  await assert.rejects(
    () => createHarnessConfigReview({
      source_tool: 'claude',
      redacted_config: {},
      redaction_report: {},
      content_hash: 'sha256:def',
      status: 'pending',
    }),
    /unredacted secret indicators detected/,
  )
})
