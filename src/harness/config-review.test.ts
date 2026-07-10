import { test } from 'node:test'
import assert from 'node:assert/strict'

import { redactConfigForReview } from './config-review.js'

// Local redaction/preview helper backing create_harness_config_review
// (design.md §3 create_harness_config_review; harness-config-review spec:
// "Agent-session config review requires local preview before upload").
// Reuses harness/secret-scan.ts categories to find and redact secret-shaped
// values BEFORE anything is uploaded. Produces redacted_config,
// redaction_report, and content_hash — never raw secret values.

test('redactConfigForReview redacts a secret-shaped value found in the config', () => {
  const config = { model: 'claude', api_key: 'sk-abc123def456ghi789jkl012mno345pqr678stu901' }
  const result = redactConfigForReview(config)
  assert.doesNotMatch(JSON.stringify(result.redacted_config), /sk-abc123def456ghi789jkl012mno345pqr678stu901/)
  assert.ok(result.redaction_report.findings.length >= 1)
})

test('redactConfigForReview returns a content_hash of the redacted config', () => {
  const config = { model: 'claude' }
  const result = redactConfigForReview(config)
  assert.match(result.content_hash, /^sha256:[0-9a-f]{64}$/)
})

test('redactConfigForReview passes through clean config values unredacted', () => {
  const config = { model: 'claude', temperature: 0.7 }
  const result = redactConfigForReview(config)
  assert.deepEqual(result.redacted_config, config)
  assert.deepEqual(result.redaction_report.findings, [])
})

test('redactConfigForReview redacts nested secret values in objects', () => {
  const config = { auth: { token: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz01' } }
  const result = redactConfigForReview(config)
  assert.doesNotMatch(JSON.stringify(result.redacted_config), /ghp_1234567890abcdefghijklmnopqrstuvwxyz01/)
  assert.ok(result.redaction_report.findings.length >= 1)
})

test('redactConfigForReview never includes the raw secret value anywhere in the result', () => {
  const secret = 'AKIAIOSFODNN7EXAMPLE'
  const config = { aws_access_key_id: secret }
  const result = redactConfigForReview(config)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
})
