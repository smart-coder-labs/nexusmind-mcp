import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK_SCRIPT = join(__dirname, 'user-prompt-submit.ts')
const TSX_BIN = join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx')

interface FakeBackend {
  port: number
  requests: string[]
  close: () => Promise<void>
}

// Fake NexusMind backend — records every request path it receives so tests
// can assert on call count instead of mocking client.ts internals. Running
// the real compiled hook script as a subprocess exercises the exact code
// path Codex invokes, including the process.exit() calls in exitClean().
function startFakeBackend(): Promise<FakeBackend> {
  return new Promise(resolve => {
    const requests: string[] = []
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? '')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('[]')
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ port, requests, close: () => new Promise(r => server.close(() => r())) })
    })
  })
}

function runHook(payload: unknown, env: NodeJS.ProcessEnv): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [HOOK_SCRIPT], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', d => { stdout += d })
    child.on('error', reject)
    child.on('close', code => resolve({ stdout, code }))
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

test('full mode makes exactly ONE listMemories fetch (project-scoped), not two', async () => {
  const backend = await startFakeBackend()
  try {
    const result = await runHook({ prompt: 'hola', cwd: '/tmp' }, {
      NEXUSMIND_API_KEY: 'nm_test_key',
      NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}`,
      NEXUSMIND_PROMPT_INJECT: 'full',
    })
    assert.equal(result.code, 0)
    assert.equal(backend.requests.length, 1, `expected exactly 1 request, got: ${JSON.stringify(backend.requests)}`)
    assert.match(backend.requests[0], /^\/v1\/memory\?.*project=/, 'the single request must be project-scoped')
    assert.match(result.stdout, /At most 1-2 memory searches per task/, 'bounded search rule must be injected')
    assert.doesNotMatch(result.stdout, /### 1\) Recent session memories/, 'recent-global block must be removed')
  } finally {
    await backend.close()
  }
})

test('minimal mode with a recall-intent prompt still makes exactly ONE fetch (unchanged)', async () => {
  const backend = await startFakeBackend()
  try {
    const result = await runHook({ prompt: 'remember what we decided', cwd: '/tmp' }, {
      NEXUSMIND_API_KEY: 'nm_test_key',
      NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}`,
      NEXUSMIND_PROMPT_INJECT: 'minimal',
    })
    assert.equal(result.code, 0)
    assert.equal(backend.requests.length, 1, `expected exactly 1 request, got: ${JSON.stringify(backend.requests)}`)
  } finally {
    await backend.close()
  }
})

test('minimal mode with a non-recall prompt makes ZERO fetches', async () => {
  const backend = await startFakeBackend()
  try {
    const result = await runHook({ prompt: 'implement the login form', cwd: '/tmp' }, {
      NEXUSMIND_API_KEY: 'nm_test_key',
      NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}`,
      NEXUSMIND_PROMPT_INJECT: 'minimal',
    })
    assert.equal(result.code, 0)
    assert.equal(backend.requests.length, 0)
  } finally {
    await backend.close()
  }
})
