import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveDestinationRoot, isSupportedPair, resolveComponentDestination } from './resolver.js'

// Pure-function unit tests for the format→tool applicability matrix + per-tool
// destination resolver (design.md §2). No I/O — these functions never touch fs.

const PROJECT_ROOT = '/repo'

test('resolveDestinationRoot: claude user scope is ~/.claude', () => {
  assert.equal(resolveDestinationRoot('claude', 'user'), join(homedir(), '.claude'))
})

test('resolveDestinationRoot: claude project scope is <cwd>/.claude', () => {
  assert.equal(resolveDestinationRoot('claude', 'project', PROJECT_ROOT), join(PROJECT_ROOT, '.claude'))
})

test('resolveDestinationRoot: codex user scope is ~/.codex', () => {
  assert.equal(resolveDestinationRoot('codex', 'user'), join(homedir(), '.codex'))
})

test('resolveDestinationRoot: cursor user scope is ~/.cursor', () => {
  assert.equal(resolveDestinationRoot('cursor', 'user'), join(homedir(), '.cursor'))
})

test('resolveDestinationRoot: cursor project scope is <cwd>/.cursor', () => {
  assert.equal(resolveDestinationRoot('cursor', 'project', PROJECT_ROOT), join(PROJECT_ROOT, '.cursor'))
})

// ── Applicability matrix ─────────────────────────────────────────────────────

test('isSupportedPair: all formats supported for claude', () => {
  const formats = ['agent', 'skill', 'command', 'hook', 'output_style', 'claude_code_plugin', 'theme'] as const
  for (const format of formats) {
    assert.equal(isSupportedPair(format, 'claude'), true, `expected claude to support ${format}`)
  }
})

test('isSupportedPair: codex supports only agent and command', () => {
  assert.equal(isSupportedPair('agent', 'codex'), true)
  assert.equal(isSupportedPair('command', 'codex'), true)
  assert.equal(isSupportedPair('skill', 'codex'), false)
  assert.equal(isSupportedPair('hook', 'codex'), false)
  assert.equal(isSupportedPair('output_style', 'codex'), false)
  assert.equal(isSupportedPair('claude_code_plugin', 'codex'), false)
  assert.equal(isSupportedPair('theme', 'codex'), false)
})

test('isSupportedPair: cursor supports only agent and claude_code_plugin', () => {
  assert.equal(isSupportedPair('agent', 'cursor'), true)
  assert.equal(isSupportedPair('claude_code_plugin', 'cursor'), true)
  assert.equal(isSupportedPair('skill', 'cursor'), false)
  assert.equal(isSupportedPair('command', 'cursor'), false)
  assert.equal(isSupportedPair('hook', 'cursor'), false)
  assert.equal(isSupportedPair('output_style', 'cursor'), false)
  assert.equal(isSupportedPair('theme', 'cursor'), false)
})

// ── Per-component destination resolution ─────────────────────────────────────

test('resolveComponentDestination: claude agent -> ~/.claude/agents/<name>.md', () => {
  const dest = resolveComponentDestination({
    format: 'agent', tool: 'claude', scope: 'user', relativePath: 'foo.md',
  })
  assert.equal(dest.destination, join(homedir(), '.claude', 'agents', 'foo.md'))
  assert.equal(dest.requiresSettingsMerge, false)
})

test('resolveComponentDestination: claude skill folder entry preserves relative subpath under skills/<name>/', () => {
  const dest = resolveComponentDestination({
    format: 'skill', tool: 'claude', scope: 'user', relativePath: 'my-skill/SKILL.md',
  })
  assert.equal(dest.destination, join(homedir(), '.claude', 'skills', 'my-skill', 'SKILL.md'))
})

test('resolveComponentDestination: claude command -> ~/.claude/commands/<name>.md', () => {
  const dest = resolveComponentDestination({
    format: 'command', tool: 'claude', scope: 'user', relativePath: 'ship-it.md',
  })
  assert.equal(dest.destination, join(homedir(), '.claude', 'commands', 'ship-it.md'))
})

test('resolveComponentDestination: claude hook -> ~/.claude/hooks/<name>.sh and requires settings merge', () => {
  const dest = resolveComponentDestination({
    format: 'hook', tool: 'claude', scope: 'user', relativePath: 'pre-commit.sh',
  })
  assert.equal(dest.destination, join(homedir(), '.claude', 'hooks', 'pre-commit.sh'))
  assert.equal(dest.requiresSettingsMerge, true)
  assert.equal(dest.settingsPath, join(homedir(), '.claude', 'settings.json'))
})

test('resolveComponentDestination: claude output_style -> ~/.claude/output-styles/<name>.md', () => {
  const dest = resolveComponentDestination({
    format: 'output_style', tool: 'claude', scope: 'user', relativePath: 'terse.md',
  })
  assert.equal(dest.destination, join(homedir(), '.claude', 'output-styles', 'terse.md'))
})

test('resolveComponentDestination: claude claude_code_plugin -> plugins/ dir + requires settings merge', () => {
  const dest = resolveComponentDestination({
    format: 'claude_code_plugin', tool: 'claude', scope: 'user', relativePath: 'my-plugin.json',
  })
  assert.equal(dest.destination, join(homedir(), '.claude', 'plugins', 'my-plugin.json'))
  assert.equal(dest.requiresSettingsMerge, true)
  assert.equal(dest.settingsPath, join(homedir(), '.claude', 'settings.json'))
})

test('resolveComponentDestination: claude theme -> ~/.claude/themes/<name>.json', () => {
  const dest = resolveComponentDestination({
    format: 'theme', tool: 'claude', scope: 'user', relativePath: 'dark.json',
  })
  assert.equal(dest.destination, join(homedir(), '.claude', 'themes', 'dark.json'))
})

test('resolveComponentDestination: codex agent -> ~/.codex/agents/<name>.md (conservative default)', () => {
  const dest = resolveComponentDestination({
    format: 'agent', tool: 'codex', scope: 'user', relativePath: 'reviewer.md',
  })
  assert.equal(dest.destination, join(homedir(), '.codex', 'agents', 'reviewer.md'))
})

test('resolveComponentDestination: codex command -> ~/.codex/prompts/<name>.md (conservative default)', () => {
  const dest = resolveComponentDestination({
    format: 'command', tool: 'codex', scope: 'user', relativePath: 'ship-it.md',
  })
  assert.equal(dest.destination, join(homedir(), '.codex', 'prompts', 'ship-it.md'))
})

test('resolveComponentDestination: cursor agent -> ~/.cursor/rules/<name>.md (agent-as-rule)', () => {
  const dest = resolveComponentDestination({
    format: 'agent', tool: 'cursor', scope: 'user', relativePath: 'reviewer.md',
  })
  assert.equal(dest.destination, join(homedir(), '.cursor', 'rules', 'reviewer.md'))
})

test('resolveComponentDestination: cursor claude_code_plugin -> .cursor/mcp.json entry', () => {
  const dest = resolveComponentDestination({
    format: 'claude_code_plugin', tool: 'cursor', scope: 'project', relativePath: 'my-plugin.json', projectRoot: PROJECT_ROOT,
  })
  assert.equal(dest.destination, join(PROJECT_ROOT, '.cursor', 'mcp.json'))
  assert.equal(dest.requiresSettingsMerge, true)
})

test('resolveComponentDestination: project scope substitutes repo-local root', () => {
  const dest = resolveComponentDestination({
    format: 'agent', tool: 'claude', scope: 'project', relativePath: 'foo.md', projectRoot: PROJECT_ROOT,
  })
  assert.equal(dest.destination, join(PROJECT_ROOT, '.claude', 'agents', 'foo.md'))
})

// ── Unsupported pairs refuse ──────────────────────────────────────────────────

test('resolveComponentDestination: unsupported format/tool pair throws with a clear reason', () => {
  assert.throws(
    () => resolveComponentDestination({ format: 'skill', tool: 'codex', scope: 'user', relativePath: 'foo/SKILL.md' }),
    /skill.*codex|Claude Code-only/i,
  )
})

test('resolveComponentDestination: hook + cursor is unsupported', () => {
  assert.throws(
    () => resolveComponentDestination({ format: 'hook', tool: 'cursor', scope: 'user', relativePath: 'foo.sh' }),
    /unsupported/i,
  )
})

test('resolveComponentDestination: command + cursor is unsupported (no stable slash-command dir)', () => {
  assert.throws(
    () => resolveComponentDestination({ format: 'command', tool: 'cursor', scope: 'user', relativePath: 'foo.md' }),
    /unsupported/i,
  )
})

test('resolveComponentDestination: output_style + codex is unsupported', () => {
  assert.throws(
    () => resolveComponentDestination({ format: 'output_style', tool: 'codex', scope: 'user', relativePath: 'foo.md' }),
    /unsupported/i,
  )
})

test('resolveComponentDestination: theme + cursor is unsupported', () => {
  assert.throws(
    () => resolveComponentDestination({ format: 'theme', tool: 'cursor', scope: 'user', relativePath: 'foo.json' }),
    /unsupported/i,
  )
})

test('resolveComponentDestination: claude_code_plugin + codex is unsupported', () => {
  assert.throws(
    () => resolveComponentDestination({ format: 'claude_code_plugin', tool: 'codex', scope: 'user', relativePath: 'foo.json' }),
    /unsupported/i,
  )
})
