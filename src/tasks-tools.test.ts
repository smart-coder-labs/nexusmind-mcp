import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import http from 'node:http'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Integration tests for the task MCP tools (design.md §5, spec team-tasks-agent-tools).
// Runs the ACTUAL compiled MCP server (dist/index.js) as a subprocess and talks
// to it over stdio via the MCP SDK client — same approach as harness-tools.test.ts.
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
        if (chosen.status === 204) { res.end(); return }
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

async function withClient(backend: FakeBackend, fn: (client: Client) => Promise<void>): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      NEXUSMIND_API_KEY: 'nm_test_key',
      NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}`,
    },
  })
  const client = new Client({ name: 'tasks-tools-test', version: '1.0.0' })
  await client.connect(transport)
  try {
    await fn(client)
  } finally {
    await client.close()
  }
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text
}

test('list_my_tasks calls GET /v1/tasks?assignee=me and forwards project/status', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(200, [{ id: 't1', project: 'acme', title: 'Fix bug', status: 'todo' }])
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'list_my_tasks',
        arguments: { project: 'acme', status: 'todo' },
      })
      assert.equal(result.isError, undefined)
      assert.match(textOf(result), /Fix bug/)
      assert.equal(backend.requests.length, 1)
      const url = new URL(`http://x${backend.requests[0]}`)
      assert.equal(url.pathname, '/v1/tasks')
      assert.equal(url.searchParams.get('assignee'), 'me')
      assert.equal(url.searchParams.get('project'), 'acme')
      assert.equal(url.searchParams.get('status'), 'todo')
    })
  } finally {
    await backend.close()
  }
})

test('list_tasks forwards general filters', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(200, [])
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'list_tasks',
        arguments: { project: 'acme', status: 'in_progress', sprint: 's1', label: 'bug', limit: 10 },
      })
      assert.equal(result.isError, undefined)
      const url = new URL(`http://x${backend.requests[0]}`)
      assert.equal(url.searchParams.get('project'), 'acme')
      assert.equal(url.searchParams.get('status'), 'in_progress')
      assert.equal(url.searchParams.get('sprint'), 's1')
      assert.equal(url.searchParams.get('label'), 'bug')
      assert.equal(url.searchParams.get('limit'), '10')
    })
  } finally {
    await backend.close()
  }
})

test('get_task returns hydrated task detail', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(200, { id: 't1', project: 'acme', title: 'Fix bug', status: 'todo', assignees: [], labels: [] })
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({ name: 'get_task', arguments: { task_id: 't1' } })
      assert.equal(result.isError, undefined)
      assert.match(textOf(result), /Fix bug/)
      assert.equal(backend.requests[0], '/v1/tasks/t1')
    })
  } finally {
    await backend.close()
  }
})

test('create_task enforces task:write and no task is created when denied', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(403, { error: 'task:write permission required' })
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'create_task',
        arguments: { project: 'acme', title: 'New task' },
      })
      assert.equal(result.isError, true)
      assert.match(textOf(result), /task:write permission required/)
    })
  } finally {
    await backend.close()
  }
})

test('create_task calls POST /v1/tasks and returns confirmation', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(201, { id: 't1', project: 'acme', title: 'New task', status: 'backlog' })
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'create_task',
        arguments: { project: 'acme', title: 'New task', priority: 'high' },
      })
      assert.equal(result.isError, undefined)
      assert.match(textOf(result), /New task/)
      assert.equal(backend.requestBodies[0].method, 'POST')
      assert.deepEqual(backend.requestBodies[0].body, { project: 'acme', title: 'New task', priority: 'high' })
    })
  } finally {
    await backend.close()
  }
})

test('update_task calls PATCH and returns a formatted confirmation reflecting the new status', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(200, { id: 't1', project: 'acme', title: 'Fix bug', status: 'in_progress' })
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'update_task',
        arguments: { task_id: 't1', status: 'in_progress' },
      })
      assert.equal(result.isError, undefined)
      assert.match(textOf(result), /in_progress/)
      assert.equal(backend.requestBodies[0].method, 'PATCH')
      assert.deepEqual(backend.requestBodies[0].body, { status: 'in_progress' })
    })
  } finally {
    await backend.close()
  }
})

test('delete_task without confirm makes no backend call and refuses', { skip }, async () => {
  const backend = await startFakeBackend()
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({ name: 'delete_task', arguments: { task_id: 't1' } })
      assert.equal(result.isError, true)
      assert.match(textOf(result), /confirm/i)
      assert.equal(backend.requests.length, 0)
    })
  } finally {
    await backend.close()
  }
})

test('delete_task with confirm true proceeds and soft-deletes', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(204, undefined)
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({ name: 'delete_task', arguments: { task_id: 't1', confirm: true } })
      assert.equal(result.isError, undefined)
      assert.equal(backend.requestBodies[0].method, 'DELETE')
      assert.equal(backend.requests[0], '/v1/tasks/t1')
    })
  } finally {
    await backend.close()
  }
})

test('assign_task enforces task:assign and creates no assignee record when denied', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(403, { error: 'task:assign permission required' })
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'assign_task',
        arguments: { task_id: 't1', user_ids: ['u1'] },
      })
      assert.equal(result.isError, true)
      assert.match(textOf(result), /task:assign permission required/)
    })
  } finally {
    await backend.close()
  }
})

test('assign_task calls POST /v1/tasks/:id/assignees on success', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(200, [{ id: 'u1', name: 'Sarah Chen' }])
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'assign_task',
        arguments: { task_id: 't1', user_ids: ['u1'] },
      })
      assert.equal(result.isError, undefined)
      assert.match(textOf(result), /Sarah Chen/)
      assert.deepEqual(backend.requestBodies[0].body, { user_ids: ['u1'] })
    })
  } finally {
    await backend.close()
  }
})

test('add_task_comment calls POST /v1/tasks/:id/comments', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(201, { id: 'c1', task_id: 't1', user_id: 'u1', body: 'looks good' })
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'add_task_comment',
        arguments: { task_id: 't1', body: 'looks good' },
      })
      assert.equal(result.isError, undefined)
      assert.match(textOf(result), /looks good/)
    })
  } finally {
    await backend.close()
  }
})

test('link_task_spec calls POST /v1/tasks/:id/spec-links', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(201, {})
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'link_task_spec',
        arguments: { task_id: 't1', spec_change_name: 'team-tasks' },
      })
      assert.equal(result.isError, undefined)
      assert.deepEqual(backend.requestBodies[0].body, { spec_change_name: 'team-tasks' })
    })
  } finally {
    await backend.close()
  }
})

test('resolve_tasks_for_spec reports transition count', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(200, { resolved: ['t1', 't2'] })
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'resolve_tasks_for_spec',
        arguments: { spec_change_name: 'team-tasks' },
      })
      assert.equal(result.isError, undefined)
      assert.match(textOf(result), /2 task/)
      assert.deepEqual(backend.requestBodies[0].body, { spec_change_name: 'team-tasks' })
    })
  } finally {
    await backend.close()
  }
})

test('create_sprint_retrospective persists a real retrospective via POST /v1/sprints/:id/retrospectives', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(201, { id: 'r1', sprint_id: 's1', went_well: 'shipped fast' })
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'create_sprint_retrospective',
        arguments: { sprint_id: 's1', went_well: 'shipped fast' },
      })
      assert.equal(result.isError, undefined)
      assert.equal(backend.requestBodies[0].method, 'POST')
      assert.equal(backend.requests[0], '/v1/sprints/s1/retrospectives')
      assert.deepEqual(backend.requestBodies[0].body, { went_well: 'shipped fast' })
      assert.match(textOf(result), /shipped fast/)
    })
  } finally {
    await backend.close()
  }
})

test('list_sprints forwards project/status filters', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(200, [{ id: 's1', project: 'acme', name: 'Sprint 42', status: 'active' }])
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'list_sprints',
        arguments: { project: 'acme', status: 'active' },
      })
      assert.equal(result.isError, undefined)
      assert.match(textOf(result), /Sprint 42/)
      const url = new URL(`http://x${backend.requests[0]}`)
      assert.equal(url.searchParams.get('project'), 'acme')
      assert.equal(url.searchParams.get('status'), 'active')
    })
  } finally {
    await backend.close()
  }
})

test('create_sprint calls POST /v1/sprints', { skip }, async () => {
  const backend = await startFakeBackend()
  backend.setResponse(201, { id: 's1', project: 'acme', name: 'Sprint 42', status: 'planned' })
  try {
    await withClient(backend, async client => {
      const result = await client.callTool({
        name: 'create_sprint',
        arguments: { project: 'acme', name: 'Sprint 42' },
      })
      assert.equal(result.isError, undefined)
      assert.match(textOf(result), /Sprint 42/)
    })
  } finally {
    await backend.close()
  }
})
