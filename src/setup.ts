#!/usr/bin/env node
/**
 * nexusmind-mcp setup
 * Interactively configures NexusMind for Claude Code, Cursor, or both.
 *
 * Usage:
 *   npx @smart-coder-labs/nexusmind-mcp setup
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { spawnSync } from 'node:child_process'

// ── Paths ─────────────────────────────────────────────────────────────────────

const HOME                  = homedir()
const CLAUDE_JSON_PATH      = join(HOME, '.claude.json')
const CLAUDE_SETTINGS       = join(HOME, '.claude', 'settings.json')
const INSTALLED_PLUGINS_JSON = join(HOME, '.claude', 'plugins', 'installed_plugins.json')
const CURSOR_GLOBAL         = join(HOME, '.cursor', 'mcp.json')
// This file is dist/setup.js when built/published — hooks live alongside it at
// dist/hooks/*.js, so THIS_DIR is already the right base for hook script paths.
const THIS_DIR              = dirname(fileURLToPath(import.meta.url))

const GITHUB_REPO       = 'smart-coder-labs/nexusmind-claude-plugin'
const MARKETPLACE_NAME  = 'nexusmind'
const PLUGIN_KEY        = `${MARKETPLACE_NAME}@${MARKETPLACE_NAME}`

// Codex CLI — home directory is overridable via CODEX_HOME (read at call time,
// not cached, so tests can point it at a temp dir).
function codexHomeDir(): string {
  return process.env.CODEX_HOME || join(HOME, '.codex')
}

// ── Colors ────────────────────────────────────────────────────────────────────

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
}

const log     = (msg: string) => console.log(msg)
const info    = (msg: string) => console.log(`${c.blue}›${c.reset} ${msg}`)
const success = (msg: string) => console.log(`${c.green}✓${c.reset} ${msg}`)
const warn    = (msg: string) => console.log(`${c.yellow}⚠${c.reset}  ${msg}`)
const error   = (msg: string) => console.error(`${c.red}✗${c.reset} ${msg}`)

// ── File helpers ──────────────────────────────────────────────────────────────

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

function writeJson(path: string, data: Record<string, unknown>) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

function mcpEntry() {
  return {
    command: 'npx',
    // Pin @latest so npx re-resolves on every startup instead of reusing a stale
    // cached version — otherwise published updates never reach the user until they
    // manually clear the npx cache.
    args: ['-y', '@smart-coder-labs/nexusmind-mcp@latest'],
    env: {
      NEXUSMIND_API_KEY: '${NEXUSMIND_API_KEY}',
      NEXUSMIND_BASE_URL: '${NEXUSMIND_BASE_URL}',
    },
  }
}

function writeShellEnv(apiKey: string, baseUrl: string) {
  for (const rc of [join(HOME, '.zshrc'), join(HOME, '.bashrc')]) {
    if (!existsSync(rc)) continue
    const text = readFileSync(rc, 'utf8')
    const lines: string[] = []
    if (apiKey && !text.includes('NEXUSMIND_API_KEY')) {
      lines.push(`export NEXUSMIND_API_KEY="${apiKey}"`)
    }
    if (!text.includes('NEXUSMIND_BASE_URL')) {
      lines.push(`export NEXUSMIND_BASE_URL="${baseUrl}"`)
    }
    if (lines.length) {
      writeFileSync(rc, text + `\n# NexusMind\n${lines.join('\n')}\n`)
      success(`Env vars → ${rc}`)
    }
  }
}

// ── Install helpers ───────────────────────────────────────────────────────────

// The Claude plugin is the canonical registration path for Claude Code — it owns
// the MCP server entry and hooks. Setup no longer writes a user-level MCP server
// registration (~/.claude.json or ~/.claude/settings.json) for Claude Code; it only
// detects the plugin and guides the user to install it if missing.
function isNexusmindPluginInstalled(): boolean {
  const data = readJson(INSTALLED_PLUGINS_JSON)
  if (existsSync(INSTALLED_PLUGINS_JSON) && !('plugins' in data)) {
    info(`Note: ${INSTALLED_PLUGINS_JSON} exists but has an unexpected shape (no "plugins" key) — treating plugin as not installed.`)
  }
  const plugins = (data.plugins as Record<string, unknown[]>) ?? {}
  const entry = plugins[PLUGIN_KEY]
  return Array.isArray(entry) && entry.length > 0
}

// Setup used to write a legacy `mcpServers.nexusmind` entry directly into ~/.claude.json.
// That file is never touched by the current setup flow, so users who ran an old version
// keep that entry forever — even after installing the plugin, which registers its own
// MCP server. Two entries pointing at NexusMind causes duplicate tool registration.
function hasLegacyClaudeJsonEntry(): boolean {
  const data = readJson(CLAUDE_JSON_PATH)
  const mcpServers = (data.mcpServers as Record<string, unknown>) ?? {}
  return 'nexusmind' in mcpServers
}

function installClaudeCode(apiKey: string, baseUrl: string) {
  // Clean up stale absolute-path hooks from old installs
  const settings = readJson(CLAUDE_SETTINGS)
  const hooks = (settings.hooks as Record<string, unknown[]>) ?? {}
  let cleaned = false
  for (const event of Object.keys(hooks)) {
    const before = hooks[event].length
    hooks[event] = (hooks[event] as Array<Record<string, unknown>>).filter(e => {
      const cmds: string[] = []
      if (typeof e.command === 'string') cmds.push(e.command)
      for (const h of (e.hooks ?? []) as Array<{ command?: string }>) {
        if (h.command) cmds.push(h.command)
      }
      return !cmds.some(c => c.includes('nexusmind-mcp/plugin') || c.includes('nexusmind/plugin'))
    })
    if (hooks[event].length !== before) cleaned = true
    if (hooks[event].length === 0) delete hooks[event]
  }
  if (cleaned) {
    settings.hooks = hooks
    writeJson(CLAUDE_SETTINGS, settings)
    info('Removed stale hooks from previous install')
  }

  writeShellEnv(apiKey, baseUrl)

  if (isNexusmindPluginInstalled()) {
    success('NexusMind plugin detected — MCP registration is handled by the plugin')
  } else {
    warn('NexusMind plugin not installed — it is the canonical way to register NexusMind with Claude Code')
    log('  Inside Claude Code, run:')
    log(`    ${c.cyan}/plugin marketplace add ${GITHUB_REPO}${c.reset}`)
    log(`    ${c.cyan}/plugin install ${PLUGIN_KEY}${c.reset}`)
  }

  if (hasLegacyClaudeJsonEntry()) {
    warn(`${c.bold}Legacy MCP registration detected in ${CLAUDE_JSON_PATH}${c.reset}`)
    log('  An older version of this setup wrote a `mcpServers.nexusmind` entry directly')
    log(`  into ${c.dim}${CLAUDE_JSON_PATH}${c.reset}. That file is no longer managed by setup, so this`)
    log('  entry is never cleaned up automatically. If the plugin is also installed, NexusMind')
    log('  ends up registered twice, which can duplicate tools or cause conflicting behavior.')
    log('  Remove the legacy entry with:')
    log(`    ${c.cyan}claude mcp remove nexusmind${c.reset}`)
  }
}

function installCursor(apiKey: string, baseUrl: string, scope: 'global' | 'project') {
  const configPath = scope === 'global'
    ? CURSOR_GLOBAL
    : join(resolve(process.cwd()), '.cursor', 'mcp.json')

  const existing = readJson(configPath)
  const mcpServers = (existing.mcpServers as Record<string, unknown>) ?? {}
  mcpServers['nexusmind'] = mcpEntry()
  existing.mcpServers = mcpServers
  writeJson(configPath, existing)
  success(`MCP server → ${configPath}`)

  writeShellEnv(apiKey, baseUrl)
}

// ── Codex CLI ─────────────────────────────────────────────────────────────────

function isCodexCliAvailable(): boolean {
  try {
    const res = spawnSync('codex', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' })
    return !res.error && res.status === 0
  } catch {
    return false
  }
}

function registerCodexMcp(apiKey: string, baseUrl: string): boolean {
  const args = [
    'mcp', 'add', 'nexusmind',
    '--env', `NEXUSMIND_API_KEY=${apiKey}`,
    '--env', `NEXUSMIND_BASE_URL=${baseUrl}`,
    '--',
    'npx', '-y', '@smart-coder-labs/nexusmind-mcp@latest',
  ]
  try {
    const res = spawnSync('codex', args, { stdio: 'inherit', shell: process.platform === 'win32' })
    return !res.error && res.status === 0
  } catch {
    return false
  }
}

function printCodexTomlSnippet(apiKey: string, baseUrl: string) {
  const configPath = join(codexHomeDir(), 'config.toml')
  log(`  Add this to ${c.cyan}${configPath}${c.reset} (do not hand-edit any other way):`)
  log('')
  log(`    ${c.dim}[mcp_servers.nexusmind]${c.reset}`)
  log(`    ${c.dim}command = "npx"${c.reset}`)
  log(`    ${c.dim}args = ["-y", "@smart-coder-labs/nexusmind-mcp@latest"]${c.reset}`)
  log(`    ${c.dim}[mcp_servers.nexusmind.env]${c.reset}`)
  log(`    ${c.dim}NEXUSMIND_API_KEY = "${apiKey}"${c.reset}`)
  log(`    ${c.dim}NEXUSMIND_BASE_URL = "${baseUrl}"${c.reset}`)
}

interface CodexHookDef {
  type: 'command'
  command: string
  command_windows: string
  timeout: number
}

// Absolute node path avoids Windows .cmd shim issues; absolute dist path means
// the hook works regardless of Codex's cwd.
function hookCommand(scriptFile: string): CodexHookDef {
  const nodeBin     = process.execPath
  const scriptPath  = join(THIS_DIR, 'hooks', scriptFile)
  const commandLine = `"${nodeBin}" "${scriptPath}"`
  return {
    type: 'command',
    command: commandLine,
    command_windows: commandLine,
    timeout: 15,
  }
}

// Merges one hook entry into an existing event array — replaces any prior
// NexusMind entry for the same script (idempotent re-run) without touching
// entries other tools registered for the same event.
function mergeHookEntry(existing: unknown, entry: CodexHookDef, marker: string): CodexHookDef[] {
  const arr = Array.isArray(existing) ? (existing as CodexHookDef[]) : []
  const filtered = arr.filter(h => !(typeof h?.command === 'string' && h.command.includes(marker)))
  filtered.push(entry)
  return filtered
}

export function installCodexHooks() {
  const hooksPath = join(codexHomeDir(), 'hooks.json')
  const data = readJson(hooksPath) as Record<string, unknown>

  const mapping: Array<[string, string]> = [
    ['SessionStart', 'session-start.js'],
    ['UserPromptSubmit', 'user-prompt-submit.js'],
    ['PostCompact', 'post-compact.js'],
    ['Stop', 'stop.js'],
    ['SubagentStop', 'stop.js'],
  ]

  for (const [event, file] of mapping) {
    data[event] = mergeHookEntry(data[event], hookCommand(file), file)
  }

  writeJson(hooksPath, data)
  success(`Hooks → ${hooksPath}`)
}

export function installCodex(apiKey: string, baseUrl: string) {
  writeShellEnv(apiKey, baseUrl)

  if (isCodexCliAvailable()) {
    info('Registering MCP server via codex mcp add…')
    if (registerCodexMcp(apiKey, baseUrl)) {
      success('MCP server registered with Codex CLI')
    } else {
      warn('codex mcp add failed — add this manually instead:')
      printCodexTomlSnippet(apiKey, baseUrl)
    }
  } else {
    warn('codex CLI not found on PATH — add this manually:')
    printCodexTomlSnippet(apiKey, baseUrl)
  }

  installCodexHooks()

  log('')
  warn('Hooks are NOT auto-trusted by Codex. Inside Codex, run /hooks and approve the NexusMind hooks before they take effect.')
  info('Codex\'s native "Memories" feature (off by default) coexists with these hooks — enabling both is safe but may duplicate context. See README.')
}

// ── Prompt helpers ────────────────────────────────────────────────────────────

async function choose(rl: readline.Interface, prompt: string, options: string[]): Promise<number> {
  while (true) {
    const raw = await rl.question(prompt)
    const n = parseInt(raw.trim(), 10)
    if (n >= 1 && n <= options.length) return n
    error(`Enter a number between 1 and ${options.length}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function main() {
  log(`\n${c.bold}${c.cyan}NexusMind — Setup${c.reset}`)
  log(`${c.dim}──────────────────────────────────${c.reset}\n`)

  const rl = readline.createInterface({ input, output })

  // API key + URL
  const envKey = process.env.NEXUSMIND_API_KEY  ?? ''
  const envUrl = process.env.NEXUSMIND_BASE_URL ?? ''

  let apiKey: string
  let baseUrl: string

  if (envKey) {
    const masked = envKey.length > 8 ? envKey.slice(0, 6) + '…' + envKey.slice(-4) : '***'
    const answer = (await rl.question(`NexusMind API key [${masked}]: `)).trim()
    apiKey = answer || envKey
  } else {
    apiKey = (await rl.question('NexusMind API key (nm_…): ')).trim()
  }

  if (envUrl) {
    const answer = (await rl.question(`Backend URL [${envUrl}]: `)).trim()
    baseUrl = answer || envUrl
  } else {
    baseUrl = (await rl.question('Backend URL [http://localhost:8080]: ')).trim() || 'http://localhost:8080'
  }

  if (!apiKey) {
    warn('No API key provided — you can set NEXUSMIND_API_KEY and re-run setup.')
  }

  // Tool selection
  log('')
  log(`${c.bold}Configure for:${c.reset}`)
  log('  1) Claude Code')
  log('  2) Cursor')
  log('  3) Codex CLI')
  log('  4) All (recommended)')

  const toolChoice = await choose(rl, '\nChoice [1-4]: ', ['1', '2', '3', '4'])

  const doClaude = toolChoice === 1 || toolChoice === 4
  const doCursor = toolChoice === 2 || toolChoice === 4
  const doCodex  = toolChoice === 3 || toolChoice === 4

  // Cursor scope (only if Cursor selected)
  let cursorScope: 'global' | 'project' = 'global'
  if (doCursor) {
    log('')
    log(`${c.bold}Cursor — where to write the config?${c.reset}`)
    log('  1) Global (all projects)  →  ~/.cursor/mcp.json')
    log(`  2) This project only      →  ${resolve(process.cwd())}/.cursor/mcp.json`)

    const scopeChoice = await choose(rl, '\nChoice [1-2]: ', ['1', '2'])
    cursorScope = scopeChoice === 1 ? 'global' : 'project'
  }

  rl.close()

  // Execute
  log('')
  if (doClaude) {
    log(`${c.bold}Setting up Claude Code…${c.reset}`)
    installClaudeCode(apiKey, baseUrl)
    log('')
  }

  if (doCursor) {
    log(`${c.bold}Setting up Cursor (${cursorScope})…${c.reset}`)
    installCursor(apiKey, baseUrl, cursorScope)
    log('')
  }

  if (doCodex) {
    log(`${c.bold}Setting up Codex CLI…${c.reset}`)
    installCodex(apiKey, baseUrl)
    log('')
  }

  // Done
  log(`${c.bold}${c.green}All done!${c.reset}\n`)

  if (doClaude) {
    log(`${c.bold}Claude Code${c.reset}`)
    log('  • Run: source ~/.zshrc  (or open a new terminal)')
    log('  • Registration is handled by the NexusMind plugin — install it if you have not (see above)')
    log('  • Tools available: store_memory, search_memories, get_context')
    log('')
  }
  if (doCursor) {
    log(`${c.bold}Cursor${c.reset}`)
    log('  • Run: source ~/.zshrc  (or open a new terminal)')
    log('  • Then restart Cursor')
    log('  • Tools available: store_memory, search_memories, get_context')
    if (cursorScope === 'global') {
      log('  • Active for all projects globally')
    } else {
      log('  • Active only in this project — open the folder in Cursor')
    }
    log('')
  }
  if (doCodex) {
    log(`${c.bold}Codex CLI${c.reset}`)
    log('  • Run: source ~/.zshrc  (or open a new terminal)')
    log('  • Inside Codex, run /hooks and approve the NexusMind hooks (SessionStart, UserPromptSubmit, PostCompact, Stop, SubagentStop)')
    log('  • Tools available: store_memory, search_memories, get_context')
    log('')
  }
}

// Run when invoked as a script — including via the npm bin symlink, where
// process.argv[1] points at .bin/nexusmind-setup rather than dist/setup.js.
// Resolve both through realpath so the symlink matches the real module path.
// (Skip when imported as a module.)
{
  const invoked = process.argv[1]
  const modulePath = fileURLToPath(import.meta.url)
  let isDirectRun = invoked === modulePath
  if (!isDirectRun && invoked) {
    try {
      isDirectRun = realpathSync(invoked) === realpathSync(modulePath)
    } catch {
      isDirectRun = false
    }
  }
  if (isDirectRun) {
    await main()
  }
}
