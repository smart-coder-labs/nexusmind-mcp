import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import http from 'node:http'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// Integration tests for the Phase 1 harness read tools (recommend_harnesses,
// list_harnesses, get_harness_version, list_harness_config_reviews).
//
// Runs the ACTUAL compiled MCP server (dist/index.js) as a subprocess and talks
// to it over stdio via the MCP SDK client, same approach as integration.test.ts.
// This exercises the real server.tool() registration + zod parsing, not just
// the underlying client.ts functions (already covered by harness-client.test.ts).
const DIST = resolve(process.cwd(), 'dist')
const ENTRY = join(DIST, 'index.js')
const distBuilt = existsSync(ENTRY)
const skip = distBuilt ? false : 'dist not built — run `npm run build` first'

interface FakeBackend {
  port: number
  requests: string[]
  requestBodies: Array<{ url: string; method: string; body: unknown }>
  setResponse: (status: number, body: unknown) => void
  /** Route-based responses keyed by "METHOD path" (path only, no query string). */
  setRoute: (methodAndPath: string, status: number, body: unknown) => void
  close: () => Promise<void>
}

function startFakeBackend(): Promise<FakeBackend> {
  return new Promise(resolveP => {
    const requests: string[] = []
    const requestBodies: Array<{ url: string; method: string; body: unknown }> = []
    let response: { status: number; body: unknown } = { status: 200, body: [] }
    const routes = new Map<string, { status: number; body: unknown }>()
    const server = http.createServer((req, res) => {
      const url = req.url ?? ''
      requests.push(url)
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8')
        let parsedBody: unknown = undefined
        try { parsedBody = rawBody ? JSON.parse(rawBody) : undefined } catch { parsedBody = rawBody }
        requestBodies.push({ url, method: req.method ?? 'GET', body: parsedBody })

        const pathOnly = url.split('?')[0]
        const routeKey = `${req.method} ${pathOnly}`
        const chosen = routes.get(routeKey) ?? response
        res.writeHead(chosen.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(chosen.body))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolveP({
        port,
        requests,
        requestBodies,
        setResponse: (status, body) => { response = { status, body } },
        setRoute: (methodAndPath, status, body) => { routes.set(methodAndPath, { status, body }) },
        close: () => new Promise(r => server.close(() => r())),
      })
    })
  })
}

interface ElicitResponse {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

async function withClient(
  backend: FakeBackend,
  fn: (client: Client) => Promise<void>,
  opts: {
    cwd?: string
    elicitResponse?: ElicitResponse
    /**
     * Advertises the `elicitation` capability but throws when the server
     * calls elicitInput — simulates a client that lied about support, or
     * whose elicitation handler errors. Takes precedence over
     * elicitResponse when both are set (they are mutually exclusive in
     * practice).
     */
    elicitThrows?: boolean
  } = {},
): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    cwd: opts.cwd,
    env: {
      NEXUSMIND_API_KEY: 'nm_test_key',
      NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}`,
    },
  })
  const client = new Client(
    { name: 'harness-tools-test', version: '1.0.0' },
    (opts.elicitResponse || opts.elicitThrows) ? { capabilities: { elicitation: {} } } : undefined,
  )
  if (opts.elicitThrows) {
    client.setRequestHandler(ElicitRequestSchema, async () => {
      throw new Error('simulated elicitation handler failure')
    })
  } else if (opts.elicitResponse) {
    const response = opts.elicitResponse
    client.setRequestHandler(ElicitRequestSchema, async () => response)
  }
  await client.connect(transport)
  try {
    await fn(client)
  } finally {
    await client.close()
  }
}

function sha256Of(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex')
}

function withTempCwd<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'nm-harness-install-test-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('recommend_harnesses returns metadata and never calls a download endpoint', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(200, [
    { harness_id: 'h1', version: '1.0.0', name: 'Foo Agent', targets: ['claude'], format: 'agent' },
  ])
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({ name: 'recommend_harnesses', arguments: { target: 'claude' } })
      assert.equal(result.isError, undefined)
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      assert.match(text, /Foo Agent/)
      assert.equal(backend.requests.length, 1)
      assert.match(backend.requests[0], /^\/v1\/harness-recommendations\?target=claude$/)
      assert.doesNotMatch(backend.requests[0], /download/)
    })
  } finally {
    await backend.close()
  }
})

test('list_harnesses returns catalog metadata and forwards target/owner filters', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(200, [{ id: 'h1', slug: 'foo', name: 'Foo', owner_user_id: 'u1', targets: ['cursor'] }])
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'list_harnesses',
        arguments: { target: 'cursor', owner_user_id: 'u1' },
      })
      assert.equal(result.isError, undefined)
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      assert.match(text, /foo/)
      assert.equal(backend.requests.length, 1)
      const url = new URL(`http://x${backend.requests[0]}`)
      assert.equal(url.pathname, '/v1/harnesses')
      assert.equal(url.searchParams.get('target'), 'cursor')
      assert.equal(url.searchParams.get('owner_user_id'), 'u1')
    })
  } finally {
    await backend.close()
  }
})

test('get_harness_version returns a manifest preview without writing any local file', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(200, {
    harness_id: 'h1',
    version: '1.0.0',
    format: 'agent',
    targets: ['claude'],
    manifest_hash: 'sha256:deadbeef',
    // Components live INSIDE the manifest — verified against a real GET response.
    // This fixture used to put them at the top level, which is where the formatter
    // also (wrongly) looked. The fake and the code agreed with each other, so the
    // test passed while every real version reported "Components: 0".
    manifest: {
      components: [{ path: 'agent.md', sha256: 'sha256:abc', size_bytes: 100 }],
    },
  })
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({ name: 'get_harness_version', arguments: { harness_id: 'h1', version: '1.0.0' } })
      assert.equal(result.isError, undefined)
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      assert.match(text, /sha256:deadbeef/)
      assert.match(text, /Components: 1/)
      assert.equal(backend.requests.length, 1)
      assert.equal(backend.requests[0], '/v1/harnesses/h1/versions/1.0.0')
    })
  } finally {
    await backend.close()
  }
})

test('list_harness_config_reviews denies the call and returns no data when harness:read is missing', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(403, { error: 'harness:read permission required' })
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({ name: 'list_harness_config_reviews', arguments: { status: 'pending' } })
      assert.equal(result.isError, true)
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      assert.match(text, /harness:read permission required/)
      // Confirm the tool surfaced the denial and did not fabricate/return review data.
      assert.doesNotMatch(text, /redacted_config/)
    })
  } finally {
    await backend.close()
  }
})

test('list_harness_config_reviews forwards the status filter', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(200, [{ id: 'r1', source_tool: 'claude', status: 'pending' }])
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({ name: 'list_harness_config_reviews', arguments: { status: 'pending' } })
      assert.equal(result.isError, undefined)
      assert.equal(backend.requests.length, 1)
      assert.equal(backend.requests[0], '/v1/harness-config-reviews?status=pending')
    })
  } finally {
    await backend.close()
  }
})

// ── plan_harness_install / apply_harness_install (Phase 2 install core) ──────

function agentManifest(overrides: Record<string, unknown> = {}) {
  return {
    harness_id: 'h1',
    version: '1.0.0',
    format: 'agent',
    targets: ['claude'],
    manifest_hash: 'sha256:planhash',
    manifest: {
      schema_version: '1.1',
      format: 'agent',
      targets: ['claude'],
      components: [
        { path: 'foo.md', kind: 'file', media_type: 'text/markdown', size_bytes: 5, sha256: sha256Of('hello'), content: 'hello' },
      ],
      provenance: { source: 'test' },
      security: { requires_approval: false, executable: false, secret_scan_status: 'passed' },
    },
    ...overrides,
  }
}

test('plan_harness_install returns a full diff and writes nothing to disk', { skip }, async () => {
  await withTempCwd(async cwd => {
    const backend = await startFakeBackend()
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0', 200, agentManifest())
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'plan_harness_install',
          arguments: { harness_id: 'h1', version: '1.0.0', target_tool: 'claude', target_scope: 'project' },
        })
        assert.equal(result.isError, undefined)
        const text = (result.content as Array<{ type: string; text: string }>)[0].text
        const parsed = JSON.parse(text)
        assert.equal(parsed.manifest_hash, 'sha256:planhash')
        assert.equal(parsed.diff.length, 1)
        assert.equal(parsed.diff[0].action, 'create')
        assert.match(parsed.diff[0].destination, /\.claude[/\\]agents[/\\]foo\.md$/)
        assert.equal(existsSync(join(cwd, '.claude')), false, 'plan must not write any file')
      }, { cwd })
    } finally {
      await backend.close()
    }
  })
})

test('plan_harness_install flags executable components with requires_acknowledgement', { skip }, async () => {
  await withTempCwd(async cwd => {
    const backend = await startFakeBackend()
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0', 200, agentManifest({
      format: 'hook',
      manifest: {
        schema_version: '1.1', format: 'hook', targets: ['claude'],
        components: [{ path: 'pre-commit.sh', kind: 'file', size_bytes: 3, sha256: sha256Of('run'), content: 'run', executable: true }],
        provenance: { source: 'test' },
        security: { requires_approval: true, executable: true, secret_scan_status: 'passed' },
      },
    }))
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'plan_harness_install',
          arguments: { harness_id: 'h1', version: '1.0.0', target_tool: 'claude', target_scope: 'project' },
        })
        assert.equal(result.isError, undefined)
        const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)
        assert.equal(parsed.requires_acknowledgement, true)
        assert.ok(parsed.warnings.length >= 1)
      }, { cwd })
    } finally {
      await backend.close()
    }
  })
})

test('plan_harness_install refuses an unsupported format/tool pair with no partial diff', { skip }, async () => {
  await withTempCwd(async cwd => {
    const backend = await startFakeBackend()
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0', 200, agentManifest({
      format: 'skill',
      manifest: {
        schema_version: '1.1', format: 'skill', targets: ['claude'],
        components: [{ path: 'SKILL.md', kind: 'file', size_bytes: 5, sha256: sha256Of('hello'), content: 'hello' }],
        provenance: { source: 'test' },
        security: { requires_approval: false, executable: false, secret_scan_status: 'passed' },
      },
    }))
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'plan_harness_install',
          arguments: { harness_id: 'h1', version: '1.0.0', target_tool: 'codex', target_scope: 'project' },
        })
        assert.equal(result.isError, true)
        const text = (result.content as Array<{ type: string; text: string }>)[0].text
        assert.match(text, /skill.*codex|Claude Code-only|unsupported/i)
      }, { cwd })
    } finally {
      await backend.close()
    }
  })
})

test('apply_harness_install happy path: approves, materializes, and records result', { skip }, async () => {
  await withTempCwd(async cwd => {
    const backend = await startFakeBackend()
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0/download', 200, agentManifest())
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/approval', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash',
    })
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/install-result', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash', status: 'installed',
    })
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'apply_harness_install',
          arguments: {
            harness_id: 'h1', version: '1.0.0', target_tool: 'claude', target_scope: 'project',
            manifest_hash: 'sha256:planhash',
          },
        })
        assert.notEqual(result.isError, true)
        const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)
        assert.equal(parsed.result_status, 'installed')
        assert.equal(parsed.approval_id, 'appr-1')
        assert.equal(parsed.written.length, 1)

        const writtenPath = join(cwd, '.claude', 'agents', 'foo.md')
        assert.equal(existsSync(writtenPath), true)
        assert.equal(readFileSync(writtenPath, 'utf8'), 'hello')

        const approvalCall = backend.requestBodies.find(c => c.url === '/v1/harnesses/h1/versions/1.0.0/approval')
        assert.ok(approvalCall)
        assert.equal((approvalCall!.body as any).manifest_hash, 'sha256:planhash')

        const installResultCall = backend.requestBodies.find(c => c.url === '/v1/harnesses/h1/versions/1.0.0/install-result')
        assert.ok(installResultCall)
        // Never sends raw file contents in the install-result call.
        assert.equal((installResultCall!.body as any).content, undefined)
        assert.equal((installResultCall!.body as any).written, undefined)
      }, { cwd })
    } finally {
      await backend.close()
    }
  })
})

test('apply_harness_install: folder component with kind-shaped entries materializes BOTH files with real content (end-to-end plan + apply)', { skip }, async () => {
  await withTempCwd(async cwd => {
    const skillContent = '# Reviewer skill\n'
    const helperContent = '# Helper\n'
    const folderManifest = agentManifest({
      format: 'skill',
      manifest_hash: 'sha256:folderhash',
      manifest: {
        schema_version: '1.1',
        format: 'skill',
        targets: ['claude'],
        components: [
          {
            kind: 'folder',
            path: 'skills/reviewer',
            entries: [
              {
                kind: 'file',
                path: 'skills/reviewer/SKILL.md',
                content: skillContent,
                sha256: sha256Of(skillContent),
                size_bytes: Buffer.byteLength(skillContent),
              },
              {
                kind: 'file',
                path: 'skills/reviewer/helper.md',
                content: helperContent,
                sha256: sha256Of(helperContent),
                size_bytes: Buffer.byteLength(helperContent),
              },
            ],
          },
        ],
        provenance: { source: 'test' },
        security: { requires_approval: false, executable: false, secret_scan_status: 'passed' },
      },
    })
    const backend = await startFakeBackend()
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0/download', 200, folderManifest)
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/approval', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:folderhash',
    })
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/install-result', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:folderhash', status: 'installed',
    })
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'apply_harness_install',
          arguments: {
            harness_id: 'h1', version: '1.0.0', target_tool: 'claude', target_scope: 'project',
            manifest_hash: 'sha256:folderhash',
          },
        })
        assert.notEqual(result.isError, true)
        const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)
        assert.equal(parsed.result_status, 'installed')
        assert.equal(parsed.written.length, 2, 'both folder entries must be materialized as separate files')

        const skillPath = join(cwd, '.claude', 'skills', 'skills', 'reviewer', 'SKILL.md')
        const helperPath = join(cwd, '.claude', 'skills', 'skills', 'reviewer', 'helper.md')
        assert.equal(existsSync(skillPath), true)
        assert.equal(existsSync(helperPath), true)
        assert.equal(readFileSync(skillPath, 'utf8'), skillContent)
        assert.equal(readFileSync(helperPath, 'utf8'), helperContent)
      }, { cwd })
    } finally {
      await backend.close()
    }
  })
})

test('apply_harness_install: overwrite entry without overwrite_confirmed refuses the whole apply and writes nothing', { skip }, async () => {
  await withTempCwd(async cwd => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const destDir = join(cwd, '.claude', 'agents')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'foo.md'), 'stale content that differs from the manifest')

    const backend = await startFakeBackend()
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0/download', 200, agentManifest())
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/approval', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash',
    })
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'apply_harness_install',
          arguments: {
            harness_id: 'h1', version: '1.0.0', target_tool: 'claude', target_scope: 'project',
            manifest_hash: 'sha256:planhash',
            // overwrite_confirmed intentionally omitted
          },
        })
        const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)
        assert.equal(parsed.result_status, 'overwrite_not_confirmed')
        assert.equal(parsed.written.length, 0)

        // The pre-existing file must be untouched.
        assert.equal(readFileSync(join(destDir, 'foo.md'), 'utf8'), 'stale content that differs from the manifest')

        const installResultCall = backend.requestBodies.find(c => c.url === '/v1/harnesses/h1/versions/1.0.0/install-result')
        assert.equal(installResultCall, undefined, 'must not call record_install_result when overwrite is refused')
      }, { cwd })
    } finally {
      await backend.close()
    }
  })
})

test('apply_harness_install: overwrite entry WITH overwrite_confirmed proceeds and writes the file', { skip }, async () => {
  await withTempCwd(async cwd => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const destDir = join(cwd, '.claude', 'agents')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'foo.md'), 'stale content that differs from the manifest')

    const backend = await startFakeBackend()
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0/download', 200, agentManifest())
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/approval', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash',
    })
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/install-result', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash', status: 'installed',
    })
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'apply_harness_install',
          arguments: {
            harness_id: 'h1', version: '1.0.0', target_tool: 'claude', target_scope: 'project',
            manifest_hash: 'sha256:planhash',
            overwrite_confirmed: true,
          },
        })
        assert.notEqual(result.isError, true)
        const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)
        assert.equal(parsed.result_status, 'installed')
        assert.equal(parsed.written.length, 1)
        assert.equal(parsed.written[0].action, 'overwrite')
        assert.equal(readFileSync(join(destDir, 'foo.md'), 'utf8'), 'hello')
      }, { cwd })
    } finally {
      await backend.close()
    }
  })
})

test('apply_harness_install: elicitation ACCEPT overwrites a pre-existing file without overwrite_confirmed', { skip }, async () => {
  await withTempCwd(async cwd => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const destDir = join(cwd, '.claude', 'agents')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'foo.md'), 'stale content that differs from the manifest')

    const elicitMessages: string[] = []

    const backend = await startFakeBackend()
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0', 200, agentManifest())
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0/download', 200, agentManifest())
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/approval', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash',
    })
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/install-result', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash', status: 'installed',
    })
    try {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [ENTRY],
        cwd,
        env: {
          NEXUSMIND_API_KEY: 'nm_test_key',
          NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}`,
        },
      })
      const client = new Client(
        { name: 'harness-tools-test', version: '1.0.0' },
        { capabilities: { elicitation: {} } },
      )
      client.setRequestHandler(ElicitRequestSchema, async request => {
        elicitMessages.push(request.params.message)
        return { action: 'accept', content: { confirm: true } }
      })
      await client.connect(transport)
      try {
        const result = await client.callTool({
          name: 'apply_harness_install',
          arguments: {
            harness_id: 'h1', version: '1.0.0', target_tool: 'claude', target_scope: 'project',
            manifest_hash: 'sha256:planhash',
            // overwrite_confirmed intentionally omitted — elicitation ACCEPT
            // is what must authorize the overwrite here.
          },
        })
        assert.notEqual(result.isError, true)
        const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)
        assert.equal(parsed.result_status, 'installed')
        assert.equal(parsed.written.length, 1)
        assert.equal(parsed.written[0].action, 'overwrite')

        const writtenPath = join(destDir, 'foo.md')
        assert.equal(readFileSync(writtenPath, 'utf8'), 'hello')
        assert.notEqual(readFileSync(writtenPath, 'utf8'), 'stale content that differs from the manifest')

        const installResultCall = backend.requestBodies.find(c => c.url === '/v1/harnesses/h1/versions/1.0.0/install-result')
        assert.ok(installResultCall, 'install result must be recorded after an accepted elicitation overwrite')

        assert.equal(elicitMessages.length, 1)
        assert.match(elicitMessages[0], /OVERWRITE:/)
        assert.match(elicitMessages[0], /foo\.md/)
      } finally {
        await client.close()
      }
    } finally {
      await backend.close()
    }
  })
})

test('apply_harness_install: elicitation ACCEPT confirms the install and writes the file', { skip }, async () => {
  await withTempCwd(async cwd => {
    const backend = await startFakeBackend()
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0', 200, agentManifest())
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0/download', 200, agentManifest())
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/approval', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash',
    })
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/install-result', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash', status: 'installed',
    })
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'apply_harness_install',
          arguments: {
            harness_id: 'h1', version: '1.0.0', target_tool: 'claude', target_scope: 'project',
            manifest_hash: 'sha256:planhash',
            // overwrite_confirmed/warning_acknowledged intentionally omitted —
            // elicitation ACCEPT is the confirmation.
          },
        })
        assert.notEqual(result.isError, true)
        const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)
        assert.equal(parsed.result_status, 'installed')
        assert.equal(parsed.written.length, 1)

        const writtenPath = join(cwd, '.claude', 'agents', 'foo.md')
        assert.equal(existsSync(writtenPath), true)
        assert.equal(readFileSync(writtenPath, 'utf8'), 'hello')

        const installResultCall = backend.requestBodies.find(c => c.url === '/v1/harnesses/h1/versions/1.0.0/install-result')
        assert.ok(installResultCall, 'install result must be recorded after an accepted elicitation')
      }, { cwd, elicitResponse: { action: 'accept', content: { confirm: true } } })
    } finally {
      await backend.close()
    }
  })
})

test('apply_harness_install: elicitation DECLINE aborts with zero writes and no recorded install', { skip }, async () => {
  await withTempCwd(async cwd => {
    const backend = await startFakeBackend()
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0', 200, agentManifest())
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0/download', 200, agentManifest())
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/approval', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash',
    })
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/install-result', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash', status: 'installed',
    })
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'apply_harness_install',
          arguments: {
            harness_id: 'h1', version: '1.0.0', target_tool: 'claude', target_scope: 'project',
            manifest_hash: 'sha256:planhash',
          },
        })
        const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)
        assert.equal(parsed.result_status, 'declined')
        assert.equal(parsed.written.length, 0)
        assert.match(parsed.errors[0].message, /declined/)

        assert.equal(existsSync(join(cwd, '.claude')), false, 'must not write any file when the user declines')

        const installResultCall = backend.requestBodies.find(c => c.url === '/v1/harnesses/h1/versions/1.0.0/install-result')
        assert.equal(installResultCall, undefined, 'must not record an install result when the user declines')
      }, { cwd, elicitResponse: { action: 'decline' } })
    } finally {
      await backend.close()
    }
  })
})

test('apply_harness_install: elicitation capability advertised but elicitInput throws falls back to flag-based gate — refuses without flags, zero writes', { skip }, async () => {
  await withTempCwd(async cwd => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const destDir = join(cwd, '.claude', 'agents')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'foo.md'), 'stale content that differs from the manifest')

    const backend = await startFakeBackend()
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0', 200, agentManifest())
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0/download', 200, agentManifest())
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/approval', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash',
    })
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'apply_harness_install',
          arguments: {
            harness_id: 'h1', version: '1.0.0', target_tool: 'claude', target_scope: 'project',
            manifest_hash: 'sha256:planhash',
            // overwrite_confirmed intentionally omitted — the elicitInput
            // throw must NOT silently proceed to write; it must fall back
            // to this pre-existing flag-based gate and refuse.
          },
        })
        const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)
        assert.equal(parsed.result_status, 'overwrite_not_confirmed')
        assert.equal(parsed.written.length, 0)

        // The pre-existing file must be untouched.
        assert.equal(readFileSync(join(destDir, 'foo.md'), 'utf8'), 'stale content that differs from the manifest')

        const installResultCall = backend.requestBodies.find(c => c.url === '/v1/harnesses/h1/versions/1.0.0/install-result')
        assert.equal(installResultCall, undefined, 'must not record an install result when the elicitInput throw falls back and is then refused')
      }, { cwd, elicitThrows: true })
    } finally {
      await backend.close()
    }
  })
})

test('apply_harness_install: no elicitation capability falls back to flag-based gate — succeeds with correct flags', { skip }, async () => {
  await withTempCwd(async cwd => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const destDir = join(cwd, '.claude', 'agents')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'foo.md'), 'stale content that differs from the manifest')

    const backend = await startFakeBackend()
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0', 200, agentManifest())
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0/download', 200, agentManifest())
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/approval', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash',
    })
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/install-result', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash', status: 'installed',
    })
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'apply_harness_install',
          arguments: {
            harness_id: 'h1', version: '1.0.0', target_tool: 'claude', target_scope: 'project',
            manifest_hash: 'sha256:planhash',
            overwrite_confirmed: true,
          },
        })
        assert.notEqual(result.isError, true)
        const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)
        assert.equal(parsed.result_status, 'installed')
        assert.equal(parsed.written.length, 1)
        assert.equal(readFileSync(join(destDir, 'foo.md'), 'utf8'), 'hello')
      }, { cwd })
    } finally {
      await backend.close()
    }
  })
})

test('apply_harness_install: no elicitation capability falls back to flag-based gate — refuses without flags, zero writes', { skip }, async () => {
  await withTempCwd(async cwd => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const destDir = join(cwd, '.claude', 'agents')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'foo.md'), 'stale content that differs from the manifest')

    const backend = await startFakeBackend()
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0', 200, agentManifest())
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0/download', 200, agentManifest())
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/approval', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash',
    })
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'apply_harness_install',
          arguments: {
            harness_id: 'h1', version: '1.0.0', target_tool: 'claude', target_scope: 'project',
            manifest_hash: 'sha256:planhash',
            // overwrite_confirmed intentionally omitted, no elicitation capability advertised
          },
        })
        const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)
        assert.equal(parsed.result_status, 'overwrite_not_confirmed')
        assert.equal(parsed.written.length, 0)
        assert.equal(readFileSync(join(destDir, 'foo.md'), 'utf8'), 'stale content that differs from the manifest')

        const installResultCall = backend.requestBodies.find(c => c.url === '/v1/harnesses/h1/versions/1.0.0/install-result')
        assert.equal(installResultCall, undefined, 'must not record an install result when refused')
      }, { cwd })
    } finally {
      await backend.close()
    }
  })
})

test('apply_harness_install: hash mismatch between plan and fresh download aborts with no write, no record', { skip }, async () => {
  await withTempCwd(async cwd => {
    const backend = await startFakeBackend()
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0/download', 200, agentManifest({ manifest_hash: 'sha256:driftedhash' }))
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/approval', 200, {
      approval_id: 'appr-1', harness_id: 'h1', version: '1.0.0', manifest_hash: 'sha256:planhash',
    })
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'apply_harness_install',
          arguments: {
            harness_id: 'h1', version: '1.0.0', target_tool: 'claude', target_scope: 'project',
            manifest_hash: 'sha256:planhash', // stale — drifted from the fresh download's sha256:driftedhash
          },
        })
        const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)
        assert.equal(parsed.result_status, 'hash_mismatch')
        assert.equal(existsSync(join(cwd, '.claude')), false, 'must not write any file on hash mismatch')
        const installResultCall = backend.requestBodies.find(c => c.url === '/v1/harnesses/h1/versions/1.0.0/install-result')
        assert.equal(installResultCall, undefined, 'must not call record_install_result on hash mismatch')
      }, { cwd })
    } finally {
      await backend.close()
    }
  })
})

test('apply_harness_install: executable format without warning_acknowledged refuses to write and does not record', { skip }, async () => {
  await withTempCwd(async cwd => {
    const backend = await startFakeBackend()
    const hookManifest = agentManifest({
      format: 'hook',
      manifest_hash: 'sha256:hookhash',
      manifest: {
        schema_version: '1.1', format: 'hook', targets: ['claude'],
        components: [{ path: 'pre-commit.sh', kind: 'file', size_bytes: 3, sha256: sha256Of('run'), content: 'run', executable: true }],
        provenance: { source: 'test' },
        security: { requires_approval: true, executable: true, secret_scan_status: 'passed' },
      },
    })
    backend.setRoute('GET /v1/harnesses/h1/versions/1.0.0/download', 200, hookManifest)
    backend.setRoute('POST /v1/harnesses/h1/versions/1.0.0/approval', 422, {
      error: 'warning_acknowledged metadata required for executable manifest',
    })
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'apply_harness_install',
          arguments: {
            harness_id: 'h1', version: '1.0.0', target_tool: 'claude', target_scope: 'project',
            manifest_hash: 'sha256:hookhash',
            // warning_acknowledged intentionally omitted
          },
        })
        assert.equal(result.isError, true)
        assert.equal(existsSync(join(cwd, '.claude')), false, 'must not write any file without acknowledgement')
        const installResultCall = backend.requestBodies.find(c => c.url === '/v1/harnesses/h1/versions/1.0.0/install-result')
        assert.equal(installResultCall, undefined)
      }, { cwd })
    } finally {
      await backend.close()
    }
  })
})

test('apply_harness_install: call without manifest_hash is rejected with no write and no record', { skip }, async () => {
  await withTempCwd(async cwd => {
    const backend = await startFakeBackend()
    try {
      await withClient(backend, async client => {
        // manifest_hash is a required zod field (the confirmation that a prior
        // plan_harness_install was reviewed); calling without it must be
        // rejected by schema validation before any client/backend call runs.
        const result = await client.callTool({
          name: 'apply_harness_install',
          arguments: { harness_id: 'h1', version: '1.0.0', target_tool: 'claude', target_scope: 'project' },
        })
        assert.equal(result.isError, true)
        const text = (result.content as Array<{ type: string; text: string }>)[0].text
        assert.match(text, /manifest_hash/)
        assert.equal(existsSync(join(cwd, '.claude')), false)
        assert.equal(backend.requests.length, 0)
      }, { cwd })
    } finally {
      await backend.close()
    }
  })
})

// ── build_harness_manifest_from_path / create_harness / publish_harness_version (Phase 3) ──

function withTempSourceDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'nm-harness-build-test-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('build_harness_manifest_from_path builds a valid manifest from a local agent file', { skip }, async () => {
  await withTempSourceDir(async srcDir => {
    const { writeFileSync } = await import('node:fs')
    const filePath = join(srcDir, 'reviewer.md')
    writeFileSync(filePath, '# Reviewer Agent', 'utf8')

    const backend = await startFakeBackend()
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'build_harness_manifest_from_path',
          arguments: { path: filePath, format: 'agent', targets: ['claude'], source: 'test-source' },
        })
        assert.equal(result.isError, undefined)
        const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)
        assert.equal(parsed.secret_scan_status, 'passed')
        assert.equal(parsed.component_count, 1)
        assert.equal(parsed.manifest.schema_version, '1.1')
        assert.equal(parsed.manifest.format, 'agent')
        assert.deepEqual(parsed.manifest.targets, ['claude'])
      })
    } finally {
      await backend.close()
    }
  })
})

test('build_harness_manifest_from_path accepts cursor as a target', { skip }, async () => {
  await withTempSourceDir(async srcDir => {
    const { writeFileSync } = await import('node:fs')
    const filePath = join(srcDir, 'reviewer.md')
    writeFileSync(filePath, '# Reviewer Agent', 'utf8')

    const backend = await startFakeBackend()
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'build_harness_manifest_from_path',
          arguments: { path: filePath, format: 'agent', targets: ['cursor'], source: 'test-source' },
        })
        assert.equal(result.isError, undefined)
        const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)
        assert.deepEqual(parsed.manifest.targets, ['cursor'])
      })
    } finally {
      await backend.close()
    }
  })
})

test('build_harness_manifest_from_path refuses on a secret-scan hit and returns no manifest', { skip }, async () => {
  await withTempSourceDir(async srcDir => {
    const { writeFileSync } = await import('node:fs')
    const filePath = join(srcDir, 'agent.md')
    writeFileSync(filePath, 'token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz01"', 'utf8')

    const backend = await startFakeBackend()
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'build_harness_manifest_from_path',
          arguments: { path: filePath, format: 'agent', targets: ['claude'], source: 'test-source' },
        })
        assert.equal(result.isError, true)
        const text = (result.content as Array<{ type: string; text: string }>)[0].text
        assert.match(text, /secret/i)
        assert.doesNotMatch(text, /ghp_1234567890abcdefghijklmnopqrstuvwxyz01/)
      })
    } finally {
      await backend.close()
    }
  })
})

test('build_harness_manifest_from_path refuses a file exceeding the 64KiB inline limit', { skip }, async () => {
  await withTempSourceDir(async srcDir => {
    const { writeFileSync } = await import('node:fs')
    const filePath = join(srcDir, 'huge.md')
    writeFileSync(filePath, 'a'.repeat(64 * 1024 + 1), 'utf8')

    const backend = await startFakeBackend()
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'build_harness_manifest_from_path',
          arguments: { path: filePath, format: 'agent', targets: ['claude'], source: 'test-source' },
        })
        assert.equal(result.isError, true)
        const text = (result.content as Array<{ type: string; text: string }>)[0].text
        assert.match(text, /64\s*ki?b|size|too large/i)
      })
    } finally {
      await backend.close()
    }
  })
})

test('create_harness and publish_harness_version deny calls when harness:write is absent', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(403, { error: 'harness:write permission required' })
  try {
    await withClient(backend, async client => {
      const createResult = await client.callTool({
        name: 'create_harness',
        arguments: { slug: 'foo', name: 'Foo' },
      })
      assert.equal(createResult.isError, true)
      assert.match((createResult.content as Array<{ type: string; text: string }>)[0].text, /harness:write permission required/)

      const publishResult = await client.callTool({
        name: 'publish_harness_version',
        arguments: { harness_id: 'h1', version: '1.0.0', manifest: { schema_version: '1.1' } },
      })
      assert.equal(publishResult.isError, true)
      assert.match((publishResult.content as Array<{ type: string; text: string }>)[0].text, /harness:write permission required/)
    })
  } finally {
    await backend.close()
  }
})

test('create_harness wraps createHarness and returns the harness id', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setRoute('POST /v1/harnesses', 200, { id: 'h1', slug: 'foo', owner_user_id: 'u1' })
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'create_harness',
        arguments: { slug: 'foo', name: 'Foo' },
      })
      assert.equal(result.isError, undefined)
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      assert.match(text, /h1/)
      const call = backend.requestBodies.find(c => c.url === '/v1/harnesses')
      assert.ok(call)
      assert.equal((call!.body as any).slug, 'foo')
    })
  } finally {
    await backend.close()
  }
})

test('publish_harness_version wraps publishHarnessVersion accepting a manifest from build_harness_manifest_from_path', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setRoute('POST /v1/harnesses/h1/versions', 200, { id: 'h1', version: '1.0.0', manifest_hash: 'sha256:built' })
  try {
    await withClient(backend, async client => {
      const manifest = {
        schema_version: '1.1', format: 'agent', targets: ['claude'],
        components: [{ kind: 'file', path: 'agent.md', media_type: 'text/markdown', size_bytes: 5, sha256: sha256Of('hello'), content: 'hello' }],
        provenance: { source: 'test' },
        security: { requires_approval: true, secret_scan_status: 'passed' },
      }
      const result = await client.callTool({
        name: 'publish_harness_version',
        arguments: { harness_id: 'h1', version: '1.0.0', manifest },
      })
      assert.equal(result.isError, undefined)
      const text = (result.content as Array<{ type: string; text: string }>)[0].text
      assert.match(text, /sha256:built/)
      const call = backend.requestBodies.find(c => c.url === '/v1/harnesses/h1/versions')
      assert.ok(call)
      assert.deepEqual((call!.body as any).manifest, manifest)
    })
  } finally {
    await backend.close()
  }
})

// ── create_harness_config_review (Phase 4, optional) ─────────────────────────

test('create_harness_config_review redacts a local config before upload', { skip }, async () => {
  await withTempSourceDir(async srcDir => {
    const { writeFileSync } = await import('node:fs')
    const configPath = join(srcDir, 'claude-config.json')
    writeFileSync(configPath, JSON.stringify({ model: 'claude', api_key: 'sk-abc123def456ghi789jkl012mno345pqr678stu901' }), 'utf8')

    const backend = await startFakeBackend()
    backend.setRoute('POST /v1/harness-config-reviews', 200, { id: 'r1', source_tool: 'claude', status: 'pending' })
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'create_harness_config_review',
          arguments: { source_tool: 'claude', config_path: configPath },
        })
        assert.equal(result.isError, undefined)
        const text = (result.content as Array<{ type: string; text: string }>)[0].text
        assert.doesNotMatch(text, /sk-abc123def456ghi789jkl012mno345pqr678stu901/)

        const call = backend.requestBodies.find(c => c.url === '/v1/harness-config-reviews')
        assert.ok(call)
        const sentBody = JSON.stringify(call!.body)
        assert.doesNotMatch(sentBody, /sk-abc123def456ghi789jkl012mno345pqr678stu901/)
        assert.ok((call!.body as any).redaction_report)
        assert.ok((call!.body as any).content_hash)
      })
    } finally {
      await backend.close()
    }
  })
})

test('create_harness_config_review still enforces raw-content rejection at the backend', { skip }, async () => {
  await withTempSourceDir(async srcDir => {
    const { writeFileSync } = await import('node:fs')
    const configPath = join(srcDir, 'claude-config.json')
    writeFileSync(configPath, JSON.stringify({ model: 'claude' }), 'utf8')

    const backend = await startFakeBackend()
    backend.setRoute('POST /v1/harness-config-reviews', 422, { error: 'unredacted secret indicators detected' })
    try {
      await withClient(backend, async client => {
        const result = await client.callTool({
          name: 'create_harness_config_review',
          arguments: { source_tool: 'claude', config_path: configPath },
        })
        assert.equal(result.isError, true)
        assert.match((result.content as Array<{ type: string; text: string }>)[0].text, /unredacted secret indicators detected/)
      })
    } finally {
      await backend.close()
    }
  })
})
