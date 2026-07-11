import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { spawnSync } from 'node:child_process'

import { copyHookRuntime, installClaudeCode, installCodexHooks, installNexusmindPlugin, removeLegacyClaudeJsonEntry, writeClaudeSettingsEnv } from './setup.js'

// Stubs the spawnSync-shaped dependency `installNexusmindPlugin` / `installClaudeCode`
// accept for injection, so tests never actually spawn a `claude` process or touch the
// real machine. Each call in `responses` is consumed in order; extra calls fall back
// to a synthetic success so an unexpectedly-long call chain doesn't crash the stub.
function makeSpawnStub(responses: Array<{ status: number | null; error?: Error }>): {
  spawn: typeof spawnSync
  calls: string[][]
} {
  const calls: string[][] = []
  let i = 0
  const spawn = ((cmd: string, args: readonly string[] = []) => {
    calls.push([cmd, ...args])
    const res = responses[i] ?? { status: 0 }
    i++
    return res
  }) as unknown as typeof spawnSync
  return { spawn, calls }
}

// Captures everything the log/info/warn/success helpers print (they all go
// through console.log) so tests can assert on user-facing guidance.
function captureConsole<T>(fn: () => T): { result: T; output: string } {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  try {
    const result = fn()
    return { result, output: lines.join('\n') }
  } finally {
    console.log = original
  }
}

// installed_plugins.json shaped so isNexusmindPluginInstalled() returns true.
function writeInstalledPluginsJson(path: string) {
  writeFileSync(path, JSON.stringify({ plugins: { 'nexusmind@nexusmind': [{ version: '1.0.0' }] } }))
}

const HOOK_FILES = ['_helpers.js', 'session-start.js', 'user-prompt-submit.js', 'pre-compact.js', 'post-compact.js', 'stop.js']

// Builds a fake "dist" directory shaped like the real compiled output
// (client.js at the top, hooks/*.js alongside it) without requiring a build.
function makeFakeDistDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-dist-'))
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  writeFileSync(join(dir, 'client.js'), '// fake client\nexport const marker = "client";\n')
  for (const f of HOOK_FILES) {
    writeFileSync(join(dir, 'hooks', f), `// fake ${f}\n`)
  }
  return dir
}

function withTempDirs<T>(fn: (dirs: { sourceDir: string; destDir: string }) => T): T {
  const sourceDir = makeFakeDistDir()
  const destDir = mkdtempSync(join(tmpdir(), 'nexusmind-runtime-'))
  try {
    return fn({ sourceDir, destDir })
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(destDir, { recursive: true, force: true })
  }
}

test('copyHookRuntime copies client.js and all hook files preserving relative layout', () => {
  withTempDirs(({ sourceDir, destDir }) => {
    const ok = copyHookRuntime(sourceDir, destDir)
    assert.equal(ok, true)
    assert.equal(existsSync(join(destDir, 'client.js')), true)
    for (const f of HOOK_FILES) {
      assert.equal(existsSync(join(destDir, 'hooks', f)), true, `missing ${f}`)
    }
    assert.equal(
      readFileSync(join(destDir, 'client.js'), 'utf8'),
      readFileSync(join(sourceDir, 'client.js'), 'utf8'),
    )
  })
})

test('copyHookRuntime writes a package.json marking the runtime dir as ESM', () => {
  withTempDirs(({ sourceDir, destDir }) => {
    copyHookRuntime(sourceDir, destDir)
    const pkgPath = join(destDir, 'package.json')
    assert.equal(existsSync(pkgPath), true, 'missing package.json — hooks would load as CJS and crash')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    assert.equal(pkg.type, 'module')
  })
})

test('copyHookRuntime overwrites an existing destination on every call (recopy, no diff/merge)', () => {
  withTempDirs(({ sourceDir, destDir }) => {
    mkdirSync(join(destDir, 'hooks'), { recursive: true })
    writeFileSync(join(destDir, 'client.js'), 'stale content')
    copyHookRuntime(sourceDir, destDir)
    assert.notEqual(readFileSync(join(destDir, 'client.js'), 'utf8'), 'stale content')
  })
})

test('copyHookRuntime returns false and does not throw when the source dist dir is missing files', () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'nexusmind-missing-'))
  const destDir = mkdtempSync(join(tmpdir(), 'nexusmind-runtime-'))
  try {
    const ok = copyHookRuntime(sourceDir, destDir)
    assert.equal(ok, false)
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(destDir, { recursive: true, force: true })
  }
})

test('installCodexHooks points every hook command at the stable hook-runtime dir, not the source dist dir', () => {
  const sourceDir = makeFakeDistDir()
  const codexHome = mkdtempSync(join(tmpdir(), 'nexusmind-codexhome-'))
  const hookRuntime = mkdtempSync(join(tmpdir(), 'nexusmind-hookruntime-'))
  const prevCodexHome = process.env.CODEX_HOME
  const prevHookRuntimeDir = process.env.NEXUSMIND_HOOK_RUNTIME_DIR
  process.env.CODEX_HOME = codexHome
  process.env.NEXUSMIND_HOOK_RUNTIME_DIR = hookRuntime
  try {
    installCodexHooks(sourceDir)

    // The stable copy itself must exist.
    assert.equal(existsSync(join(hookRuntime, 'client.js')), true)
    assert.equal(existsSync(join(hookRuntime, 'hooks', 'stop.js')), true)

    const hooksJson = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'))
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostCompact', 'Stop', 'SubagentStop']) {
      const groups = hooksJson.hooks[event]
      assert.ok(Array.isArray(groups) && groups.length > 0, `missing hooks for ${event}`)
      const command: string = groups[groups.length - 1].hooks[0].command
      assert.ok(command.includes(hookRuntime), `${event} command does not point at hook-runtime dir: ${command}`)
      assert.ok(!command.includes(sourceDir), `${event} command still points at source dist dir: ${command}`)
    }
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodexHome
    if (prevHookRuntimeDir === undefined) delete process.env.NEXUSMIND_HOOK_RUNTIME_DIR
    else process.env.NEXUSMIND_HOOK_RUNTIME_DIR = prevHookRuntimeDir
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(codexHome, { recursive: true, force: true })
    rmSync(hookRuntime, { recursive: true, force: true })
  }
})

test('installCodexHooks is idempotent — re-running does not duplicate hook entries', () => {
  const sourceDir = makeFakeDistDir()
  const codexHome = mkdtempSync(join(tmpdir(), 'nexusmind-codexhome-'))
  const hookRuntime = mkdtempSync(join(tmpdir(), 'nexusmind-hookruntime-'))
  const prevCodexHome = process.env.CODEX_HOME
  const prevHookRuntimeDir = process.env.NEXUSMIND_HOOK_RUNTIME_DIR
  process.env.CODEX_HOME = codexHome
  process.env.NEXUSMIND_HOOK_RUNTIME_DIR = hookRuntime
  try {
    installCodexHooks(sourceDir)
    installCodexHooks(sourceDir)

    const hooksJson = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'))
    const stopGroups = hooksJson.hooks['Stop']
    const totalStopHooks = stopGroups.reduce((n: number, g: { hooks: unknown[] }) => n + g.hooks.length, 0)
    assert.equal(totalStopHooks, 1)
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodexHome
    if (prevHookRuntimeDir === undefined) delete process.env.NEXUSMIND_HOOK_RUNTIME_DIR
    else process.env.NEXUSMIND_HOOK_RUNTIME_DIR = prevHookRuntimeDir
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(codexHome, { recursive: true, force: true })
    rmSync(hookRuntime, { recursive: true, force: true })
  }
})

test('removeLegacyClaudeJsonEntry removes the nexusmind entry and preserves other mcpServers keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-claudejson-'))
  const path = join(dir, '.claude.json')
  try {
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        nexusmind: { command: 'npx', args: ['-y', '@smart-coder-labs/nexusmind-mcp@latest'] },
        other: { command: 'npx', args: ['-y', 'some-other-server'] },
      },
      someOtherTopLevelKey: 'preserve-me',
    }, null, 2))

    const removed = removeLegacyClaudeJsonEntry(path)
    assert.equal(removed, true)

    const written = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal('nexusmind' in written.mcpServers, false)
    assert.deepEqual(written.mcpServers.other, { command: 'npx', args: ['-y', 'some-other-server'] })
    assert.equal(written.someOtherTopLevelKey, 'preserve-me')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('removeLegacyClaudeJsonEntry returns false and leaves an invalid-JSON file untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-claudejson-'))
  const path = join(dir, '.claude.json')
  const original = '{ this is not valid json'
  try {
    writeFileSync(path, original)
    const removed = removeLegacyClaudeJsonEntry(path)
    assert.equal(removed, false)
    assert.equal(readFileSync(path, 'utf8'), original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('removeLegacyClaudeJsonEntry returns false when there is nothing to remove', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-claudejson-'))
  const path = join(dir, '.claude.json')
  try {
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: 'npx' } } }))
    const removed = removeLegacyClaudeJsonEntry(path)
    assert.equal(removed, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── installNexusmindPlugin ───────────────────────────────────────────────────

test('installNexusmindPlugin returns false when marketplace add fails, and does not attempt plugin install', () => {
  const { spawn, calls } = makeSpawnStub([{ status: 1 }])
  const ok = installNexusmindPlugin(spawn)
  assert.equal(ok, false)
  assert.equal(calls.length, 1, 'plugin install must not run after marketplace add failed')
  assert.deepEqual(calls[0], ['claude', 'plugin', 'marketplace', 'add', 'smart-coder-labs/nexusmind-claude-plugin', '--scope', 'user'])
})

test('installNexusmindPlugin returns false when plugin install fails', () => {
  const { spawn, calls } = makeSpawnStub([{ status: 0 }, { status: 1 }])
  const ok = installNexusmindPlugin(spawn)
  assert.equal(ok, false)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], ['claude', 'plugin', 'install', 'nexusmind@nexusmind', '--scope', 'user'])
})

test('installNexusmindPlugin returns true when both marketplace add and plugin install succeed', () => {
  const { spawn, calls } = makeSpawnStub([{ status: 0 }, { status: 0 }])
  const ok = installNexusmindPlugin(spawn)
  assert.equal(ok, true)
  assert.equal(calls.length, 2)
})

// ── installClaudeCode ────────────────────────────────────────────────────────

test('installClaudeCode installs the plugin and removes the legacy ~/.claude.json entry on success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-installclaude-'))
  const claudeJsonPath = join(dir, '.claude.json')
  const claudeSettingsPath = join(dir, 'settings.json')
  const installedPluginsPath = join(dir, 'installed_plugins.json') // absent -> plugin not (yet) installed
  writeFileSync(claudeJsonPath, JSON.stringify({
    mcpServers: { nexusmind: { command: 'npx' }, other: { command: 'npx' } },
  }))
  try {
    // 1st call = `claude --version` (CLI availability check), 2nd/3rd = marketplace add / plugin install
    const { spawn, calls } = makeSpawnStub([{ status: 0 }, { status: 0 }, { status: 0 }])
    installClaudeCode('nm_key', 'http://localhost:8080', { spawn, claudeJsonPath, claudeSettingsPath, installedPluginsPath, rcFiles: [] })

    assert.equal(calls.length, 3, 'expected a CLI availability check plus the two plugin-install steps')
    assert.deepEqual(calls[0], ['claude', '--version'])

    const written = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    assert.equal('nexusmind' in written.mcpServers, false, 'legacy duplicate entry must be removed after plugin install')
    assert.deepEqual(written.mcpServers.other, { command: 'npx' }, 'unrelated mcpServers entries must survive')

    // The plugin's own .mcp.json uses ${NEXUSMIND_API_KEY}/${NEXUSMIND_BASE_URL}
    // placeholders. Those resolve from ~/.claude/settings.json's env block — NOT
    // from shell rc files, which frequently do not exist. Removing the legacy
    // literal-valued entry above is only safe because this block was written.
    const settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf8'))
    assert.equal(settings.env.NEXUSMIND_API_KEY, 'nm_key')
    assert.equal(settings.env.NEXUSMIND_BASE_URL, 'http://localhost:8080')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The reason the ordering above matters: with no ~/.zshrc (common on macOS — the
// user's own machine has neither .zshrc nor .bashrc), writeShellEnv writes
// nothing, so the ONLY place holding real credential values is the legacy
// ~/.claude.json entry. Deleting it before/without a working env source would
// leave the plugin's ${...} placeholders unresolvable and break the MCP server
// entirely. If the env write fails, the legacy entry MUST survive.
test('installClaudeCode keeps the legacy entry when the settings env block cannot be written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-installclaude-envfail-'))
  const claudeJsonPath = join(dir, '.claude.json')
  const claudeSettingsPath = join(dir, 'settings.json')
  const installedPluginsPath = join(dir, 'installed_plugins.json')
  writeFileSync(claudeJsonPath, JSON.stringify({
    mcpServers: { nexusmind: { command: 'npx', env: { NEXUSMIND_API_KEY: 'nm_real_literal_key' } } },
  }))
  // Unparseable settings.json -> writeClaudeSettingsEnv must refuse and return false.
  writeFileSync(claudeSettingsPath, '{ not valid json')
  try {
    const { spawn } = makeSpawnStub([{ status: 0 }, { status: 0 }, { status: 0 }])
    captureConsole(() =>
      installClaudeCode('nm_key', 'http://localhost:8080', { spawn, claudeJsonPath, claudeSettingsPath, installedPluginsPath, rcFiles: [] }),
    )

    const written = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    assert.equal(
      'nexusmind' in written.mcpServers,
      true,
      'env block write failed — the legacy entry is the only working registration left and must NOT be deleted',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The degraded case: the plugin installs fine (so hooks work), but the env block
// cannot be written AND there is no legacy entry to fall back on. Without an
// explicit fallback here the user ends up with a registered plugin whose
// ${NEXUSMIND_*} placeholders resolve to nothing and NO MCP registration at all.
// Invariant: installClaudeCode must never return leaving zero working registrations.
test('installClaudeCode falls back to a literal ~/.claude.json entry when the env write fails and no legacy entry exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-installclaude-envfail-nolegacy-'))
  const claudeJsonPath = join(dir, '.claude.json')
  const claudeSettingsPath = join(dir, 'settings.json')
  const installedPluginsPath = join(dir, 'installed_plugins.json')
  writeFileSync(claudeJsonPath, JSON.stringify({}))       // no legacy entry
  writeFileSync(claudeSettingsPath, '{ not valid json')   // env write will fail
  try {
    const { spawn } = makeSpawnStub([{ status: 0 }, { status: 0 }, { status: 0 }])
    const { output } = captureConsole(() =>
      installClaudeCode('nm_testkey', 'http://localhost:8080', { spawn, claudeJsonPath, claudeSettingsPath, installedPluginsPath, rcFiles: [] }),
    )

    const written = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    assert.equal(
      written.mcpServers?.nexusmind?.env?.NEXUSMIND_API_KEY,
      'nm_testkey',
      'env block unwritable and no legacy entry — a literal-valued direct registration must be written, or the user has none at all',
    )
    assert.ok(
      !output.includes('hooks, MCP server, and skills are now active'),
      'must not claim unqualified success while the MCP credentials are in a degraded fallback state',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── writeClaudeSettingsEnv ───────────────────────────────────────────────────

test('writeClaudeSettingsEnv creates the env block when absent and preserves unrelated settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-settings-'))
  const settingsPath = join(dir, 'settings.json')
  try {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [] }, model: 'opus' }))

    const ok = captureConsole(() => writeClaudeSettingsEnv('nm_key', 'http://localhost:8080', settingsPath)).result
    assert.equal(ok, true)

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.equal(settings.env.NEXUSMIND_API_KEY, 'nm_key')
    assert.equal(settings.env.NEXUSMIND_BASE_URL, 'http://localhost:8080')
    assert.equal(settings.model, 'opus', 'unrelated top-level settings must survive')
    assert.deepEqual(settings.hooks, { SessionStart: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeClaudeSettingsEnv merges into an existing env block without clobbering other vars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-settings-'))
  const settingsPath = join(dir, 'settings.json')
  try {
    writeFileSync(settingsPath, JSON.stringify({
      env: { SOME_OTHER_VAR: 'keep-me', NEXUSMIND_BASE_URL: 'http://old-url' },
    }))

    const ok = captureConsole(() => writeClaudeSettingsEnv('nm_new', 'http://new-url', settingsPath)).result
    assert.equal(ok, true)

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.equal(settings.env.SOME_OTHER_VAR, 'keep-me', 'unrelated env vars must survive')
    assert.equal(settings.env.NEXUSMIND_BASE_URL, 'http://new-url', 'our vars must be updated in place')
    assert.equal(settings.env.NEXUSMIND_API_KEY, 'nm_new')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeClaudeSettingsEnv creates the settings file (and its directory) when missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-settings-'))
  const settingsPath = join(dir, 'nested', 'settings.json')
  try {
    const ok = captureConsole(() => writeClaudeSettingsEnv('nm_key', 'http://localhost:8080', settingsPath)).result
    assert.equal(ok, true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.equal(settings.env.NEXUSMIND_API_KEY, 'nm_key')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeClaudeSettingsEnv omits NEXUSMIND_API_KEY when no key was provided', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-settings-'))
  const settingsPath = join(dir, 'settings.json')
  try {
    const ok = captureConsole(() => writeClaudeSettingsEnv('', 'http://localhost:8080', settingsPath)).result
    assert.equal(ok, true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.equal('NEXUSMIND_API_KEY' in settings.env, false)
    assert.equal(settings.env.NEXUSMIND_BASE_URL, 'http://localhost:8080')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeClaudeSettingsEnv refuses to touch an unparseable settings.json and returns false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-settings-'))
  const settingsPath = join(dir, 'settings.json')
  const original = '{ this is not valid json'
  try {
    writeFileSync(settingsPath, original)
    const ok = captureConsole(() => writeClaudeSettingsEnv('nm_key', 'http://localhost:8080', settingsPath)).result
    assert.equal(ok, false)
    assert.equal(readFileSync(settingsPath, 'utf8'), original, 'a corrupt settings.json must never be silently reset')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The "plugin already installed" branch trusts installed_plugins.json, which can be
// stale or broken (it records what was installed, not that the plugin still works).
// Deleting the user's ~/.claude.json fallback registration on the strength of that
// record alone could leave them with NO working MCP registration at all — so this
// branch must only WARN. Automatic removal is safe ONLY on the branch where we just
// installed the plugin ourselves in this run and have fresh proof it worked.
test('installClaudeCode only warns (never deletes) the legacy entry when the plugin was already installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-installclaude-preinstalled-'))
  const claudeJsonPath = join(dir, '.claude.json')
  const claudeSettingsPath = join(dir, 'settings.json')
  const installedPluginsPath = join(dir, 'installed_plugins.json')
  writeInstalledPluginsJson(installedPluginsPath)
  writeFileSync(claudeJsonPath, JSON.stringify({
    mcpServers: { nexusmind: { command: 'npx' }, other: { command: 'npx' } },
  }))
  try {
    const { spawn, calls } = makeSpawnStub([])
    const { output } = captureConsole(() =>
      installClaudeCode('nm_key', 'http://localhost:8080', { spawn, claudeJsonPath, claudeSettingsPath, installedPluginsPath, rcFiles: [] }),
    )

    assert.equal(calls.length, 0, 'no CLI call should happen when the plugin is already installed')

    const written = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    assert.equal(
      'nexusmind' in written.mcpServers,
      true,
      'a stale installed_plugins.json record must NOT cause the user\'s working fallback registration to be deleted',
    )
    assert.ok(output.includes('claude mcp remove nexusmind'), 'user must be told how to remove the duplicate manually')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('installClaudeCode does not warn or write when the plugin is already installed and there is no legacy entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-installclaude-preinstalled-clean-'))
  const claudeJsonPath = join(dir, '.claude.json')
  const claudeSettingsPath = join(dir, 'settings.json')
  const installedPluginsPath = join(dir, 'installed_plugins.json')
  writeInstalledPluginsJson(installedPluginsPath)
  const original = JSON.stringify({ mcpServers: { other: { command: 'npx' } } })
  writeFileSync(claudeJsonPath, original)
  try {
    const { spawn, calls } = makeSpawnStub([])
    const { output } = captureConsole(() =>
      installClaudeCode('nm_key', 'http://localhost:8080', { spawn, claudeJsonPath, claudeSettingsPath, installedPluginsPath, rcFiles: [] }),
    )

    assert.equal(calls.length, 0)
    assert.equal(readFileSync(claudeJsonPath, 'utf8'), original, 'nothing to remove — the file must not be rewritten')
    assert.ok(!output.includes('claude mcp remove nexusmind'), 'no duplicate present — must not warn about one')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Same invariant, same hole, on the already-installed branch: if the env block
// cannot be written and there is no legacy entry, the plugin's placeholders are
// unresolvable and nothing else is registered. Writing the direct entry here is
// purely additive (it is never a deletion), so the warn-only rule about NOT
// deleting the duplicate is untouched.
test('installClaudeCode writes the fallback entry when the plugin is already installed but the env write fails and no legacy entry exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-installclaude-preinstalled-envfail-'))
  const claudeJsonPath = join(dir, '.claude.json')
  const claudeSettingsPath = join(dir, 'settings.json')
  const installedPluginsPath = join(dir, 'installed_plugins.json')
  writeInstalledPluginsJson(installedPluginsPath)
  writeFileSync(claudeJsonPath, JSON.stringify({}))       // no legacy entry
  writeFileSync(claudeSettingsPath, '{ not valid json')   // env write will fail
  try {
    const { spawn } = makeSpawnStub([])
    captureConsole(() =>
      installClaudeCode('nm_testkey', 'http://localhost:8080', { spawn, claudeJsonPath, claudeSettingsPath, installedPluginsPath, rcFiles: [] }),
    )

    const written = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    assert.equal(
      written.mcpServers?.nexusmind?.env?.NEXUSMIND_API_KEY,
      'nm_testkey',
      'plugin present but its placeholders cannot resolve and nothing else is registered — a literal fallback entry is required',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The duplicate-removal advice is only correct when the plugin can actually
// resolve its credentials. With no env block, the direct entry is the ONLY thing
// that works — telling the user to remove it would break them.
test('installClaudeCode does not advise removing the direct entry when the env block could not be written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-installclaude-preinstalled-envfail-legacy-'))
  const claudeJsonPath = join(dir, '.claude.json')
  const claudeSettingsPath = join(dir, 'settings.json')
  const installedPluginsPath = join(dir, 'installed_plugins.json')
  writeInstalledPluginsJson(installedPluginsPath)
  writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: { nexusmind: { command: 'npx' } } }))
  writeFileSync(claudeSettingsPath, '{ not valid json')
  try {
    const { spawn } = makeSpawnStub([])
    const { output } = captureConsole(() =>
      installClaudeCode('nm_key', 'http://localhost:8080', { spawn, claudeJsonPath, claudeSettingsPath, installedPluginsPath, rcFiles: [] }),
    )

    assert.ok(
      !output.includes('claude mcp remove nexusmind'),
      'without a working env block the direct entry is the only registration — must not tell the user to remove it',
    )
    const written = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    assert.equal('nexusmind' in written.mcpServers, true, 'and it must still be there')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('installClaudeCode falls back to writeClaudeJsonMcpEntry when the claude CLI is unavailable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-installclaude-fallback-'))
  const claudeJsonPath = join(dir, '.claude.json')
  const claudeSettingsPath = join(dir, 'settings.json')
  const installedPluginsPath = join(dir, 'installed_plugins.json')
  writeFileSync(claudeJsonPath, JSON.stringify({}))
  try {
    const { spawn, calls } = makeSpawnStub([{ status: null, error: new Error('claude: command not found') }])
    installClaudeCode('nm_testkey', 'http://localhost:8080', { spawn, claudeJsonPath, claudeSettingsPath, installedPluginsPath, rcFiles: [] })

    assert.equal(calls.length, 1, 'only the CLI availability check should run — no plugin install attempted')

    const written = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    assert.equal(written.mcpServers.nexusmind.env.NEXUSMIND_API_KEY, 'nm_testkey', 'fallback must register the MCP server directly')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('installClaudeCode falls back to writeClaudeJsonMcpEntry when the plugin install itself fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmind-installclaude-plugin-fail-'))
  const claudeJsonPath = join(dir, '.claude.json')
  const claudeSettingsPath = join(dir, 'settings.json')
  const installedPluginsPath = join(dir, 'installed_plugins.json')
  writeFileSync(claudeJsonPath, JSON.stringify({}))
  try {
    // CLI available, but `marketplace add` fails (e.g. a blocked interactive trust prompt)
    const { spawn, calls } = makeSpawnStub([{ status: 0 }, { status: 1 }])
    installClaudeCode('nm_testkey', 'http://localhost:8080', { spawn, claudeJsonPath, claudeSettingsPath, installedPluginsPath, rcFiles: [] })

    assert.equal(calls.length, 2)
    const written = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    assert.equal(written.mcpServers.nexusmind.env.NEXUSMIND_API_KEY, 'nm_testkey', 'fallback must run when plugin install fails')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
