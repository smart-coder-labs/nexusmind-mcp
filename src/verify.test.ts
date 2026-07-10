import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { verifyCredentials, maskKey } from './verify.js'

// A fake backend that mimics POST /v1/memory/search: 200 for the "good" key,
// 401 otherwise — the same 200/401 split the real client relies on.
function startBackend(goodKey: string): Promise<{ url: string; close: () => Promise<void>; hits: string[] }> {
  const hits: string[] = []
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '')
      const auth = req.headers['authorization'] ?? ''
      if (auth === `Bearer ${goodKey}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"memories":[],"total":0}')
      } else {
        res.writeHead(401)
        res.end('{"error":"unauthorized"}')
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(() => r())), hits })
    })
  })
}

test('verifyCredentials returns ok for a valid key', async () => {
  const backend = await startBackend('nm_good')
  try {
    const r = await verifyCredentials('nm_good', backend.url)
    assert.equal(r.ok, true)
    assert.deepEqual(backend.hits, ['/v1/memory/search'])
  } finally {
    await backend.close()
  }
})

test('verifyCredentials reports unauthorized for a wrong key', async () => {
  const backend = await startBackend('nm_good')
  try {
    const r = await verifyCredentials('nm_wrong', backend.url)
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'unauthorized')
    assert.equal(r.status, 401)
  } finally {
    await backend.close()
  }
})

test('verifyCredentials tolerates a trailing slash on the base URL', async () => {
  const backend = await startBackend('nm_good')
  try {
    const r = await verifyCredentials('nm_good', backend.url + '/')
    assert.equal(r.ok, true)
    assert.deepEqual(backend.hits, ['/v1/memory/search'])
  } finally {
    await backend.close()
  }
})

test('verifyCredentials reports missing key/url without a network call', async () => {
  const noKey = await verifyCredentials('', 'http://127.0.0.1:1')
  assert.equal(noKey.ok === false && noKey.reason, 'missing-key')
  const noUrl = await verifyCredentials('nm_x', '')
  assert.equal(noUrl.ok === false && noUrl.reason, 'missing-url')
})

test('verifyCredentials reports unreachable when the backend is down', async () => {
  // Port 1 is not listening — connection refused.
  const r = await verifyCredentials('nm_x', 'http://127.0.0.1:1')
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.reason, 'unreachable')
})

test('maskKey hides the middle and handles short/empty input', () => {
  assert.equal(maskKey('nm_1234567890abcd'), 'nm_123…abcd')
  assert.equal(maskKey('short'), '***')
  assert.equal(maskKey(''), '(unset)')
})
