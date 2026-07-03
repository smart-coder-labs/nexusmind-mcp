#!/usr/bin/env node
/**
 * nexusmind-mcp setup
 * Interactively configures NexusMind for Claude Code, Cursor, or both.
 *
 * Usage:
 *   npx @smart-coder-labs/nexusmind-mcp setup
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
// dist/hooks/*.js. THIS_DIR is the SOURCE used to populate the stable hook
// runtime (see copyHookRuntime()); hook commands themselves point at that
// stable copy, not at THIS_DIR — see hookCommand() for why.
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

// Like readJson, but distinguishes "missing" from "unparseable". Writing back a
// {} obtained from a corrupt file would destroy its contents — callers that
// rewrite large user-owned files (~/.claude.json) must use this variant.
function readJsonStrict(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
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

// Removes a duplicate ~/.claude.json mcpServers.nexusmind entry once the plugin
// is installed (the plugin owns registration; a leftover direct entry from an
// old setup run or a previous fallback install would otherwise duplicate it).
// Uses readJsonStrict — see the comment above it — so an unparseable file is
// left untouched instead of being silently reset. Returns whether an entry
// was actually removed.
export function removeLegacyClaudeJsonEntry(path: string = CLAUDE_JSON_PATH): boolean {
  const data = readJsonStrict(path)
  if (data === null) {
    error(`${path} exists but is not valid JSON — not touching it.`)
    log('  Fix the file, then remove the duplicate entry manually:')
    log(`    ${c.cyan}claude mcp remove nexusmind${c.reset}`)
    return false
  }
  const mcpServers = (data.mcpServers as Record<string, unknown>) ?? {}
  if (!('nexusmind' in mcpServers)) return false
  delete mcpServers['nexusmind']
  data.mcpServers = mcpServers
  writeJson(path, data)
  return true
}

// Fallback registration when the plugin is not installed: write the MCP server
// directly into ~/.claude.json so setup works out of the box on every platform.
// Real values (not ${VAR} placeholders) — Windows has no ~/.zshrc, so shell env
// vars written by writeShellEnv never reach Claude Code there.
function writeClaudeJsonMcpEntry(apiKey: string, baseUrl: string): boolean {
  const data = readJsonStrict(CLAUDE_JSON_PATH)
  if (data === null) {
    error(`${CLAUDE_JSON_PATH} exists but is not valid JSON — not touching it.`)
    log('  Fix the file, then re-run setup, or register manually:')
    log(`    ${c.cyan}claude mcp add nexusmind --scope user --env NEXUSMIND_API_KEY=${apiKey || '<key>'} --env NEXUSMIND_BASE_URL=${baseUrl} -- npx -y @smart-coder-labs/nexusmind-mcp@latest${c.reset}`)
    return false
  }
  const mcpServers = (data.mcpServers as Record<string, unknown>) ?? {}
  mcpServers['nexusmind'] = {
    command: 'npx',
    args: ['-y', '@smart-coder-labs/nexusmind-mcp@latest'],
    env: {
      NEXUSMIND_API_KEY: apiKey,
      NEXUSMIND_BASE_URL: baseUrl,
    },
  }
  data.mcpServers = mcpServers
  writeJson(CLAUDE_JSON_PATH, data)
  return true
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
    // A direct ~/.claude.json entry (old setup, or a previous fallback install)
    // duplicates the plugin's own registration.
    if (hasLegacyClaudeJsonEntry()) {
      warn(`Duplicate MCP registration detected in ${CLAUDE_JSON_PATH}`)
      log('  The plugin already registers NexusMind, so the direct `mcpServers.nexusmind`')
      log('  entry causes tools to load twice. Remove it with:')
      log(`    ${c.cyan}claude mcp remove nexusmind${c.reset}`)
    }
  } else {
    info('NexusMind plugin not installed — registering the MCP server directly')
    if (writeClaudeJsonMcpEntry(apiKey, baseUrl)) {
      success(`MCP server → ${CLAUDE_JSON_PATH}`)
    }
    log('')
    log('  Optional: the plugin adds hooks and slash commands on top of the MCP server.')
    log('  To upgrade later, inside Claude Code run:')
    log(`    ${c.cyan}/plugin marketplace add ${GITHUB_REPO}${c.reset}`)
    log(`    ${c.cyan}/plugin install ${PLUGIN_KEY}${c.reset}`)
    log(`  then remove the direct entry: ${c.cyan}claude mcp remove nexusmind${c.reset}`)
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

// Codex hooks.json nests handlers inside matcher groups under a top-level
// "hooks" key: { hooks: { Event: [{ matcher?, hooks: [entry] }] } }.
// See https://developers.openai.com/codex/hooks
interface CodexMatcherGroup {
  matcher?: string
  hooks: CodexHookDef[]
}

// Stable per-user location for the copied hook runtime — overridable via
// NEXUSMIND_HOOK_RUNTIME_DIR (read at call time, not cached, so tests can
// point it at a temp dir), same pattern as codexHomeDir().
function hookRuntimeDir(): string {
  return process.env.NEXUSMIND_HOOK_RUNTIME_DIR || join(HOME, '.nexusmind', 'hook-runtime')
}

const HOOK_RUNTIME_FILES = ['_helpers.js', 'session-start.js', 'user-prompt-submit.js', 'pre-compact.js', 'post-compact.js', 'stop.js']

// Copies the compiled hook runtime (hooks/*.js plus client.js, which they
// import) from this package's dist directory into the stable per-user
// location returned by hookRuntimeDir(), preserving the hooks/*.js ->
// ../client.js relative import. THIS_DIR (the copy source) can point inside a
// transient npx cache that later gets wiped, so hook commands must run from
// this stable copy instead of THIS_DIR — see hookCommand(). Every setup run
// overwrites the copy so upgrades refresh it; there is no diff/merge step.
export function copyHookRuntime(sourceDir: string = THIS_DIR, destDir: string = hookRuntimeDir()): boolean {
  const sourceClient = join(sourceDir, 'client.js')
  if (!existsSync(sourceClient)) {
    error(`Cannot find ${sourceClient} — this package was not built correctly.`)
    return false
  }
  mkdirSync(join(destDir, 'hooks'), { recursive: true })
  copyFileSync(sourceClient, join(destDir, 'client.js'))
  for (const f of HOOK_RUNTIME_FILES) {
    copyFileSync(join(sourceDir, 'hooks', f), join(destDir, 'hooks', f))
  }
  return true
}

// Absolute node path avoids Windows .cmd shim issues. The script path points
// at the stable hook-runtime copy (see copyHookRuntime()) rather than
// THIS_DIR — when installed via npx, THIS_DIR resolves inside the npx cache,
// and once that cache is cleaned the script can no longer be found, so the
// hook process exits 1 ("Cannot find module") even though the handler itself
// always exits 0.
function hookCommand(scriptFile: string): CodexHookDef {
  const nodeBin     = process.execPath
  const scriptPath  = join(hookRuntimeDir(), 'hooks', scriptFile)
  const commandLine = `"${nodeBin}" "${scriptPath}"`
  return {
    type: 'command',
    command: commandLine,
    command_windows: commandLine,
    timeout: 15,
  }
}

// Merges one hook entry into an event's matcher-group array — removes any prior
// NexusMind entry for the same script (idempotent re-run) without touching
// groups or entries other tools registered for the same event, then appends a
// fresh matcher-less group (matches all) with our handler.
function mergeHookEntry(existing: unknown, entry: CodexHookDef, marker: string): CodexMatcherGroup[] {
  const groups = Array.isArray(existing) ? (existing as CodexMatcherGroup[]) : []
  const kept: CodexMatcherGroup[] = []
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) continue
    const hooks = g.hooks.filter(h => !(typeof h?.command === 'string' && h.command.includes(marker)))
    if (hooks.length) kept.push({ ...g, hooks })
  }
  kept.push({ hooks: [entry] })
  return kept
}

export function installCodexHooks(sourceDir: string = THIS_DIR) {
  if (!copyHookRuntime(sourceDir)) return

  const hooksPath = join(codexHomeDir(), 'hooks.json')
  const data = readJsonStrict(hooksPath)
  if (data === null) {
    error(`${hooksPath} exists but is not valid JSON — not touching it. Fix or delete it and re-run setup.`)
    return
  }

  const mapping: Array<[string, string]> = [
    ['SessionStart', 'session-start.js'],
    ['UserPromptSubmit', 'user-prompt-submit.js'],
    ['PreCompact', 'pre-compact.js'],
    ['PostCompact', 'post-compact.js'],
    ['Stop', 'stop.js'],
    ['SubagentStop', 'stop.js'],
  ]

  const hooks = (data.hooks as Record<string, unknown>) ?? {}

  for (const [event, file] of mapping) {
    // Older versions of this setup wrote flat entries at the top level
    // ({ SessionStart: [entry] }) — a shape Codex silently ignores. Drop them.
    delete data[event]
    hooks[event] = mergeHookEntry(hooks[event], hookCommand(file), file)
  }

  data.hooks = hooks
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
    log('  • Restart Claude Code (or start a new session) to load the MCP server')
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
    log('  • Inside Codex, run /hooks and approve the NexusMind hooks (SessionStart, UserPromptSubmit, PreCompact, PostCompact, Stop, SubagentStop)')
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
