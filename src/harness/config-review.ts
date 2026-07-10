// Local redaction/preview helper backing create_harness_config_review
// (design.md §3, Phase 4). Reuses harness/secret-scan.ts categories: any
// string value in the config that matches a secret-shaped pattern is
// replaced with a redaction placeholder BEFORE anything is returned or
// uploaded. The redaction and preview MUST happen locally, before the
// agent-session upload call (harness-config-review spec, "Agent-session
// config review requires local preview before upload").

import { createHash } from 'node:crypto'

import { scanForSecrets, type SecretFinding } from './secret-scan.js'

const REDACTED_PLACEHOLDER = '[REDACTED]'

export interface RedactionReport {
  findings: SecretFinding[]
}

export interface RedactConfigResult {
  redacted_config: unknown
  redaction_report: RedactionReport
  content_hash: string
}

function redactValue(path: string, value: unknown, findings: SecretFinding[]): unknown {
  if (typeof value === 'string') {
    const hits = scanForSecrets(path, value)
    if (hits.length > 0) {
      findings.push(...hits)
      return REDACTED_PLACEHOLDER
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => redactValue(`${path}[${i}]`, item, findings))
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(path ? `${path}.${key}` : key, v, findings)
    }
    return out
  }
  return value
}

function sha256Of(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex')
}

/**
 * Redact secret-shaped values from a local config object before it is
 * previewed or uploaded as a harness_config_review. Never returns or hashes
 * the raw secret values — only the redacted config, a findings report
 * (category + file/path, never the matched value), and a content hash of
 * the REDACTED content.
 */
export function redactConfigForReview(config: unknown, sourceLabel = 'config'): RedactConfigResult {
  const findings: SecretFinding[] = []
  const redacted = redactValue(sourceLabel, config, findings)
  const contentHash = sha256Of(JSON.stringify(redacted))
  return {
    redacted_config: redacted,
    redaction_report: { findings },
    content_hash: contentHash,
  }
}
