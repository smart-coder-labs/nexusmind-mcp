import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK_SCRIPT = join(__dirname, 'pre-compact.ts')
// Run the hook through node's tsx loader (process.execPath + --import tsx)
// rather than the node_modules/.bin/tsx shim: that shim has no extension and is
// not directly spawnable on Windows (spawn ENOENT), which would break CI there.

interface FakeBackend {
  port: number
  requests: Array<{ url: string; body: string }>
  close: () => Promise<void>
}

function startFakeBackend(): Promise<FakeBackend> {
  return new Promise(resolve => {
    const requests: Array<{ url: string; body: string }> = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"id":"mem_1"}')
      })
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

function assistantTextEntry(text: string) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } }
}

function writeTranscript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-transcript-'))
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}

test('stores a session_summary with a session-scoped topic_key when there is enough recent content', async () => {
  const backend = await startFakeBackend()
  const transcript = writeTranscript([
    assistantTextEntry('a'.repeat(150)),
  ])
  try {
    const result = await runHook(
      { session_id: 'sess-precompact-1', transcript_path: transcript, cwd: '/tmp' },
      { NEXUSMIND_API_KEY: 'nm_test_key', NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}` },
    )
    assert.equal(result.code, 0)
    assert.equal(backend.requests.length, 1)
    assert.match(backend.requests[0].url, /\/v1\/memory\/store/)
    const body = JSON.parse(backend.requests[0].body)
    assert.equal(body.type, 'session_summary')
    assert.equal(body.topic_key, 'session-snapshot/sess-precompact-1')
    assert.match(body.content, /Pre-compaction snapshot/)
  } finally {
    await backend.close()
  }
})

test('skips silently when the extracted transcript content is below the 100-char floor', async () => {
  const backend = await startFakeBackend()
  const transcript = writeTranscript([assistantTextEntry('too short')])
  try {
    const result = await runHook(
      { session_id: 'sess-precompact-2', transcript_path: transcript, cwd: '/tmp' },
      { NEXUSMIND_API_KEY: 'nm_test_key', NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}` },
    )
    assert.equal(result.code, 0)
    assert.equal(backend.requests.length, 0)
  } finally {
    await backend.close()
  }
})

test('no-ops without NEXUSMIND_API_KEY', async () => {
  const backend = await startFakeBackend()
  const transcript = writeTranscript([assistantTextEntry('a'.repeat(150))])
  try {
    const result = await runHook(
      { session_id: 'sess-precompact-3', transcript_path: transcript, cwd: '/tmp' },
      { NEXUSMIND_API_KEY: '', NEXUSMIND_BASE_URL: `http://127.0.0.1:${backend.port}` },
    )
    assert.equal(result.code, 0)
    assert.equal(backend.requests.length, 0)
  } finally {
    await backend.close()
  }
})
