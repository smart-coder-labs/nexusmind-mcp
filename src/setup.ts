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
import { verifyCredentials, maskKey } from './verify.js'
import { probeNpxLaunch, clearNpxCache, PACKAGE_SPEC } from './npx-health.js'

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

// Persists the API key + base URL so future sessions — and, crucially, the
// ${NEXUSMIND_API_KEY} / ${NEXUSMIND_BASE_URL} placeholders in every MCP
// registration (the Claude plugin's .mcp.json, Cursor's mcp.json, the Codex
// config.toml) — can resolve them. Platform-dispatched: POSIX shells read env
// from rc files; Windows has no ~/.zshrc / ~/.bashrc, so the vars must go into
// the persistent per-user environment instead (see writeWindowsEnv).
// rcFiles is injectable (defaulting to the real per-user rc files) so tests can
// exercise the callers of this function without appending to a developer's real
// ~/.zshrc — pass [] to make the shell-env write a no-op.
const DEFAULT_RC_FILES = () => [join(HOME, '.zshrc'), join(HOME, '.bashrc')]

function writeEnvVars(apiKey: string, baseUrl: string, rcFiles: string[] = DEFAULT_RC_FILES()) {
  if (process.platform === 'win32') {
    writeWindowsEnv(apiKey, baseUrl)
  } else {
    writeShellEnv(apiKey, baseUrl, rcFiles)
  }
}

function writeShellEnv(apiKey: string, baseUrl: string, rcFiles: string[] = DEFAULT_RC_FILES()) {
  for (const rc of rcFiles) {
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

// Windows persistent env vars via setx, which writes HKCU\Environment (User
// scope) so every future process inherits them. Without this, setup wrote only
// to shell rc files that don't exist on Windows, leaving NEXUSMIND_BASE_URL
// unset — so clients failed with "Missing environment variables:
// NEXUSMIND_BASE_URL" when expanding the ${...} placeholders in their MCP
// config. setx only affects processes started AFTER it runs, so the user must
// restart their client (already the documented post-setup step); we also mirror
// the values into process.env so any same-run check sees them. Values here (an
// API key + a URL) are far under setx's ~1024-char limit.
function writeWindowsEnv(apiKey: string, baseUrl: string) {
  const setVar = (name: string, value: string) => {
    if (!value) return
    const res = spawnSync('setx', [name, value], { stdio: 'ignore', shell: true })
    if (!res.error && res.status === 0) {
      process.env[name] = value
      success(`Env var ${name} → Windows user environment`)
    } else {
      warn(`Could not set ${name} automatically — run this yourself: setx ${name} "${value}"`)
    }
  }
  setVar('NEXUSMIND_API_KEY', apiKey)
  setVar('NEXUSMIND_BASE_URL', baseUrl)
}

// ── npx launch health ─────────────────────────────────────────────────────────

// Verifies clients can launch the server via npx, and self-heals a corrupted npx
// cache — the real cause behind Codex's opaque "connection closed: initialize
// response". Shared across all clients since they share one npx cache.
function verifyAndRepairNpxLaunch() {
  info('Verifying the server launches via npx…')
  const first = probeNpxLaunch()
  if (first === 'ok') { success('Server launches correctly via npx'); return }
  if (first === 'inconclusive') {
    info('npx launched the server but could not confirm the version (likely an older published @latest) — skipping.')
    return
  }
  warn('npx could not launch the server — this is usually a corrupted npx cache.')
  info('Clearing the npx cache and retrying…')
  if (clearNpxCache() && probeNpxLaunch() !== 'unresolved') {
    success('npx cache repaired — server launches correctly now')
    return
  }
  error('Server still fails to launch via npx after clearing the cache.')
  log('  Diagnose with: ' + `${c.cyan}npx ${PACKAGE_SPEC} doctor${c.reset}`)
  log('  Or clear the cache manually: ' + `${c.cyan}npm cache clean --force${c.reset}`)
}

// ── Install helpers ───────────────────────────────────────────────────────────

// The Claude plugin is the canonical registration path for Claude Code — it owns
// the MCP server entry and hooks. installedPluginsPath is injectable (defaulting to
// the real per-user location) purely for test isolation, same pattern as
// removeLegacyClaudeJsonEntry's `path` parameter below.
function isNexusmindPluginInstalled(installedPluginsPath: string = INSTALLED_PLUGINS_JSON): boolean {
  const data = readJson(installedPluginsPath)
  if (existsSync(installedPluginsPath) && !('plugins' in data)) {
    info(`Note: ${installedPluginsPath} exists but has an unexpected shape (no "plugins" key) — treating plugin as not installed.`)
  }
  const plugins = (data.plugins as Record<string, unknown[]>) ?? {}
  const entry = plugins[PLUGIN_KEY]
  return Array.isArray(entry) && entry.length > 0
}

// Read-only detection of a legacy `mcpServers.nexusmind` entry in ~/.claude.json
// (written by an old setup version, or by this setup's own fallback path). Kept
// separate from removeLegacyClaudeJsonEntry because the two are used in
// different situations: we may only DETECT (and warn) when the plugin's
// installed-state is merely *recorded* on disk, and only REMOVE when we have
// fresh proof the plugin actually installed — see installClaudeCode.
function hasLegacyClaudeJsonEntry(path: string = CLAUDE_JSON_PATH): boolean {
  const data = readJson(path)
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

// Fallback registration when the plugin is not installed (or fails to install):
// write the MCP server directly into ~/.claude.json so setup works out of the box
// on every platform. Real values (not ${VAR} placeholders) — Windows has no
// ~/.zshrc, so shell env vars written by writeShellEnv never reach Claude Code
// there. claudeJsonPath is injectable purely for test isolation.
function writeClaudeJsonMcpEntry(apiKey: string, baseUrl: string, claudeJsonPath: string = CLAUDE_JSON_PATH): boolean {
  const data = readJsonStrict(claudeJsonPath)
  if (data === null) {
    error(`${claudeJsonPath} exists but is not valid JSON — not touching it.`)
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
  writeJson(claudeJsonPath, data)
  return true
}

// Writes NEXUSMIND_API_KEY / NEXUSMIND_BASE_URL into ~/.claude/settings.json's
// `env` block — the ONLY reliable way to make the ${NEXUSMIND_API_KEY} /
// ${NEXUSMIND_BASE_URL} placeholders in the plugin's .mcp.json resolve.
//
// Claude Code documents `env` as "Environment variables applied to every session
// and to subprocesses Claude Code spawns from it" (https://code.claude.com/docs/en/settings).
// MCP servers are exactly such subprocesses. It is plain JSON read by the Claude
// Code binary — no shell involved — so it works identically on macOS, Linux and
// Windows (%USERPROFILE%\.claude\settings.json).
//
// Shell rc files cannot serve this purpose: ~/.zshrc / ~/.bashrc often do not
// exist at all (the plugin's placeholders then resolve to nothing and Claude Code
// fails to parse the config), and even when they do, a GUI-launched Claude Code
// does not inherit them. That is the same class of bug already documented for
// Windows in the 0.7.x notes — this is its macOS/Linux flavor.
//
// Merges rather than clobbers, and uses readJsonStrict so a corrupt settings.json
// is reported instead of being silently reset. Returns whether the env block is
// now in place.
export function writeClaudeSettingsEnv(apiKey: string, baseUrl: string, settingsPath: string = CLAUDE_SETTINGS): boolean {
  const data = readJsonStrict(settingsPath)
  if (data === null) {
    error(`${settingsPath} exists but is not valid JSON — not touching it.`)
    log('  Fix the file, then re-run setup, or add this to its "env" block yourself:')
    log(`    ${c.cyan}"NEXUSMIND_API_KEY": "${apiKey || '<key>'}", "NEXUSMIND_BASE_URL": "${baseUrl}"${c.reset}`)
    return false
  }
  const env = (data.env as Record<string, unknown>) ?? {}
  if (apiKey) env['NEXUSMIND_API_KEY'] = apiKey
  env['NEXUSMIND_BASE_URL'] = baseUrl
  data.env = env
  writeJson(settingsPath, data) // writeJson mkdir -p's the parent dir
  success(`Env vars → ${settingsPath}`)
  return true
}

// spawnSync-shaped dependency, injectable so tests can stub process execution
// without spawning a real `claude` CLI — same convention used throughout the
// Codex CLI helpers below (isCodexCliAvailable, registerCodexMcp).
type SpawnFn = typeof spawnSync

function isClaudeCliAvailable(spawn: SpawnFn = spawnSync): boolean {
  try {
    const res = spawn('claude', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' })
    return !res.error && res.status === 0
  } catch {
    return false
  }
}

// Actually installs the NexusMind Claude Code plugin (marketplace + plugin),
// instead of merely printing the two commands for the user to run by hand.
// stdio: 'inherit' so a marketplace trust prompt (Claude Code may ask the user
// to confirm trusting a new marketplace source) reaches the user's terminal
// instead of hanging silently. Both subcommands are verified, non-interactive
// Claude Code CLI commands: `claude plugin marketplace add <source> --scope
// user` and `claude plugin install <plugin@marketplace> --scope user`.
export function installNexusmindPlugin(spawn: SpawnFn = spawnSync): boolean {
  try {
    const marketplaceRes = spawn(
      'claude',
      ['plugin', 'marketplace', 'add', GITHUB_REPO, '--scope', 'user'],
      { stdio: 'inherit', shell: process.platform === 'win32' },
    )
    if (marketplaceRes.error || marketplaceRes.status !== 0) return false

    const installRes = spawn(
      'claude',
      ['plugin', 'install', PLUGIN_KEY, '--scope', 'user'],
      { stdio: 'inherit', shell: process.platform === 'win32' },
    )
    if (installRes.error || installRes.status !== 0) return false

    return true
  } catch {
    return false
  }
}

// All file paths and the spawn dependency are injectable — defaulting to the
// real per-user locations / real spawnSync — purely for test isolation (see
// setup.test.ts). Production callers use the defaults.
export function installClaudeCode(
  apiKey: string,
  baseUrl: string,
  opts: {
    spawn?: SpawnFn
    claudeJsonPath?: string
    claudeSettingsPath?: string
    installedPluginsPath?: string
    rcFiles?: string[]
  } = {},
) {
  const {
    spawn = spawnSync,
    claudeJsonPath = CLAUDE_JSON_PATH,
    claudeSettingsPath = CLAUDE_SETTINGS,
    installedPluginsPath = INSTALLED_PLUGINS_JSON,
    rcFiles = DEFAULT_RC_FILES(),
  } = opts

  // Clean up stale absolute-path hooks from old installs
  const settings = readJson(claudeSettingsPath)
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
    writeJson(claudeSettingsPath, settings)
    info('Removed stale hooks from previous install')
  }

  // Two separate env destinations, both needed:
  //  • shell rc files — still serve Cursor and plain-CLI usage (no-op when the
  //    rc files don't exist, which is common).
  //  • ~/.claude/settings.json `env` — the only thing that makes the PLUGIN's
  //    .mcp.json ${NEXUSMIND_*} placeholders resolve. Written BEFORE any decision
  //    to drop the legacy literal-valued ~/.claude.json entry, because that entry
  //    is the user's only working registration until this block exists.
  writeEnvVars(apiKey, baseUrl, rcFiles)
  const envWritten = writeClaudeSettingsEnv(apiKey, baseUrl, claudeSettingsPath)

  if (isNexusmindPluginInstalled(installedPluginsPath)) {
    success('NexusMind plugin detected — MCP registration is handled by the plugin')
    // A direct ~/.claude.json entry (old setup, or a previous fallback install)
    // duplicates the plugin's own registration. WARN ONLY — do not delete it.
    // isNexusmindPluginInstalled() trusts installed_plugins.json, which records
    // what was installed, not that it still works; a stale or broken record
    // still returns true. Deleting the direct entry on that evidence alone could
    // strip the user's ONLY working MCP registration and leave them with none.
    // The removal is only safe on the branch below, where we installed the
    // plugin ourselves in this run and watched it succeed.
    const hasDirectEntry = hasLegacyClaudeJsonEntry(claudeJsonPath)

    if (envWritten) {
      // The plugin can resolve its credentials, so a direct entry really is a
      // redundant duplicate — advise removing it (but never delete it here; the
      // installed-plugins record alone is not proof the plugin still works).
      if (hasDirectEntry) {
        warn(`Duplicate MCP registration detected in ${claudeJsonPath}`)
        log('  The plugin already registers NexusMind, so the direct `mcpServers.nexusmind`')
        log('  entry causes tools to load twice. Remove it with:')
        log(`    ${c.cyan}claude mcp remove nexusmind${c.reset}`)
      }
      return
    }

    // No env block: the plugin's ${NEXUSMIND_*} placeholders resolve to nothing,
    // so the direct entry is not a duplicate — it is the only thing that works.
    // Never advise removing it here, and if it is missing, write it: setup must
    // never return leaving the user with zero working MCP registrations.
    warn(`The env block could not be written to ${claudeSettingsPath}.`)
    log('  The plugin\'s ${NEXUSMIND_API_KEY} / ${NEXUSMIND_BASE_URL} placeholders cannot resolve without it,')
    log(`  so MCP credentials rely on a direct entry in ${claudeJsonPath}.`)
    if (hasDirectEntry) {
      info(`Keeping the existing direct entry in ${claudeJsonPath} — it holds the only working credentials.`)
    } else if (writeClaudeJsonMcpEntry(apiKey, baseUrl, claudeJsonPath)) {
      success(`MCP server → ${claudeJsonPath}`)
    }
    return
  }

  if (isClaudeCliAvailable(spawn)) {
    info('Installing the NexusMind Claude Code plugin…')
    if (installNexusmindPlugin(spawn)) {
      // Dropping the direct ~/.claude.json entry is safe on TWO conditions, both
      // of which must hold: (1) the plugin was just installed successfully in
      // THIS run, so its registration is known-good, and (2) the env block was
      // written, so the plugin's ${NEXUSMIND_*} placeholders can actually
      // resolve. Only then is the plugin a complete replacement for the entry.
      if (envWritten) {
        success('NexusMind plugin installed — hooks, MCP server, and skills are now active')
        if (removeLegacyClaudeJsonEntry(claudeJsonPath)) {
          info(`Removed the now-duplicate MCP registration from ${claudeJsonPath} (the plugin registers NexusMind itself)`)
        }
        return
      }

      // Degraded: the plugin is installed (so hooks DO work), but its
      // ${NEXUSMIND_API_KEY} / ${NEXUSMIND_BASE_URL} placeholders cannot resolve
      // because the env block could not be written. The MCP server therefore
      // needs a literal-valued direct entry to work at all. Never report plain
      // success here, and never return without at least one working registration.
      warn(`Plugin installed (hooks are active), but the env block could not be written to ${claudeSettingsPath}.`)
      log('  The plugin\'s ${NEXUSMIND_API_KEY} / ${NEXUSMIND_BASE_URL} placeholders cannot resolve without it,')
      log(`  so MCP credentials fall back to a direct entry in ${claudeJsonPath}.`)
      if (hasLegacyClaudeJsonEntry(claudeJsonPath)) {
        info(`Keeping the existing direct entry in ${claudeJsonPath} — it holds the only working credentials.`)
      } else if (writeClaudeJsonMcpEntry(apiKey, baseUrl, claudeJsonPath)) {
        success(`MCP server → ${claudeJsonPath}`)
      }
      return
    }
    warn('Plugin install failed — falling back to a direct MCP registration (no lifecycle hooks).')
  } else {
    info('claude CLI not found on PATH — registering the MCP server directly')
  }

  installClaudeCodeFallback(apiKey, baseUrl, claudeJsonPath)
}

// Fallback used when the `claude` CLI is unavailable or the plugin install
// fails: register the MCP server directly (as before 0.8.3), and point the
// user at the manual plugin-install commands. Without the plugin there are NO
// lifecycle hooks (session-start/stop/etc.) — only the MCP tools are available.
function installClaudeCodeFallback(apiKey: string, baseUrl: string, claudeJsonPath: string) {
  if (writeClaudeJsonMcpEntry(apiKey, baseUrl, claudeJsonPath)) {
    success(`MCP server → ${claudeJsonPath}`)
  }
  log('')
  warn('Without the plugin, Claude Code has no lifecycle hooks — only the MCP tools are available.')
  log('  To install the plugin manually, inside Claude Code run:')
  log(`    ${c.cyan}/plugin marketplace add ${GITHUB_REPO}${c.reset}`)
  log(`    ${c.cyan}/plugin install ${PLUGIN_KEY}${c.reset}`)
  log(`  then remove the direct entry: ${c.cyan}claude mcp remove nexusmind${c.reset}`)
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

  writeEnvVars(apiKey, baseUrl)
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
  // camelCase — matches Codex's hooks.json schema (hookEventName,
  // additionalContext, …). The old snake_case `command_windows` was silently
  // ignored, so on Windows Codex fell back to `command` and could not spawn it.
  commandWindows: string
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
  // The compiled hooks are ES modules (`import ... from './_helpers.js'`), but
  // they live outside this package under a bare .js extension. Without a
  // package.json declaring `"type": "module"` in the runtime dir, Node treats
  // them as CommonJS and every hook crashes at load with
  // "SyntaxError: Cannot use import statement outside a module" (exit 1), which
  // Codex surfaces as a hook error. This marker makes Node load them as ESM.
  writeFileSync(join(destDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n')
  return true
}

// Resolves an existing path to its 8.3 short form on Windows (e.g.
// C:\Program Files -> C:\PROGRA~1), which contains no spaces. Uses the
// FileSystemObject via PowerShell — the `cmd for %~sI` form mangles quoting when
// spawned. Returns the input unchanged on non-Windows, on failure, or when 8.3
// generation is disabled (the short form still contains a space). Memoized since
// the node binary and hook-runtime dir repeat across all six hooks.
const shortPathCache = new Map<string, string>()
function windowsShortPath(p: string): string {
  if (process.platform !== 'win32') return p
  const cached = shortPathCache.get(p)
  if (cached !== undefined) return cached
  let result = p
  try {
    const ps = '$p=$env:NM_SHORTPATH_IN; $f=New-Object -ComObject Scripting.FileSystemObject;'
      + ' if (Test-Path -LiteralPath $p -PathType Container) { $f.GetFolder($p).ShortPath }'
      + ' else { $f.GetFile($p).ShortPath }'
    const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      env: { ...process.env, NM_SHORTPATH_IN: p },
    })
    const short = (res.stdout ?? '').trim()
    if (short && !short.includes(' ')) result = short
  } catch { /* keep original */ }
  shortPathCache.set(p, result)
  return result
}

const quoteIfNeeded = (p: string) => (p.includes(' ') ? `"${p}"` : p)

// Builds the Codex hook command. Two reasons the previous version failed to
// launch on Windows: (1) the Windows override was written as `command_windows`
// (snake_case), which Codex ignores — the field is `commandWindows`; (2) Codex
// spawns the command directly (no shell) and does not reliably honor quotes
// around a program path containing spaces, so `"C:\Program Files\nodejs\
// node.exe" …` never started and Codex reported the hook as failed. The Windows
// command uses 8.3 short paths (space-free) so it tokenizes unambiguously; the
// runtime dir is shortened once and the (space-free) script filename appended.
// The script path points at the stable hook-runtime copy (see copyHookRuntime())
// rather than THIS_DIR — under npx, THIS_DIR resolves inside the npx cache,
// which can later be wiped, breaking the hook with "Cannot find module".
function hookCommand(scriptFile: string): CodexHookDef {
  const nodeBin    = process.execPath
  const hooksDir   = join(hookRuntimeDir(), 'hooks')
  const scriptPath = join(hooksDir, scriptFile)
  const posix      = `"${nodeBin}" "${scriptPath}"`
  const winNode    = quoteIfNeeded(windowsShortPath(nodeBin))
  const winScript  = quoteIfNeeded(join(windowsShortPath(hooksDir), scriptFile))
  return {
    type: 'command',
    command: posix,
    commandWindows: `${winNode} ${winScript}`,
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
  writeEnvVars(apiKey, baseUrl)

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

  // Confirm clients can actually launch the server via npx (and self-heal a
  // corrupted npx cache) — the cache-corruption failure otherwise surfaces only
  // as an opaque MCP handshake error in the client, with no hint of the cause.
  if (doClaude || doCursor || doCodex) {
    verifyAndRepairNpxLaunch()
    log('')
  }

  // Verify the key we just configured actually works — turns a silent
  // "Invalid API key" failure later (inside the client) into immediate,
  // actionable feedback here.
  if (apiKey) {
    log(`${c.bold}Verifying credentials…${c.reset}`)
    const result = await verifyCredentials(apiKey, baseUrl)
    if (result.ok) {
      success(`API key is valid against ${baseUrl}`)
    } else if (result.reason === 'unauthorized') {
      error(`The configured API key was rejected by ${baseUrl} (HTTP 401).`)
      log('  Double-check the key you entered — it does not match any key on the backend.')
    } else if (result.reason === 'unreachable') {
      warn(`Could not reach ${baseUrl} to verify the key — check the backend URL / your network.`)
    } else {
      warn(`Could not verify the key: ${result.message}`)
    }
    log('')
  }

  // Stale-env guard (Windows especially): setx / rc-file edits only affect
  // processes started AFTER setup runs. If a DIFFERENT key was already live in
  // this environment, every already-open client (Codex, Cursor, Claude) is
  // still holding it and will keep sending the OLD key until fully restarted —
  // which surfaces as "Invalid API key" even though config on disk is correct.
  if (envKey && apiKey && envKey !== apiKey) {
    warn(`A different NEXUSMIND_API_KEY (${maskKey(envKey)}) is already active in this environment.`)
    log(`  The new key is ${maskKey(apiKey)}. Windows does not update programs that are already running.`)
    log(`  ${c.bold}Fully quit Codex/Cursor/Claude and reopen them from the Start menu${c.reset} (not from an`)
    log('  existing terminal) so they pick up the new key. Run `npx @smart-coder-labs/nexusmind-mcp doctor`')
    log('  after restarting to confirm.')
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
