#!/usr/bin/env node
/**
 * nexusmind-mcp setup
 * Interactively configures NexusMind for Claude Code, Cursor, or both.
 *
 * Usage:
 *   npx @smart-coder-labs/nexusmind-mcp setup
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

// ── Paths ─────────────────────────────────────────────────────────────────────

const HOME              = homedir()
const CLAUDE_JSON_PATH  = join(HOME, '.claude.json')
const CLAUDE_SETTINGS   = join(HOME, '.claude', 'settings.json')
const CURSOR_GLOBAL     = join(HOME, '.cursor', 'mcp.json')

const GITHUB_REPO       = 'smart-coder-labs/nexusmind-claude-plugin'
const MARKETPLACE_NAME  = 'nexusmind'
const PLUGIN_KEY        = `${MARKETPLACE_NAME}@${MARKETPLACE_NAME}`

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

function mcpEntry(apiKey: string, baseUrl: string) {
  return {
    command: 'npx',
    args: ['-y', '@smart-coder-labs/nexusmind-mcp'],
    env: {
      NEXUSMIND_API_KEY: apiKey,
      NEXUSMIND_BASE_URL: baseUrl,
    },
  }
}

// ── Install helpers ───────────────────────────────────────────────────────────

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

  // Write MCP entry to ~/.claude.json
  const claudeJson = readJson(CLAUDE_JSON_PATH)
  const mcpServers = (claudeJson.mcpServers as Record<string, unknown>) ?? {}
  mcpServers['nexusmind'] = mcpEntry(apiKey, baseUrl)
  claudeJson.mcpServers = mcpServers
  writeJson(CLAUDE_JSON_PATH, claudeJson)
  success(`MCP server → ${CLAUDE_JSON_PATH}`)

  // Register plugin (hooks downloaded from GitHub by Claude Code)
  const s = readJson(CLAUDE_SETTINGS)
  const enabledPlugins  = (s.enabledPlugins  as Record<string, boolean>) ?? {}
  const extraMarkets    = (s.extraKnownMarketplaces as Record<string, unknown>) ?? {}
  enabledPlugins[PLUGIN_KEY] = true
  extraMarkets[MARKETPLACE_NAME] = { source: { repo: GITHUB_REPO, source: 'github' } }
  s.enabledPlugins = enabledPlugins
  s.extraKnownMarketplaces = extraMarkets
  writeJson(CLAUDE_SETTINGS, s)
  success(`Plugin registered → github.com/${GITHUB_REPO}`)

  // Persist env vars to shell rc files
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

function installCursor(apiKey: string, baseUrl: string, scope: 'global' | 'project') {
  const configPath = scope === 'global'
    ? CURSOR_GLOBAL
    : join(resolve(process.cwd()), '.cursor', 'mcp.json')

  const existing = readJson(configPath)
  const mcpServers = (existing.mcpServers as Record<string, unknown>) ?? {}
  mcpServers['nexusmind'] = mcpEntry(apiKey, baseUrl)
  existing.mcpServers = mcpServers
  writeJson(configPath, existing)
  success(`MCP server → ${configPath}`)

  if (scope === 'project') {
    // Remind to gitignore the file if it has a real key
    if (apiKey) {
      warn(`.cursor/mcp.json contains your API key — add it to .gitignore if this is a shared repo`)
    }
  }
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
log('  3) Both (recommended)')

const toolChoice = await choose(rl, '\nChoice [1-3]: ', ['1', '2', '3'])

let doClaude = toolChoice === 1 || toolChoice === 3
let doCursor = toolChoice === 2 || toolChoice === 3

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

// Done
log(`${c.bold}${c.green}All done!${c.reset}\n`)

if (doClaude) {
  log(`${c.bold}Claude Code${c.reset}`)
  log('  • Restart Claude Code (or run: source ~/.zshrc)')
  log('  • Tools available: store_memory, search_memory, list_memories, get_context')
  log('')
}
if (doCursor) {
  log(`${c.bold}Cursor${c.reset}`)
  log('  • Restart Cursor after adding mcp.json')
  log('  • Tools available: store_memory, search_memory, list_memories, get_context')
  if (cursorScope === 'global') {
    log('  • Active for all projects globally')
  } else {
    log('  • Active only in this project — open the folder in Cursor')
  }
  log('')
}
