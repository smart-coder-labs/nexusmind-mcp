import { test } from 'node:test'
import assert from 'node:assert/strict'

import { scanForSecrets } from './secret-scan.js'

// Regex-based local secret scanner (design.md §6). Runs on every file's
// content before inlining into a manifest. Findings never include the
// matched secret value — only category + file name — so a refusal message
// can never leak the secret itself.

test('scanForSecrets detects an OpenAI-style sk- API key', () => {
  const findings = scanForSecrets('file.txt', 'const key = "sk-abc123def456ghi789jkl012mno345pqr678stu901"')
  assert.ok(findings.length >= 1)
  assert.equal(findings[0].file, 'file.txt')
  assert.match(findings[0].category, /api[- ]?key|token/i)
  assert.doesNotMatch(JSON.stringify(findings), /sk-abc123def456ghi789jkl012mno345pqr678stu901/)
})

test('scanForSecrets detects a NexusMind-style nm_ key', () => {
  const findings = scanForSecrets('config.md', 'NEXUSMIND_API_KEY=nm_live_abcdefghijklmnopqrstuvwxyz0123456789')
  assert.ok(findings.length >= 1)
})

test('scanForSecrets detects a GitHub personal access token (ghp_)', () => {
  const findings = scanForSecrets('notes.md', 'token: ghp_1234567890abcdefghijklmnopqrstuvwxyz01')
  assert.ok(findings.length >= 1)
})

test('scanForSecrets detects an AWS access key ID (AKIA...)', () => {
  const findings = scanForSecrets('deploy.sh', 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')
  assert.ok(findings.length >= 1)
  assert.match(findings.map(f => f.category).join(' '), /aws/i)
})

test('scanForSecrets detects a PEM private key block', () => {
  const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----'
  const findings = scanForSecrets('id_rsa.txt', content)
  assert.ok(findings.length >= 1)
  assert.match(findings.map(f => f.category).join(' '), /private[- ]?key/i)
})

test('scanForSecrets detects a .env-style SECRET/PASSWORD/TOKEN assignment', () => {
  const findings = scanForSecrets('.env.example', 'DB_PASSWORD=supersecretvalue123')
  assert.ok(findings.length >= 1)
})

test('scanForSecrets detects a generic bearer token', () => {
  const findings = scanForSecrets('curl.sh', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH')
  assert.ok(findings.length >= 1)
})

test('scanForSecrets detects local absolute-path leakage (/Users/...)', () => {
  const findings = scanForSecrets('notes.md', 'See /Users/alice/.ssh/id_rsa for the key file')
  assert.ok(findings.length >= 1)
  assert.match(findings.map(f => f.category).join(' '), /path/i)
})

test('scanForSecrets returns no findings for clean content', () => {
  const findings = scanForSecrets('README.md', '# Hello\n\nThis is a normal markdown file with no secrets.\n')
  assert.deepEqual(findings, [])
})

test('scanForSecrets never includes the matched secret value in a finding', () => {
  const secret = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz01'
  const findings = scanForSecrets('leak.md', `token = "${secret}"`)
  assert.ok(findings.length >= 1)
  for (const f of findings) {
    assert.doesNotMatch(JSON.stringify(f), new RegExp(secret))
  }
})
