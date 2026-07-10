// Regex-based local secret scanner shared by the manifest builder
// (harness/build-manifest.ts) and the config-review redaction path
// (harness/config-review.ts). Runs on EVERY file's content before it is
// inlined into a manifest or uploaded. Design.md §6.
//
// Refuse-on-hit contract: a finding's `category` and `file` identify WHERE a
// secret was detected, but `excerpt` is a short, already-redacted preview —
// the matched secret value itself is never included anywhere in a Finding,
// so callers can safely serialize findings into an error message without
// leaking the secret.

export interface SecretFinding {
  file: string
  category: string
  /** Redacted preview, e.g. "sk-***" — never the raw matched value. */
  excerpt: string
}

interface ScanRule {
  category: string
  pattern: RegExp
}

// Each pattern is checked with a fresh `RegExp` (via `new RegExp(rule.pattern)`)
// per scan call to avoid shared-lastIndex bugs with the `g` flag across calls.
const RULES: ScanRule[] = [
  { category: 'api-key/token (sk-)', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { category: 'api-key/token (nm_)', pattern: /\bnm_[A-Za-z0-9_-]{16,}\b/g },
  { category: 'api-key/token (GitHub ghp_)', pattern: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { category: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    category: 'private-key-block',
    pattern: /-----BEGIN (?:RSA PRIVATE|EC PRIVATE|OPENSSH PRIVATE|PRIVATE) KEY-----/g,
  },
  {
    category: 'env-style-secret-assignment',
    pattern: /\b[A-Z0-9_]*(SECRET|PASSWORD|TOKEN|API_KEY)[A-Z0-9_]*\s*[:=]\s*['"]?[^\s'"]{6,}['"]?/gi,
  },
  { category: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9_.\-]{20,}\b/g },
  {
    category: 'generic-key-token-secret-near-long-value',
    pattern: /\b(key|token|secret|password)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-]{32,}['"]?/gi,
  },
  { category: 'local-path-leakage', pattern: /(\/Users\/[^\s'"]+|~\/\.ssh[^\s'"]*|\.ssh\/[^\s'"]*|\.env\b)/g },
]

function redact(match: string): string {
  const visible = match.slice(0, Math.min(3, match.length))
  return `${visible}***`
}

/**
 * Scan a single file's text content for secret-shaped patterns. Returns an
 * empty array for clean content. Findings never carry the raw matched value —
 * only a short redacted excerpt — so refusal messages built from findings are
 * always safe to display or transmit.
 */
export function scanForSecrets(file: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  for (const rule of RULES) {
    const re = new RegExp(rule.pattern)
    let match: RegExpExecArray | null
    while ((match = re.exec(content)) !== null) {
      findings.push({ file, category: rule.category, excerpt: redact(match[0]) })
      if (match[0].length === 0) re.lastIndex++ // guard against zero-length matches looping forever
    }
  }
  return findings
}
