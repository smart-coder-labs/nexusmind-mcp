import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Integration tests for the seven SDD MCP tools (design.md §6, spec
// sdd-artifact-agent-tools). Runs the ACTUAL compiled MCP server (dist/index.js)
// as a subprocess and talks to it over stdio — same approach as
// tasks-tools.test.ts.
//
// The fake backend here is STATEFUL, unlike the one in tasks-tools.test.ts: the
// spec's assertions are mostly about what did NOT get written ("no change,
// artifact, or revision is created"), which a canned-response stub cannot show.
// It mirrors api/sdd.rs: idempotency by content hash, 200-never-201 on PUT, the
// 1 MB cap, 404 for both not-found and not-visible, and atomic 422s.
const DIST = resolve(process.cwd(), 'dist')
const ENTRY = join(DIST, 'index.js')
const distBuilt = existsSync(ENTRY)
const skip = distBuilt ? false : 'dist not built — run `npm run build` first'

const MAX_ARTIFACT_BYTES = 1_048_576
const KINDS = [
  'exploration', 'proposal', 'spec', 'design', 'tasks',
  'apply-progress', 'verify-report', 'archive-report', 'state',
]
const PHASES = ['explore', 'propose', 'spec', 'design', 'tasks', 'apply', 'verify', 'archive']
const STATUSES = ['active', 'archived', 'abandoned']

interface FakeChange {
  id: string
  org_id: string
  project: string
  name: string
  title?: string
  status: string
  phase: string
  sprint_id?: string
  created_by: string
  created_at: string
  updated_at: string
  archived_at?: string | null
}

interface FakeArtifact {
  id: string
  change_id: string
  kind: string
  capability: string
  path?: string
  latest_revision: number
  created_at: string
  updated_at: string
}

interface FakeRevision {
  id: string
  artifact_id: string
  revision: number
  content: string
  content_hash: string
  byte_size: number
  source: string
  created_by: string
  created_at: string
}

interface FakeMemory {
  id: string
  user_id: string
  project: string
  tool: string
  title: string
  content: string
  tags: string[]
  revision_count: number
  scope: string
  created_at: string
}

interface FakeBackend {
  port: number
  requests: Array<{ url: string; method: string; body: unknown }>
  perms: Set<string>
  changes: FakeChange[]
  artifacts: FakeArtifact[]
  revisions: FakeRevision[]
  memories: FakeMemory[]
  links: Array<{ change_id: string; memory_id: string; relation: string }>
  /** Seeds a change + artifact + one revision per content, exactly as a series of PUTs would. */
  seed: (project: string, changeName: string, kind: string, contents: string[], capability?: string) => FakeArtifact
  change: (name: string) => FakeChange | undefined
  close: () => Promise<void>
}

const NOW = '2026-01-01T00:00:00Z'
let idSeq = 0
const nextId = (prefix: string) => `${prefix}-${++idSeq}`
const hash = (s: string) => createHash('sha256').update(s).digest('hex')

function startFakeBackend(): Promise<FakeBackend> {
  return new Promise(resolveP => {
    const state = {
      requests: [] as Array<{ url: string; method: string; body: unknown }>,
      perms: new Set(['sdd:read', 'sdd:write']),
      changes: [] as FakeChange[],
      artifacts: [] as FakeArtifact[],
      revisions: [] as FakeRevision[],
      memories: [] as FakeMemory[],
      links: [] as Array<{ change_id: string; memory_id: string; relation: string }>,
    }

    const upsertChange = (project: string, name: string): FakeChange => {
      const found = state.changes.find(c => c.project === project && c.name === name)
      if (found) return found
      const change: FakeChange = {
        id: nextId('chg'),
        org_id: 'org-a',
        project,
        name,
        status: 'active',
        phase: 'propose',
        created_by: 'u1',
        created_at: NOW,
        updated_at: NOW,
        archived_at: null,
      }
      state.changes.push(change)
      return change
    }

    const latestRevision = (artifactId: string): FakeRevision | undefined =>
      state.revisions
        .filter(r => r.artifact_id === artifactId)
        .sort((a, b) => b.revision - a.revision)[0]

    const detail = (a: FakeArtifact) => {
      const change = state.changes.find(c => c.id === a.change_id)!
      const rev = latestRevision(a.id)
      return {
        ...a,
        change_name: change.name,
        project: change.project,
        content: rev?.content,
        content_hash: rev?.content_hash,
      }
    }

    const put = (project: string, changeName: string, kind: string, capability: string, content: string, path?: string) => {
      const change = upsertChange(project, changeName)
      let artifact = state.artifacts.find(
        a => a.change_id === change.id && a.kind === kind && a.capability === capability,
      )
      if (!artifact) {
        artifact = {
          id: nextId('art'),
          change_id: change.id,
          kind,
          capability,
          path,
          latest_revision: 0,
          created_at: NOW,
          updated_at: NOW,
        }
        state.artifacts.push(artifact)
      }
      if (path !== undefined) artifact.path = path

      const latest = latestRevision(artifact.id)
      if (latest && latest.content === content) {
        return { artifact, created_revision: false }
      }
      const revision = artifact.latest_revision + 1
      state.revisions.push({
        id: nextId('rev'),
        artifact_id: artifact.id,
        revision,
        content,
        content_hash: hash(content),
        byte_size: Buffer.byteLength(content, 'utf8'),
        source: 'agent',
        created_by: 'u1',
        created_at: NOW,
      })
      artifact.latest_revision = revision
      return { artifact, created_revision: true }
    }

    const server = http.createServer((req, res) => {
      const rawUrl = req.url ?? ''
      const method = req.method ?? 'GET'
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: any
        try { body = raw ? JSON.parse(raw) : undefined } catch { body = raw }
        state.requests.push({ url: rawUrl, method, body })

        const url = new URL(rawUrl, 'http://fake')
        const path = url.pathname
        const q = url.searchParams

        const send = (status: number, payload?: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          if (status === 204 || payload === undefined) { res.end(); return }
          res.end(JSON.stringify(payload))
        }
        const deny = (perm: string) => send(403, { error: `${perm} permission required`, code: 'forbidden' })
        const notFound = () => send(404, { error: 'Not found', code: 'not_found' })
        const unprocessable = (code: string, message: string) => send(422, { error: message, code })

        // PUT /v1/sdd/artifacts — the workhorse. 200 always, never 201.
        if (path === '/v1/sdd/artifacts' && method === 'PUT') {
          if (!state.perms.has('sdd:write')) return deny('sdd:write')
          if (!KINDS.includes(body?.kind)) return unprocessable('invalid_kind', `invalid_kind: ${body?.kind}`)
          // Validated BEFORE the store is touched: a rejected save must leave no change behind.
          if (Buffer.byteLength(String(body?.content ?? ''), 'utf8') > MAX_ARTIFACT_BYTES) {
            return unprocessable('artifact_too_large', 'artifact_too_large')
          }
          const result = put(
            body.project, body.change_name, body.kind,
            body.capability ?? '', body.content, body.path,
          )
          return send(200, result)
        }

        // GET /v1/sdd/artifacts?project=&change_name=&kind=&capability= — natural key.
        if (path === '/v1/sdd/artifacts' && method === 'GET') {
          if (!state.perms.has('sdd:read')) return deny('sdd:read')
          const change = state.changes.find(
            c => c.project === q.get('project') && c.name === q.get('change_name'),
          )
          if (!change) return notFound()
          const artifact = state.artifacts.find(
            a => a.change_id === change.id && a.kind === q.get('kind') && a.capability === (q.get('capability') ?? ''),
          )
          if (!artifact) return notFound()
          return send(200, detail(artifact))
        }

        const revMatch = path.match(/^\/v1\/sdd\/artifacts\/([^/]+)\/revisions\/(\d+)$/)
        if (revMatch && method === 'GET') {
          if (!state.perms.has('sdd:read')) return deny('sdd:read')
          const rev = state.revisions.find(
            r => r.artifact_id === revMatch[1] && r.revision === Number(revMatch[2]),
          )
          return rev ? send(200, rev) : notFound()
        }

        const artMatch = path.match(/^\/v1\/sdd\/artifacts\/([^/]+)$/)
        if (artMatch && method === 'GET') {
          if (!state.perms.has('sdd:read')) return deny('sdd:read')
          const artifact = state.artifacts.find(a => a.id === artMatch[1])
          return artifact ? send(200, detail(artifact)) : notFound()
        }

        if (path === '/v1/sdd/changes' && method === 'GET') {
          if (!state.perms.has('sdd:read')) return deny('sdd:read')
          const includeArchived = q.get('include_archived') === 'true'
          const changes = state.changes.filter(c =>
            (!q.get('project')   || c.project   === q.get('project')) &&
            (!q.get('status')    || c.status    === q.get('status')) &&
            (!q.get('phase')     || c.phase     === q.get('phase')) &&
            (!q.get('sprint_id') || c.sprint_id === q.get('sprint_id')) &&
            (includeArchived || !c.archived_at),
          )
          // Metadata only: no artifacts, no content. Mirrors the Rust list handler.
          return send(200, changes.map(c => ({ ...c, artifacts: [], task_links: [], memory_links: [] })))
        }

        const memMatch = path.match(/^\/v1\/sdd\/changes\/([^/]+)\/memories$/)
        if (memMatch && method === 'POST') {
          if (!state.perms.has('sdd:write')) return deny('sdd:write')
          const change = state.changes.find(c => c.id === memMatch[1])
          if (!change) return notFound()
          const memory = state.memories.find(m => m.id === body?.memory_id)
          if (!memory) return notFound() // not visible from this caller's view
          const relation = body?.relation ?? 'produced'
          const existing = state.links.find(l => l.change_id === change.id && l.memory_id === memory.id)
          if (existing) existing.relation = relation
          else state.links.push({ change_id: change.id, memory_id: memory.id, relation })
          const linked = state.links
            .filter(l => l.change_id === change.id)
            .map(l => state.memories.find(m => m.id === l.memory_id)!)
          return send(200, linked)
        }

        const chgMatch = path.match(/^\/v1\/sdd\/changes\/([^/]+)$/)
        if (chgMatch && method === 'GET') {
          if (!state.perms.has('sdd:read')) return deny('sdd:read')
          const change = state.changes.find(c => c.id === chgMatch[1])
          if (!change) return notFound()
          const artifacts = state.artifacts.filter(a => a.change_id === change.id)
          const memory_links = state.links
            .filter(l => l.change_id === change.id)
            .map(l => state.memories.find(m => m.id === l.memory_id)!)
          return send(200, { ...change, artifacts, task_links: [], memory_links })
        }

        if (chgMatch && method === 'PATCH') {
          if (!state.perms.has('sdd:write')) return deny('sdd:write')
          const change = state.changes.find(c => c.id === chgMatch[1])
          if (!change) return notFound()
          if (body?.phase !== undefined && !PHASES.includes(body.phase)) {
            return unprocessable('invalid_phase', `invalid_phase: ${body.phase}`) // atomic: nothing applied
          }
          if (body?.status !== undefined && !STATUSES.includes(body.status)) {
            return unprocessable('invalid_status', `invalid_status: ${body.status}`)
          }
          if (body?.title     !== undefined) change.title     = body.title
          if (body?.phase     !== undefined) change.phase     = body.phase
          if (body?.status    !== undefined) change.status    = body.status
          if (body?.sprint_id !== undefined) change.sprint_id = body.sprint_id
          return send(200, change)
        }

        if (path === '/v1/sdd/search' && method === 'GET') {
          if (!state.perms.has('sdd:read')) return deny('sdd:read')
          const term = (q.get('q') ?? '').trim()
          if (!term) return send(200, [])
          const limit = Math.min(Number(q.get('limit') ?? 20), 50)
          const hits = state.artifacts
            .map(a => ({ a, rev: latestRevision(a.id) }))
            .filter(({ rev }) => rev && rev.content.toLowerCase().includes(term.toLowerCase()))
            .map(({ a, rev }) => {
              const change = state.changes.find(c => c.id === a.change_id)!
              const at = rev!.content.toLowerCase().indexOf(term.toLowerCase())
              return {
                artifact_id: a.id,
                change_id: change.id,
                change_name: change.name,
                project: change.project,
                kind: a.kind,
                capability: a.capability,
                snippet: `…${rev!.content.slice(Math.max(0, at - 20), at + term.length + 20)}…`,
              }
            })
            .slice(0, limit)
          return send(200, hits)
        }

        return notFound()
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolveP({
        port,
        get requests() { return state.requests },
        perms: state.perms,
        get changes() { return state.changes },
        get artifacts() { return state.artifacts },
        get revisions() { return state.revisions },
        get memories() { return state.memories },
        get links() { return state.links },
        seed: (project, changeName, kind, contents, capability = '') => {
          let artifact!: FakeArtifact
          for (const content of contents) {
            artifact = put(project, changeName, kind, capability, content).artifact
          }
          return artifact
        },
        change: (name: string) => state.changes.find(c => c.name === name),
        close: () => new Promise(r => server.close(() => r())),
      })
    })
  })
}

async function withClient(backend: FakeBackend, fn: (client: Client) => Promise<void>): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      NEXUSMIND_API_KEY: 'nm_test_key',
      NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}`,
    },
  })
  const client = new Client({ name: 'sdd-tools-test', version: '1.0.0' })
  await client.connect(transport)
  try {
    await fn(client)
  } finally {
    await client.close()
  }
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>).map(c => c.text).join('\n')
}

/** A tool call "fails" whether the SDK rejects (schema validation) or returns isError. */
async function callExpectingFailure(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const result = await client.callTool({ name, arguments: args })
    assert.equal(result.isError, true, `${name} should have failed but returned: ${textOf(result)}`)
    return textOf(result)
  } catch (err) {
    return (err as Error).message
  }
}

// ── save_sdd_artifact ───────────────────────────────────────────────────────

test('save_sdd_artifact_tool_enforces_sdd_write', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.perms.delete('sdd:write')
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'save_sdd_artifact',
        arguments: { project: 'nexus-mind', change_name: 'sdd-artifacts', kind: 'design', content: '# Design' },
      })
      assert.equal(result.isError, true)
      assert.match(textOf(result), /sdd:write/)
      assert.equal(backend.changes.length, 0, 'a denied save creates no change')
      assert.equal(backend.artifacts.length, 0, 'a denied save creates no artifact')
      assert.equal(backend.revisions.length, 0, 'a denied save creates no revision')
    })
  } finally {
    await backend.close()
  }
})

test('save_sdd_artifact_reports_whether_a_revision_was_created', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.seed('nexus-mind', 'sdd-artifacts', 'design', ['v1 design', 'v2 design'])
  assert.equal(backend.revisions.length, 2)
  try {
    await withClient(backend, async client => {
      // Byte-identical re-save: no revision, still at 2.
      const same = await client.callTool({
        name: 'save_sdd_artifact',
        arguments: { project: 'nexus-mind', change_name: 'sdd-artifacts', kind: 'design', content: 'v2 design' },
      })
      assert.equal(same.isError, undefined)
      assert.match(textOf(same), /unchanged/i)
      assert.match(textOf(same), /revision 2/)
      assert.equal(backend.revisions.length, 2, 'an identical re-save creates NO revision')

      // Edited content: revision 3.
      const edited = await client.callTool({
        name: 'save_sdd_artifact',
        arguments: { project: 'nexus-mind', change_name: 'sdd-artifacts', kind: 'design', content: 'v3 design' },
      })
      assert.equal(edited.isError, undefined)
      assert.match(textOf(edited), /revision 3 created/)
      assert.equal(backend.revisions.length, 3)
      assert.equal(backend.artifacts[0].latest_revision, 3)
    })
  } finally {
    await backend.close()
  }
})

test('save_sdd_artifact_for_an_unknown_change_creates_the_change', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'save_sdd_artifact',
        arguments: { project: 'nexus-mind', change_name: 'new-thing', kind: 'proposal', content: '## Why' },
      })
      assert.equal(result.isError, undefined)
      assert.equal(backend.changes.length, 1, 'the save IS the create — no separate create call')
      assert.equal(backend.changes[0].name, 'new-thing')
      assert.equal(backend.artifacts.length, 1)

      const text = textOf(result)
      assert.match(text, /new-thing/, 'the response identifies the created change by name')
      assert.match(text, new RegExp(backend.changes[0].id), 'and by id')
      assert.match(text, /revision 1 created/)
      // Exactly one backend call: the PUT. No create-then-save round trip.
      assert.equal(backend.requests.length, 1)
      assert.equal(backend.requests[0].method, 'PUT')
    })
  } finally {
    await backend.close()
  }
})

test('save_sdd_artifact_oversized_content_fails_the_call_and_writes_nothing', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    await withClient(backend, async client => {
      const huge = 'x'.repeat(MAX_ARTIFACT_BYTES + 1)
      const result = await client.callTool({
        name: 'save_sdd_artifact',
        arguments: { project: 'nexus-mind', change_name: 'oversized', kind: 'design', content: huge },
      })
      assert.equal(result.isError, true, 'the tool call FAILS — it must not report success on a 4xx')
      assert.match(textOf(result), /artifact_too_large/)
      assert.equal(backend.changes.length, 0, 'a rejected save leaves NO change')
      assert.equal(backend.artifacts.length, 0)
      assert.equal(backend.revisions.length, 0)
    })
  } finally {
    await backend.close()
  }
})

test('save_sdd_artifact_persists_spec_per_capability', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    await withClient(backend, async client => {
      for (const [capability, content] of [
        ['sdd-artifact-store', 'STORE SPEC'],
        ['sdd-artifact-links', 'LINKS SPEC'],
      ]) {
        const result = await client.callTool({
          name: 'save_sdd_artifact',
          arguments: { project: 'nexus-mind', change_name: 'sdd-artifacts', kind: 'spec', capability, content },
        })
        assert.equal(result.isError, undefined)
        assert.match(textOf(result), new RegExp(capability), 'capability is forwarded verbatim and echoed back')
      }

      assert.equal(backend.artifacts.length, 2, 'two distinct spec artifacts, one per capability')
      assert.equal(backend.changes.length, 1)
      const caps = backend.artifacts.map(a => a.capability).sort()
      assert.deepEqual(caps, ['sdd-artifact-links', 'sdd-artifact-store'])
      // Neither overwrote the other: each is at revision 1 with its own content.
      assert.deepEqual(backend.revisions.map(r => r.content).sort(), ['LINKS SPEC', 'STORE SPEC'])
      const sent = backend.requests.map(r => (r.body as { capability?: string }).capability)
      assert.deepEqual(sent, ['sdd-artifact-store', 'sdd-artifact-links'])
    })
  } finally {
    await backend.close()
  }
})

// ── get_sdd_artifact — the cross-phase read ─────────────────────────────────

test('get_sdd_artifact_returns_full_content_not_a_preview', { skip }, async () => {
  const backend = await startFakeBackend()
  // ~36 KB, the size of a real design.md.
  const big = 'a very long design document line with detail. '.repeat(800)
  assert.ok(Buffer.byteLength(big) > 35_000)
  backend.seed('nexus-mind', 'sdd-artifacts', 'design', [big])
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'get_sdd_artifact',
        arguments: { project: 'nexus-mind', change_name: 'sdd-artifacts', kind: 'design' },
      })
      assert.equal(result.isError, undefined)
      const text = textOf(result)
      assert.ok(text.includes(big), 'the document comes back BYTE-IDENTICAL and whole')
      assert.equal(text.includes('…'), false, 'not ellipsized')
      assert.equal(text.includes('...'), false, 'not truncated with dots')
      assert.ok(text.length >= big.length, 'the response is at least as long as the document')
    })
  } finally {
    await backend.close()
  }
})

test('get_sdd_artifact_by_change_and_kind_resolves_the_spec_capability', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.seed('nexus-mind', 'sdd-artifacts', 'design', ['DESIGN BODY'])
  backend.seed('nexus-mind', 'sdd-artifacts', 'spec', ['STORE SPEC'], 'sdd-artifact-store')
  backend.seed('nexus-mind', 'sdd-artifacts', 'spec', ['LINKS SPEC'], 'sdd-artifact-links')
  try {
    await withClient(backend, async client => {
      const spec = await client.callTool({
        name: 'get_sdd_artifact',
        arguments: { project: 'nexus-mind', change_name: 'sdd-artifacts', kind: 'spec', capability: 'sdd-artifact-store' },
      })
      assert.equal(spec.isError, undefined)
      assert.match(textOf(spec), /STORE SPEC/)
      assert.equal(textOf(spec).includes('LINKS SPEC'), false, 'the other capability\'s spec is not returned')

      const design = await client.callTool({
        name: 'get_sdd_artifact',
        arguments: { project: 'nexus-mind', change_name: 'sdd-artifacts', kind: 'design' },
      })
      assert.equal(design.isError, undefined)
      assert.match(textOf(design), /DESIGN BODY/)

      // No artifact_id was ever needed — every read went to the natural-key route.
      for (const r of backend.requests) {
        assert.equal(new URL(r.url, 'http://x').pathname, '/v1/sdd/artifacts')
        assert.equal(r.method, 'GET')
      }
    })
  } finally {
    await backend.close()
  }
})

test('get_sdd_artifact_accepts_an_explicit_revision_number', { skip }, async () => {
  const backend = await startFakeBackend()
  const artifact = backend.seed('nexus-mind', 'sdd-artifacts', 'design', ['REV ONE', 'REV TWO', 'REV THREE'])
  try {
    await withClient(backend, async client => {
      const second = await client.callTool({
        name: 'get_sdd_artifact',
        arguments: { artifact_id: artifact.id, revision: 2 },
      })
      assert.equal(second.isError, undefined)
      assert.match(textOf(second), /REV TWO/)
      assert.equal(textOf(second).includes('REV THREE'), false, 'revision 3 content is NOT returned')

      const latest = await client.callTool({
        name: 'get_sdd_artifact',
        arguments: { artifact_id: artifact.id },
      })
      assert.equal(latest.isError, undefined)
      assert.match(textOf(latest), /REV THREE/, 'omitting revision defaults to the latest')
    })
  } finally {
    await backend.close()
  }
})

test('get_sdd_artifact_missing_reports_not_found_not_an_empty_document', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.seed('nexus-mind', 'sdd-artifacts', 'proposal', ['## Why'])
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'get_sdd_artifact',
        arguments: { project: 'nexus-mind', change_name: 'sdd-artifacts', kind: 'design' },
      })
      assert.equal(result.isError, true)
      const text = textOf(result)
      assert.match(text, /not found/i)
      assert.notEqual(text.trim(), '', 'never an empty string a caller could mistake for an empty design')
      assert.match(text, /NOT an empty document/i)
    })
  } finally {
    await backend.close()
  }
})

test('get_sdd_artifact_cross_org_reports_not_found', { skip }, async () => {
  const backend = await startFakeBackend()
  // The artifact exists — but in another org, so the backend answers 404 exactly
  // as the REST endpoint would. The tool adds no authority: it just surfaces it.
  try {
    await withClient(backend, async client => {
      const byId = await client.callTool({
        name: 'get_sdd_artifact',
        arguments: { artifact_id: 'art-belonging-to-org-b' },
      })
      assert.equal(byId.isError, true)
      assert.match(textOf(byId), /not found/i)

      const byKey = await client.callTool({
        name: 'get_sdd_artifact',
        arguments: { project: 'org-b-project', change_name: 'org-b-change', kind: 'design' },
      })
      assert.equal(byKey.isError, true)
      assert.match(textOf(byKey), /not found/i)
      assert.equal(textOf(byKey).includes('org B secret'), false, 'no content whatsoever')
    })
  } finally {
    await backend.close()
  }
})

// ── permissions ─────────────────────────────────────────────────────────────

test('search_sdd_artifacts_enforces_sdd_read', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.seed('nexus-mind', 'sdd-artifacts', 'design', ['a secret design about rate limiting'])
  backend.perms.delete('sdd:read')
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'search_sdd_artifacts',
        arguments: { query: 'rate limiting' },
      })
      assert.equal(result.isError, true)
      assert.match(textOf(result), /sdd:read/)
      const text = textOf(result)
      assert.equal(text.includes('secret design'), false, 'no content reaches the agent')
      assert.equal(text.includes('sdd-artifacts'), false, 'no metadata reaches the agent either')
    })
  } finally {
    await backend.close()
  }
})

test('read_only_caller_can_read_but_not_write', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.seed('nexus-mind', 'sdd-artifacts', 'design', ['DESIGN BODY'])
  backend.perms.delete('sdd:write')
  try {
    await withClient(backend, async client => {
      const read = await client.callTool({
        name: 'get_sdd_artifact',
        arguments: { project: 'nexus-mind', change_name: 'sdd-artifacts', kind: 'design' },
      })
      assert.equal(read.isError, undefined, 'sdd:read alone is enough to read')
      assert.match(textOf(read), /DESIGN BODY/)

      const write = await client.callTool({
        name: 'save_sdd_artifact',
        arguments: { project: 'nexus-mind', change_name: 'sdd-artifacts', kind: 'design', content: 'EDITED' },
      })
      assert.equal(write.isError, true, 'the same key cannot write')
      assert.match(textOf(write), /sdd:write/)
      assert.equal(backend.revisions.length, 1, 'nothing was written')
      assert.equal(backend.revisions[0].content, 'DESIGN BODY')
    })
  } finally {
    await backend.close()
  }
})

// ── list_sdd_changes ────────────────────────────────────────────────────────

test('list_sdd_changes_filters_and_omits_content', { skip }, async () => {
  const backend = await startFakeBackend()
  const big = 'markdown design body '.repeat(1_800) // ~36 KB
  backend.seed('nexus-mind', 'sdd-artifacts', 'design', [big])
  backend.seed('nexus-mind', 'team-tasks', 'proposal', ['P'])
  backend.seed('other-project', 'other-change', 'proposal', ['P'])
  backend.change('sdd-artifacts')!.phase = 'design'
  backend.change('team-tasks')!.phase = 'apply'
  try {
    await withClient(backend, async client => {
      const byProject = await client.callTool({
        name: 'list_sdd_changes',
        arguments: { project: 'nexus-mind' },
      })
      assert.equal(byProject.isError, undefined)
      const text = textOf(byProject)
      assert.match(text, /sdd-artifacts/)
      assert.match(text, /team-tasks/)
      assert.equal(text.includes('other-change'), false, "only that project's changes")
      assert.match(text, /phase: design/, 'each change carries its phase')
      assert.match(text, /status: active/, 'and its status')
      assert.equal(text.includes('markdown design body'), false, 'the 36 KB design markdown is NOT in the listing')

      const byPhase = await client.callTool({
        name: 'list_sdd_changes',
        arguments: { phase: 'design' },
      })
      const phaseText = textOf(byPhase)
      assert.match(phaseText, /sdd-artifacts/)
      assert.equal(phaseText.includes('team-tasks'), false, 'only design-phase changes')
      assert.equal(new URL(backend.requests[1].url, 'http://x').searchParams.get('phase'), 'design')
    })
  } finally {
    await backend.close()
  }
})

// ── get_sdd_change ──────────────────────────────────────────────────────────

test('get_sdd_change_returns_the_artifact_inventory_as_recoverable_state', { skip }, async () => {
  const backend = await startFakeBackend()
  const big = 'design body '.repeat(3_000)
  backend.seed('nexus-mind', 'sdd-artifacts', 'proposal', ['## Why'])
  backend.seed('nexus-mind', 'sdd-artifacts', 'spec', ['SPEC'], 'sdd-artifact-store')
  backend.seed('nexus-mind', 'sdd-artifacts', 'design', ['old', big])
  const change = backend.change('sdd-artifacts')!
  // A STALE phase: the change says `spec`, but a design artifact already exists.
  change.phase = 'spec'
  backend.memories.push({
    id: 'mem-1', user_id: 'u1', project: 'nexus-mind', tool: 'claude-code',
    title: 'Chose SQLite FTS5', content: 'a decision', tags: [], revision_count: 1,
    scope: 'project', created_at: NOW,
  })
  backend.links.push({ change_id: change.id, memory_id: 'mem-1', relation: 'produced' })
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'get_sdd_change',
        arguments: { change_id: change.id },
      })
      assert.equal(result.isError, undefined)
      const text = textOf(result)

      assert.match(text, /Phase: spec/)
      assert.match(text, /proposal — revision 1/)
      assert.match(text, /spec\/sdd-artifact-store — revision 1/, 'kind + capability')
      assert.match(text, /design — revision 2/, 'the inventory contradicts the stale phase and the inventory wins')
      assert.match(text, /Chose SQLite FTS5/, 'linked memories')
      assert.match(text, /Linked tasks \(0\)/)
      assert.equal(text.includes('design body design body'), false, 'the inventory omits content')

      // Resolvable by natural key too — no checkout, no id.
      const byName = await client.callTool({
        name: 'get_sdd_change',
        arguments: { project: 'nexus-mind', change_name: 'sdd-artifacts' },
      })
      assert.equal(byName.isError, undefined)
      assert.match(textOf(byName), /design — revision 2/)
    })
  } finally {
    await backend.close()
  }
})

// ── update_sdd_change ───────────────────────────────────────────────────────

test('update_sdd_change_transitions_phase_and_denies_without_sdd_write', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.seed('nexus-mind', 'sdd-artifacts', 'tasks', ['T'])
  const change = backend.change('sdd-artifacts')!
  change.phase = 'tasks'
  try {
    await withClient(backend, async client => {
      const ok = await client.callTool({
        name: 'update_sdd_change',
        arguments: { change_id: change.id, phase: 'apply' },
      })
      assert.equal(ok.isError, undefined)
      assert.match(textOf(ok), /phase: apply/, 'the tool confirms the transition')
      assert.equal(change.phase, 'apply')
      assert.deepEqual(backend.requests[0].body, { phase: 'apply' }, 'no project/name in the PATCH body')
    })

    backend.perms.delete('sdd:write')
    await withClient(backend, async client => {
      const denied = await client.callTool({
        name: 'update_sdd_change',
        arguments: { change_id: change.id, phase: 'verify' },
      })
      assert.equal(denied.isError, true)
      assert.match(textOf(denied), /sdd:write/)
      assert.equal(change.phase, 'apply', 'the change is unmodified')
    })
  } finally {
    await backend.close()
  }
})

test('update_sdd_change_invalid_phase_is_rejected_atomically_and_unknown_change_reports_not_found', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.seed('nexus-mind', 'sdd-artifacts', 'design', ['D'])
  const change = backend.change('sdd-artifacts')!
  try {
    await withClient(backend, async client => {
      const message = await callExpectingFailure(client, 'update_sdd_change', {
        change_id: change.id, phase: 'shipped', title: 'New',
      })
      assert.ok(/phase|invalid|shipped/i.test(message), `expected a validation error, got: ${message}`)
      assert.equal(change.phase, 'propose', 'the phase is unchanged')
      assert.equal(change.title, undefined, 'the title in the same rejected update must NOT have landed')

      const changesBefore = backend.changes.length
      const unknown = await client.callTool({
        name: 'update_sdd_change',
        arguments: { change_id: 'chg-does-not-exist', phase: 'apply' },
      })
      assert.equal(unknown.isError, true)
      assert.match(textOf(unknown), /not found/i)
      assert.equal(backend.changes.length, changesBefore, 'no change is created on a miss — there is no create-on-miss path')
    })
  } finally {
    await backend.close()
  }
})

// ── search_sdd_artifacts ────────────────────────────────────────────────────

test('search_sdd_artifacts_returns_identifiers_sufficient_to_fetch_and_honours_the_limit', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.seed('nexus-mind', 'change-one', 'spec', ['we apply TOKENWORD rate limiting here'], 'rate-limits')
  backend.seed('nexus-mind', 'change-two', 'design', ['TOKENWORD appears in the design too'])
  backend.seed('nexus-mind', 'change-three', 'proposal', ['a TOKENWORD proposal'])
  for (let i = 0; i < 20; i++) {
    backend.seed('nexus-mind', `filler-${i}`, 'design', [`filler TOKENWORD body ${i}`])
  }
  try {
    await withClient(backend, async client => {
      const all = await client.callTool({
        name: 'search_sdd_artifacts',
        arguments: { query: 'TOKENWORD' },
      })
      assert.equal(all.isError, undefined)
      const text = textOf(all)
      // Every hit carries the natural key an agent feeds straight to get_sdd_artifact.
      assert.match(text, /change-one/)
      assert.match(text, /change-two/)
      assert.match(text, /change-three/, 'search spans changes, not just the current one')
      assert.match(text, /spec\/rate-limits/, 'kind + capability')
      assert.match(text, /rate limiting/, 'and a snippet')

      const limited = await client.callTool({
        name: 'search_sdd_artifacts',
        arguments: { query: 'TOKENWORD', limit: 5 },
      })
      assert.equal(limited.isError, undefined)
      const bullets = textOf(limited).split('\n').filter(l => l.startsWith('• '))
      assert.equal(bullets.length, 5, 'at most 5 of the 23 matches')
      assert.equal(new URL(backend.requests[1].url, 'http://x').searchParams.get('limit'), '5')
    })
  } finally {
    await backend.close()
  }
})

// ── link_sdd_change_memory ──────────────────────────────────────────────────

test('link_sdd_change_memory_ties_a_decision_to_a_change_and_is_idempotent', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.seed('nexus-mind', 'sdd-artifacts', 'design', ['D'])
  const change = backend.change('sdd-artifacts')!
  backend.memories.push({
    id: 'mem-1', user_id: 'u1', project: 'nexus-mind', tool: 'claude-code',
    title: 'Chose SQLite FTS5', content: 'a decision', tags: [], revision_count: 1,
    scope: 'project', created_at: NOW,
  })
  try {
    await withClient(backend, async client => {
      const first = await client.callTool({
        name: 'link_sdd_change_memory',
        arguments: { change_id: change.id, memory_id: 'mem-1', relation: 'produced' },
      })
      assert.equal(first.isError, undefined)
      assert.match(textOf(first), /mem-1/)
      assert.equal(backend.links.length, 1)
      assert.deepEqual(backend.requests[0].body, { memory_id: 'mem-1', relation: 'produced' })

      // The memory now appears among the change's linked memories.
      const detail = await client.callTool({ name: 'get_sdd_change', arguments: { change_id: change.id } })
      assert.match(textOf(detail), /Linked memories \(1\)/)
      assert.match(textOf(detail), /Chose SQLite FTS5/)

      // Re-linking the same pair: succeeds, no duplicate.
      const again = await client.callTool({
        name: 'link_sdd_change_memory',
        arguments: { change_id: change.id, memory_id: 'mem-1', relation: 'produced' },
      })
      assert.equal(again.isError, undefined)
      assert.equal(backend.links.length, 1, 'no duplicate link')

      // An invisible memory: not-found, and nothing is written.
      const invisible = await client.callTool({
        name: 'link_sdd_change_memory',
        arguments: { change_id: change.id, memory_id: 'mem-from-another-org' },
      })
      assert.equal(invisible.isError, true)
      assert.match(textOf(invisible), /not found/i)
      assert.equal(backend.links.length, 1, 'no link was created for an invisible memory')
    })
  } finally {
    await backend.close()
  }
})

// ── the tool surface itself ─────────────────────────────────────────────────

test('exactly_seven_sdd_tools_are_registered', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    await withClient(backend, async client => {
      const { tools } = await client.listTools()
      const sddTools = tools.map(t => t.name).filter(n => n.includes('sdd')).sort()
      assert.deepEqual(sddTools, [
        'get_sdd_artifact',
        'get_sdd_change',
        'link_sdd_change_memory',
        'list_sdd_changes',
        'save_sdd_artifact',
        'search_sdd_artifacts',
        'update_sdd_change',
      ], 'exactly seven SDD tools — no create_sdd_change, no delete_sdd_change (archival is admin/API-only)')
      assert.equal(sddTools.length, 7)
    })
  } finally {
    await backend.close()
  }
})
