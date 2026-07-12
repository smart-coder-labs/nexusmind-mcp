import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Integration tests for the three SDD *spec* MCP tools — the ones over
// `openspec/specs/{capability}/spec.md`, the LIVING SPECIFICATION.
//
// Same shape as sdd-tools.test.ts: the ACTUAL compiled server (dist/index.js) run as a
// subprocess and talked to over stdio, against a STATEFUL fake backend. Stateful,
// again, because most of what matters is what did NOT get written — an identical
// re-save creates no revision, an oversized contract creates no spec, an unknown
// change name creates nothing at all — and a canned-response stub cannot show that.
//
// The fake mirrors api/sdd.rs: idempotency by content hash against the LATEST
// revision only, 200-never-201 on PUT, the 1 MB cap, 404 for both not-found and
// not-visible, and the atomic rejection of an unresolvable merged_from_change_name.

const DIST = resolve(process.cwd(), 'dist')
const ENTRY = join(DIST, 'index.js')
const distBuilt = existsSync(ENTRY)
const skip = distBuilt ? false : 'dist not built — run `npm run build` first'

const MAX_SPEC_BYTES = 1_048_576

interface FakeSpec {
  id: string
  org_id: string
  project: string
  capability: string
  title?: string
  path?: string
  latest_revision: number
  created_by: string
  created_at: string
  updated_at: string
  archived_at?: string | null
  last_merged_from_change_id?: string
  last_merged_from_change_name?: string
}

interface FakeSpecRevision {
  id: string
  spec_id: string
  revision: number
  content: string
  content_hash: string
  byte_size: number
  merged_from_change_id?: string
  merged_from_change_name?: string
  source: string
  created_by: string
  created_at: string
}

interface FakeBackend {
  port: number
  requests: Array<{ url: string; method: string; body: unknown }>
  perms: Set<string>
  specs: FakeSpec[]
  revisions: FakeSpecRevision[]
  changes: Array<{ id: string; project: string; name: string }>
  /** Seeds a spec with one revision per content, exactly as a series of PUTs would. */
  seed: (project: string, capability: string, contents: string[], title?: string) => FakeSpec
  seedChange: (project: string, name: string) => { id: string; project: string; name: string }
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
      specs: [] as FakeSpec[],
      revisions: [] as FakeSpecRevision[],
      changes: [] as Array<{ id: string; project: string; name: string }>,
    }

    const latestRevision = (specId: string): FakeSpecRevision | undefined =>
      state.revisions.filter(r => r.spec_id === specId).sort((a, b) => b.revision - a.revision)[0]

    const detail = (s: FakeSpec) => {
      const rev = latestRevision(s.id)
      return { ...s, content: rev?.content, content_hash: rev?.content_hash }
    }

    /** Mirrors `upsert_sdd_spec`: idempotent by hash against the LATEST revision only. */
    const put = (
      project: string,
      capability: string,
      content: string,
      title?: string,
      path?: string,
      mergedFromChangeName?: string,
    ) => {
      let mergedChange: { id: string; project: string; name: string } | undefined
      if (mergedFromChangeName !== undefined) {
        mergedChange = state.changes.find(c => c.project === project && c.name === mergedFromChangeName)
        if (!mergedChange) return { notFound: true as const }
      }

      let spec = state.specs.find(s => s.project === project && s.capability === capability)
      if (!spec) {
        spec = {
          id: nextId('spec'),
          org_id: 'org-a',
          project,
          capability,
          title,
          path,
          latest_revision: 0,
          created_by: 'u1',
          created_at: NOW,
          updated_at: NOW,
          archived_at: null,
        }
        state.specs.push(spec)
      }
      if (title !== undefined) spec.title = title
      if (path  !== undefined) spec.path  = path

      const latest = latestRevision(spec.id)
      if (latest && latest.content === content) {
        return { spec, created_revision: false }
      }
      const revision = spec.latest_revision + 1
      state.revisions.push({
        id: nextId('srev'),
        spec_id: spec.id,
        revision,
        content,
        content_hash: hash(content),
        byte_size: Buffer.byteLength(content, 'utf8'),
        merged_from_change_id: mergedChange?.id,
        merged_from_change_name: mergedChange?.name,
        source: 'agent',
        created_by: 'u1',
        created_at: NOW,
      })
      spec.latest_revision = revision
      spec.last_merged_from_change_id = mergedChange?.id
      spec.last_merged_from_change_name = mergedChange?.name
      return { spec, created_revision: true }
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

        // PUT /v1/sdd/specs — the workhorse. 200 always, never 201.
        if (path === '/v1/sdd/specs' && method === 'PUT') {
          if (!state.perms.has('sdd:write')) return deny('sdd:write')
          // The guard is BEFORE the store is touched: a rejected save leaves nothing.
          if (Buffer.byteLength(String(body?.content ?? ''), 'utf8') > MAX_SPEC_BYTES) {
            return send(422, { error: 'spec_too_large', code: 'spec_too_large' })
          }
          const result = put(
            body.project, body.capability, body.content,
            body.title, body.path, body.merged_from_change_name,
          )
          // An unresolvable change name is a 404 and writes nothing.
          if ('notFound' in result) {
            return send(404, { error: 'change_not_found', code: 'change_not_found' })
          }
          return send(200, result)
        }

        // GET /v1/sdd/specs — natural key with `capability`, the list without it.
        if (path === '/v1/sdd/specs' && method === 'GET') {
          if (!state.perms.has('sdd:read')) return deny('sdd:read')
          const capability = q.get('capability')
          if (capability) {
            const spec = state.specs.find(
              s => s.project === q.get('project') && s.capability === capability,
            )
            return spec ? send(200, detail(spec)) : notFound()
          }
          const specs = state.specs.filter(s => !q.get('project') || s.project === q.get('project'))
          // Metadata only: never content. Mirrors the Rust list handler.
          return send(200, specs)
        }

        const revMatch = path.match(/^\/v1\/sdd\/specs\/([^/]+)\/revisions\/(\d+)$/)
        if (revMatch && method === 'GET') {
          if (!state.perms.has('sdd:read')) return deny('sdd:read')
          const rev = state.revisions.find(
            r => r.spec_id === revMatch[1] && r.revision === Number(revMatch[2]),
          )
          return rev ? send(200, rev) : notFound()
        }

        const revListMatch = path.match(/^\/v1\/sdd\/specs\/([^/]+)\/revisions$/)
        if (revListMatch && method === 'GET') {
          if (!state.perms.has('sdd:read')) return deny('sdd:read')
          const revs = state.revisions
            .filter(r => r.spec_id === revListMatch[1])
            .sort((a, b) => b.revision - a.revision)
            // Metadata only — the type has no content field, so neither does the payload.
            .map(({ content: _content, ...meta }) => meta)
          return send(200, revs)
        }

        const specMatch = path.match(/^\/v1\/sdd\/specs\/([^/]+)$/)
        if (specMatch && method === 'GET') {
          if (!state.perms.has('sdd:read')) return deny('sdd:read')
          const spec = state.specs.find(s => s.id === specMatch[1])
          return spec ? send(200, detail(spec)) : notFound()
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
        get specs() { return state.specs },
        get revisions() { return state.revisions },
        get changes() { return state.changes },
        seedChange: (project, name) => {
          const change = { id: nextId('chg'), project, name }
          state.changes.push(change)
          return change
        },
        seed: (project, capability, contents, title) => {
          let spec!: FakeSpec
          for (const content of contents) {
            const result = put(project, capability, content, title)
            if ('notFound' in result) throw new Error('unreachable')
            spec = result.spec
          }
          return spec
        },
        close: () => new Promise<void>(done => server.close(() => done())),
      })
    })
  })
}

async function connect(port: number): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      ...process.env,
      NEXUSMIND_API_KEY: 'nm_test_key',
      NEXUSMIND_BASE_URL: `http://127.0.0.1:${port}`,
    },
  })
  const client = new Client({ name: 'spec-test', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

function textOf(result: any): string {
  return (result.content ?? []).map((c: any) => c.text ?? '').join('\n')
}

// ── save_sdd_spec ────────────────────────────────────────────────────────────

test('save_sdd_spec creates the living specification at revision 1', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    const client = await connect(backend.port)
    const result = await client.callTool({
      name: 'save_sdd_spec',
      arguments: {
        project: 'nexus-mind',
        capability: 'harness-library',
        content: '# Harness Library\n\nThe library MUST be versioned.',
        title: 'Harness Library',
        path: 'openspec/specs/harness-library/spec.md',
      },
    })

    assert.equal(result.isError, undefined)
    assert.match(textOf(result), /revision 1 created/)
    assert.equal(backend.specs.length, 1)
    assert.equal(backend.specs[0].capability, 'harness-library')
    assert.equal(backend.revisions.length, 1)
    await client.close()
  } finally {
    await backend.close()
  }
})

test('save_sdd_spec is idempotent by content hash — an identical re-save creates NO revision', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    const client = await connect(backend.port)
    const args = {
      project: 'nexus-mind',
      capability: 'cap',
      content: 'the contract',
    }

    await client.callTool({ name: 'save_sdd_spec', arguments: args })
    const second = await client.callTool({ name: 'save_sdd_spec', arguments: args })

    assert.equal(second.isError, undefined)
    assert.match(textOf(second), /Content unchanged/)
    assert.match(textOf(second), /still at revision 1/)
    assert.equal(backend.revisions.length, 1, 'no second revision was written')
    await client.close()
  } finally {
    await backend.close()
  }
})

test('save_sdd_spec appends a revision when the contract is amended', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    const client = await connect(backend.port)

    await client.callTool({
      name: 'save_sdd_spec',
      arguments: { project: 'p', capability: 'cap', content: 'v1' },
    })
    const second = await client.callTool({
      name: 'save_sdd_spec',
      arguments: { project: 'p', capability: 'cap', content: 'v2' },
    })

    assert.match(textOf(second), /revision 2 created/)
    assert.equal(backend.revisions.length, 2)
    assert.equal(backend.revisions[0].content, 'v1', 'revision 1 is immutable')
    await client.close()
  } finally {
    await backend.close()
  }
})

test('save_sdd_spec records the change whose deltas it merged', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    backend.seedChange('nexus-mind', 'sdd-specs')
    const client = await connect(backend.port)

    const result = await client.callTool({
      name: 'save_sdd_spec',
      arguments: {
        project: 'nexus-mind',
        capability: 'sdd-spec-store',
        content: 'the merged contract',
        merged_from_change_name: 'sdd-specs',
      },
    })

    assert.equal(result.isError, undefined)
    assert.match(textOf(result), /Merged from change: sdd-specs/)
    assert.match(textOf(result), /traceable/)
    assert.equal(backend.revisions[0].merged_from_change_name, 'sdd-specs')
    await client.close()
  } finally {
    await backend.close()
  }
})

test('save_sdd_spec REFUSES an unknown change name and writes nothing', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    const client = await connect(backend.port)

    const result = await client.callTool({
      name: 'save_sdd_spec',
      arguments: {
        project: 'nexus-mind',
        capability: 'cap',
        content: 'the contract',
        merged_from_change_name: 'no-such-change',
      },
    })

    assert.equal(result.isError, true)
    assert.match(textOf(result), /Not found/)
    assert.match(textOf(result), /was NOT saved/, 'the agent must be told nothing landed')
    assert.equal(backend.specs.length, 0, 'no spec was created')
    assert.equal(backend.revisions.length, 0, 'and no revision')
    await client.close()
  } finally {
    await backend.close()
  }
})

test('save_sdd_spec surfaces the 1 MB rejection and creates nothing', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    const client = await connect(backend.port)

    const result = await client.callTool({
      name: 'save_sdd_spec',
      arguments: { project: 'p', capability: 'huge', content: 'x'.repeat(MAX_SPEC_BYTES + 1) },
    })

    assert.equal(result.isError, true)
    assert.match(textOf(result), /spec_too_large/)
    assert.equal(backend.specs.length, 0, 'the rejection is atomic — no spec row')
    assert.equal(backend.revisions.length, 0, '…and no revision row')
    await client.close()
  } finally {
    await backend.close()
  }
})

test('save_sdd_spec without sdd:write fails the call and writes nothing', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    backend.perms.delete('sdd:write')
    const client = await connect(backend.port)

    const result = await client.callTool({
      name: 'save_sdd_spec',
      arguments: { project: 'p', capability: 'cap', content: 'C' },
    })

    assert.equal(result.isError, true)
    assert.match(textOf(result), /sdd:write/)
    assert.equal(backend.specs.length, 0)
    await client.close()
  } finally {
    await backend.close()
  }
})

// ── get_sdd_spec ─────────────────────────────────────────────────────────────

test('get_sdd_spec returns the FULL contract, untruncated, by natural key', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    // A document long enough that any preview/truncation would show.
    const body = Array.from({ length: 200 }, (_, i) => `- Requirement ${i}: the system MUST do thing ${i}.`).join('\n')
    const content = `# Harness Library\n\n${body}\n\n## The last line, which must survive.`
    backend.seed('nexus-mind', 'harness-library', [content], 'Harness Library')

    const client = await connect(backend.port)
    const result = await client.callTool({
      name: 'get_sdd_spec',
      arguments: { project: 'nexus-mind', capability: 'harness-library' },
    })

    assert.equal(result.isError, undefined)
    const text = textOf(result)
    assert.match(text, /This is the CONTRACT, not a draft/)
    assert.ok(text.includes('- Requirement 0:'), 'the first requirement is present')
    assert.ok(text.includes('- Requirement 199:'), 'and the last one — nothing is truncated')
    assert.ok(text.includes('## The last line, which must survive.'))
    await client.close()
  } finally {
    await backend.close()
  }
})

test('get_sdd_spec resolves by spec_id too', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    const spec = backend.seed('p', 'cap', ['the contract'])
    const client = await connect(backend.port)

    const result = await client.callTool({ name: 'get_sdd_spec', arguments: { spec_id: spec.id } })

    assert.equal(result.isError, undefined)
    assert.match(textOf(result), /the contract/)
    await client.close()
  } finally {
    await backend.close()
  }
})

test('get_sdd_spec fetches an explicit older revision in full', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    const spec = backend.seed('p', 'cap', ['the original contract', 'the amended contract'])
    const client = await connect(backend.port)

    const latest = await client.callTool({ name: 'get_sdd_spec', arguments: { spec_id: spec.id } })
    assert.match(textOf(latest), /the amended contract/)

    const older = await client.callTool({
      name: 'get_sdd_spec',
      arguments: { spec_id: spec.id, revision: 1 },
    })
    assert.equal(older.isError, undefined)
    assert.match(textOf(older), /the original contract/)
    assert.match(textOf(older), /revision 1 of 2/)
    await client.close()
  } finally {
    await backend.close()
  }
})

test('get_sdd_spec names the change each revision was merged from', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    backend.seedChange('nexus-mind', 'sdd-specs')
    const client = await connect(backend.port)

    await client.callTool({
      name: 'save_sdd_spec',
      arguments: {
        project: 'nexus-mind',
        capability: 'cap',
        content: 'the contract',
        merged_from_change_name: 'sdd-specs',
      },
    })

    const result = await client.callTool({
      name: 'get_sdd_spec',
      arguments: { project: 'nexus-mind', capability: 'cap' },
    })

    assert.match(textOf(result), /merged from change "sdd-specs"/)
    await client.close()
  } finally {
    await backend.close()
  }
})

test('get_sdd_spec reports NOT-FOUND for a capability with no contract — never an empty document', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    const client = await connect(backend.port)
    const result = await client.callTool({
      name: 'get_sdd_spec',
      arguments: { project: 'nexus-mind', capability: 'never-specified' },
    })

    assert.equal(result.isError, true)
    const text = textOf(result)
    assert.match(text, /Not found/)
    assert.match(text, /NOT an empty specification/, 'the distinction must be spelled out')
    await client.close()
  } finally {
    await backend.close()
  }
})

test('get_sdd_spec demands a whole natural key', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    const client = await connect(backend.port)
    const result = await client.callTool({
      name: 'get_sdd_spec',
      arguments: { project: 'nexus-mind' },
    })

    assert.equal(result.isError, true)
    assert.match(textOf(result), /spec_id, or both project and capability/)
    await client.close()
  } finally {
    await backend.close()
  }
})

test('get_sdd_spec without sdd:read fails and leaks no content', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    backend.seed('p', 'cap', ['the secret contract'])
    backend.perms.delete('sdd:read')
    const client = await connect(backend.port)

    const result = await client.callTool({
      name: 'get_sdd_spec',
      arguments: { project: 'p', capability: 'cap' },
    })

    assert.equal(result.isError, true)
    assert.match(textOf(result), /sdd:read/)
    assert.equal(textOf(result).includes('the secret contract'), false, 'no content reaches the agent')
    await client.close()
  } finally {
    await backend.close()
  }
})

// ── list_sdd_specs ───────────────────────────────────────────────────────────

test('list_sdd_specs returns metadata only, never the contract text', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    backend.seed('nexus-mind', 'harness-library', ['SECRETCONTRACTBODY'], 'Harness Library')
    backend.seed('nexus-mind', 'policy-engine', ['ANOTHERSECRETBODY'])
    const client = await connect(backend.port)

    const result = await client.callTool({
      name: 'list_sdd_specs',
      arguments: { project: 'nexus-mind' },
    })

    assert.equal(result.isError, undefined)
    const text = textOf(result)
    assert.match(text, /2 living specification\(s\)/)
    assert.match(text, /harness-library/)
    assert.match(text, /Harness Library/)
    assert.match(text, /revision 1/)
    assert.match(text, /policy-engine/)
    assert.equal(text.includes('SECRETCONTRACTBODY'), false, 'the list must never carry content')
    assert.equal(text.includes('ANOTHERSECRETBODY'), false)
    await client.close()
  } finally {
    await backend.close()
  }
})

test('list_sdd_specs names the change that last merged into each contract', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    backend.seedChange('nexus-mind', 'sdd-specs')
    const client = await connect(backend.port)

    await client.callTool({
      name: 'save_sdd_spec',
      arguments: {
        project: 'nexus-mind',
        capability: 'cap',
        content: 'C',
        merged_from_change_name: 'sdd-specs',
      },
    })

    const result = await client.callTool({ name: 'list_sdd_specs', arguments: { project: 'nexus-mind' } })
    assert.match(textOf(result), /last merged from change "sdd-specs"/)
    await client.close()
  } finally {
    await backend.close()
  }
})

test('list_sdd_specs says so when a project has no contracts yet', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    const client = await connect(backend.port)
    const result = await client.callTool({ name: 'list_sdd_specs', arguments: { project: 'empty' } })

    assert.equal(result.isError, undefined)
    assert.match(textOf(result), /No living specifications found/)
    await client.close()
  } finally {
    await backend.close()
  }
})

test('list_sdd_specs without sdd:read fails the call', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    backend.seed('p', 'cap', ['C'])
    backend.perms.delete('sdd:read')
    const client = await connect(backend.port)

    const result = await client.callTool({ name: 'list_sdd_specs', arguments: {} })

    assert.equal(result.isError, true)
    assert.match(textOf(result), /sdd:read/)
    await client.close()
  } finally {
    await backend.close()
  }
})
