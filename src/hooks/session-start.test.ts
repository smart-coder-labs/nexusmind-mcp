import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK_SCRIPT = join(__dirname, 'session-start.ts')
// Run the hook through node's tsx loader (process.execPath + --import tsx)
// rather than the node_modules/.bin/tsx shim: that shim has no extension and is
// not directly spawnable on Windows (spawn ENOENT), which would break CI there.

interface FakeBackend {
  port: number
  requests: string[]
  close: () => Promise<void>
  /** Route-based JSON responses keyed by path (no query string). */
  setRoute: (path: string, status: number, body: unknown) => void
}

function startFakeBackend(): Promise<FakeBackend> {
  return new Promise(resolve => {
    const requests: string[] = []
    const routes = new Map<string, { status: number; body: unknown }>()
    const server = http.createServer((req, res) => {
      const url = req.url ?? ''
      requests.push(url)
      if (url === '/v1/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"status":"ok"}')
        return
      }
      const pathOnly = url.split('?')[0]
      const chosen = routes.get(pathOnly) ?? { status: 200, body: [] }
      res.writeHead(chosen.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(chosen.body))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        port,
        requests,
        close: () => new Promise(r => server.close(() => r())),
        setRoute: (path, status, body) => { routes.set(path, { status, body }) },
      })
    })
  })
}

function runHook(payload: unknown, env: NodeJS.ProcessEnv): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', HOOK_SCRIPT], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', d => { stdout += d })
    child.on('error', reject)
    child.on('close', code => resolveP({ stdout, code }))
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

function parseAdditionalContext(stdout: string): string {
  const parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '{}')
  return parsed.hookSpecificOutput?.additionalContext ?? ''
}

test('injects a pending-task reminder line when the caller has pending tasks in the active project', async () => {
  const backend = await startFakeBackend()
  backend.setRoute('/v1/memory', 200, [])
  backend.setRoute('/v1/tasks', 200, [
    { id: 't1', project: 'acme', title: 'Fix bug', status: 'in_progress', due_date: '2026-08-01' },
    { id: 't2', project: 'acme', title: 'Write tests', status: 'todo', due_date: null },
    { id: 't3', project: 'acme', title: 'Old done task', status: 'done' },
  ])
  try {
    const result = await runHook(
      { cwd: '/tmp' },
      { NEXUSMIND_API_KEY: 'nm_test_key', NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}` },
    )
    assert.equal(result.code, 0)
    const context = parseAdditionalContext(result.stdout)
    assert.match(context, /You have 2 pending task\(s\) in/)
    assert.match(context, /Fix bug \[in_progress\] \(due 2026-08-01\)/)
    assert.match(context, /Write tests \[todo\] \(due —\)/)
    assert.doesNotMatch(context, /Old done task/)
    const taskRequest = backend.requests.find(r => r.startsWith('/v1/tasks'))
    assert.ok(taskRequest, 'expected a request to /v1/tasks')
    const url = new URL(`http://x${taskRequest}`)
    assert.equal(url.searchParams.get('assignee'), 'me')
  } finally {
    await backend.close()
  }
})

test('excludes done and cancelled tasks from the pending count', async () => {
  const backend = await startFakeBackend()
  backend.setRoute('/v1/memory', 200, [])
  backend.setRoute('/v1/tasks', 200, [
    { id: 't1', project: 'acme', title: 'Done task', status: 'done' },
    { id: 't2', project: 'acme', title: 'Cancelled task', status: 'cancelled' },
    { id: 't3', project: 'acme', title: 'In progress task', status: 'in_progress' },
  ])
  try {
    const result = await runHook(
      { cwd: '/tmp' },
      { NEXUSMIND_API_KEY: 'nm_test_key', NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}` },
    )
    assert.equal(result.code, 0)
    const context = parseAdditionalContext(result.stdout)
    assert.match(context, /You have 1 pending task\(s\) in/)
    assert.match(context, /In progress task/)
    assert.doesNotMatch(context, /Done task/)
    assert.doesNotMatch(context, /Cancelled task/)
  } finally {
    await backend.close()
  }
})

test('omits the pending-task block when there are zero pending tasks', async () => {
  const backend = await startFakeBackend()
  backend.setRoute('/v1/memory', 200, [])
  backend.setRoute('/v1/tasks', 200, [])
  try {
    const result = await runHook(
      { cwd: '/tmp' },
      { NEXUSMIND_API_KEY: 'nm_test_key', NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}` },
    )
    assert.equal(result.code, 0)
    const context = parseAdditionalContext(result.stdout)
    assert.doesNotMatch(context, /Pending Tasks/)
    assert.doesNotMatch(context, /pending task/)
  } finally {
    await backend.close()
  }
})

test('session still starts successfully and omits the reminder when the tasks endpoint errors', async () => {
  const backend = await startFakeBackend()
  backend.setRoute('/v1/memory', 200, [])
  backend.setRoute('/v1/tasks', 500, { error: 'internal error' })
  try {
    const result = await runHook(
      { cwd: '/tmp' },
      { NEXUSMIND_API_KEY: 'nm_test_key', NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}` },
    )
    assert.equal(result.code, 0)
    const context = parseAdditionalContext(result.stdout)
    assert.doesNotMatch(context, /Pending Tasks/)
    assert.match(context, /NexusMind — Memory Protocol/)
  } finally {
    await backend.close()
  }
})
