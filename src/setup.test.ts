import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { copyHookRuntime, installCodexHooks, removeLegacyClaudeJsonEntry } from './setup.js'

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
