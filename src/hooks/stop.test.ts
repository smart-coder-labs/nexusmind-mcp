import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK_SCRIPT = join(__dirname, 'stop.ts')
// Run the hook through node's tsx loader (process.execPath + --import tsx)
// rather than the node_modules/.bin/tsx shim: that shim has no extension and is
// not directly spawnable on Windows (spawn ENOENT), which would break CI there.

interface FakeBackend {
  port: number
  requests: string[]
  close: () => Promise<void>
}

// Fake NexusMind backend — records every request path so tests can assert on
// call count instead of mocking client.ts internals. Running the real
// compiled hook script as a subprocess exercises the exact code path Codex
// invokes, including the process.exit() calls in exitClean().
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
    const child = spawn(process.execPath, ['--import', 'tsx', HOOK_SCRIPT], {
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

function userEntry(text: string) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
}

function assistantTextEntry(text: string) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } }
}

function assistantStoreMemoryEntry() {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__nexusmind__store_memory', input: {} }] } }
}

function writeTranscript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-transcript-'))
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}

function tempCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'nexusmind-cache-'))
}

test('Stop gate blocks when the turn looks decision-like and nothing was saved', async () => {
  const backend = await startFakeBackend()
  const cacheDir = tempCacheDir()
  const transcript = writeTranscript([
    userEntry('please fix the bug'),
    assistantTextEntry('I fixed the bug — root cause was a stale cache entry.'),
  ])
  try {
    const result = await runHook(
      { session_id: 'sess-1', transcript_path: transcript, cwd: '/tmp', hook_event_name: 'Stop' },
      {
        NEXUSMIND_API_KEY: 'nm_test_key',
        NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}`,
        XDG_CACHE_HOME: cacheDir,
      },
    )
    assert.equal(result.code, 0)
    const parsed = JSON.parse(result.stdout.trim())
    assert.equal(parsed.decision, 'block')
    assert.match(parsed.reason, /NexusMind gate/)
    assert.equal(backend.requests.length, 0, 'the gate must not itself call store_memory')
  } finally {
    await backend.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('Stop gate does not block when a store_memory call already happened this turn', async () => {
  const backend = await startFakeBackend()
  const cacheDir = tempCacheDir()
  const transcript = writeTranscript([
    userEntry('please fix the bug'),
    assistantTextEntry('I fixed the bug — root cause was a stale cache entry.'),
    assistantStoreMemoryEntry(),
  ])
  try {
    const result = await runHook(
      { session_id: 'sess-2', transcript_path: transcript, cwd: '/tmp', hook_event_name: 'Stop' },
      {
        NEXUSMIND_API_KEY: 'nm_test_key',
        NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}`,
        XDG_CACHE_HOME: cacheDir,
      },
    )
    assert.equal(result.code, 0)
    assert.equal(result.stdout.trim(), '')
  } finally {
    await backend.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('Stop gate fires at most once per session', async () => {
  const backend = await startFakeBackend()
  const cacheDir = tempCacheDir()
  const transcript = writeTranscript([
    userEntry('please fix the bug'),
    assistantTextEntry('I fixed the bug — root cause was a stale cache entry.'),
  ])
  const env = {
    NEXUSMIND_API_KEY: 'nm_test_key',
    NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}`,
    XDG_CACHE_HOME: cacheDir,
  }
  try {
    const first = await runHook({ session_id: 'sess-3', transcript_path: transcript, cwd: '/tmp', hook_event_name: 'Stop' }, env)
    const second = await runHook({ session_id: 'sess-3', transcript_path: transcript, cwd: '/tmp', hook_event_name: 'Stop' }, env)
    assert.equal(JSON.parse(first.stdout.trim()).decision, 'block')
    assert.equal(second.stdout.trim(), '', 'second Stop in the same session must not block again')
  } finally {
    await backend.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('Stop gate anti-loop: stop_hook_active suppresses the block', async () => {
  const backend = await startFakeBackend()
  const cacheDir = tempCacheDir()
  const transcript = writeTranscript([
    userEntry('please fix the bug'),
    assistantTextEntry('I fixed the bug — root cause was a stale cache entry.'),
  ])
  try {
    const result = await runHook(
      { session_id: 'sess-4', transcript_path: transcript, cwd: '/tmp', hook_event_name: 'Stop', stop_hook_active: true },
      {
        NEXUSMIND_API_KEY: 'nm_test_key',
        NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}`,
        XDG_CACHE_HOME: cacheDir,
      },
    )
    assert.equal(result.stdout.trim(), '')
  } finally {
    await backend.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('SubagentStop still does quality-gated passive capture (unaffected by the Stop gate rewrite)', async () => {
  const backend = await startFakeBackend()
  const cacheDir = tempCacheDir()
  try {
    const decisionLike = 'x'.repeat(100) + ' fixed a bug and documented the decision.'
    const result = await runHook(
      { hook_event_name: 'SubagentStop', last_assistant_message: decisionLike, cwd: '/tmp' },
      {
        NEXUSMIND_API_KEY: 'nm_test_key',
        NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}`,
        XDG_CACHE_HOME: cacheDir,
      },
    )
    assert.equal(result.code, 0)
    assert.equal(backend.requests.length, 1)
    assert.match(backend.requests[0], /\/v1\/memory\/store/)
  } finally {
    await backend.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
})
