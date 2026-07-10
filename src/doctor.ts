// `nexusmind-mcp doctor` — diagnoses the #1 support issue: "Invalid API key"
// even though setup ran. It surfaces WHERE each NEXUSMIND_API_KEY value lives
// (this process's env, the Windows user registry, the Codex config.toml) so a
// stale value shadowing the freshly-configured one is immediately visible, then
// live-validates the key against the backend.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyCredentials, maskKey } from './verify.js'

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
}
const ok   = (m: string) => console.log(`${c.green}✓${c.reset} ${m}`)
const bad  = (m: string) => console.log(`${c.red}✗${c.reset} ${m}`)
const warn = (m: string) => console.log(`${c.yellow}⚠${c.reset}  ${m}`)
const line = (m = '') => console.log(m)

function codexConfigPath(): string {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex')
  return join(home, 'config.toml')
}

// Minimal hand-parse of the `[mcp_servers.nexusmind.env]` table — enough to read
// two string keys without pulling in a TOML dependency. Returns {} if the file
// or section is absent.
function readCodexNexusEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const text = readFileSync(path, 'utf8')
  const lines = text.split(/\r?\n/)
  const out: Record<string, string> = {}
  let inSection = false
  for (const raw of lines) {
    const l = raw.trim()
    if (l.startsWith('[')) {
      inSection = l === '[mcp_servers.nexusmind.env]'
      continue
    }
    if (!inSection || !l || l.startsWith('#')) continue
    const m = l.match(/^([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

// Windows user-scope (HKCU\Environment) value — what NEW processes will inherit.
// Differs from process.env when setx ran after this shell was opened.
function windowsUserEnv(name: string): string | null {
  if (process.platform !== 'win32') return null
  const res = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8' })
  if (res.status !== 0 || !res.stdout) return null
  // Output line looks like:  NEXUSMIND_API_KEY    REG_SZ    nm_xxx
  const m = res.stdout.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`))
  return m ? m[1].trim() : null
}

export async function doctor(): Promise<number> {
  line(`${c.bold}${c.cyan}NexusMind — doctor${c.reset}`)
  line(`${c.dim}──────────────────────────────────${c.reset}`)

  const procKey = process.env.NEXUSMIND_API_KEY ?? ''
  const procUrl = process.env.NEXUSMIND_BASE_URL ?? ''

  line(`${c.bold}This process sees:${c.reset}`)
  line(`  NEXUSMIND_API_KEY  = ${maskKey(procKey)}`)
  line(`  NEXUSMIND_BASE_URL = ${procUrl || '(unset)'}`)
  line('')

  // Windows registry (user scope) — the source of truth for future processes.
  if (process.platform === 'win32') {
    const regKey = windowsUserEnv('NEXUSMIND_API_KEY')
    const regUrl = windowsUserEnv('NEXUSMIND_BASE_URL')
    line(`${c.bold}Windows user environment (registry):${c.reset}`)
    line(`  NEXUSMIND_API_KEY  = ${regKey ? maskKey(regKey) : '(unset)'}`)
    line(`  NEXUSMIND_BASE_URL = ${regUrl || '(unset)'}`)
    if (regKey && procKey && regKey !== procKey) {
      warn('This shell has a STALE key: the registry was updated after this program started.')
      line('  Fully quit and reopen your client from the Start menu so it inherits the new key.')
    }
    line('')
  }

  // Codex config.toml — carries literal values, independent of env vars.
  const cfgPath = codexConfigPath()
  const cfg = readCodexNexusEnv(cfgPath)
  line(`${c.bold}Codex config.toml:${c.reset} ${c.dim}${cfgPath}${c.reset}`)
  if (Object.keys(cfg).length === 0) {
    line('  (no [mcp_servers.nexusmind.env] block found)')
  } else {
    line(`  NEXUSMIND_API_KEY  = ${cfg.NEXUSMIND_API_KEY ? maskKey(cfg.NEXUSMIND_API_KEY) : '(unset)'}`)
    line(`  NEXUSMIND_BASE_URL = ${cfg.NEXUSMIND_BASE_URL || '(unset)'}`)
    if (procKey && cfg.NEXUSMIND_API_KEY && cfg.NEXUSMIND_API_KEY !== procKey) {
      warn('Codex config key differs from this process env key — a stale env var may shadow it.')
    }
  }
  line('')

  // Live validation. Prefer the Codex config values (what Codex actually sends),
  // falling back to the process env when Codex isn't configured.
  const key = cfg.NEXUSMIND_API_KEY || procKey
  const url = cfg.NEXUSMIND_BASE_URL || procUrl
  line(`${c.bold}Validating ${maskKey(key)} against ${url || '(no url)'}…${c.reset}`)
  const result = await verifyCredentials(key, url)
  if (result.ok) {
    ok('API key is valid — the backend accepted it.')
    line('')
    return 0
  }
  if (result.reason === 'unauthorized') {
    bad('Backend rejected the key (HTTP 401). This is the exact cause of "Invalid API key".')
    line('  → Re-run setup with the correct key, or restart your client if you just rotated it.')
  } else if (result.reason === 'unreachable') {
    bad(`Backend not reachable at ${url}. Check the URL and your network.`)
  } else if (result.reason === 'missing-key') {
    bad('No API key is set anywhere. Run: npx @smart-coder-labs/nexusmind-mcp setup')
  } else if (result.reason === 'missing-url') {
    bad('No backend URL is set. Run: npx @smart-coder-labs/nexusmind-mcp setup')
  } else {
    bad(result.message)
  }
  line('')
  return 1
}
