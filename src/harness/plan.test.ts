import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planInstall } from './plan.js'
import type { HarnessManifest } from '../client.js'

function sha256Of(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex')
}

function manifest(overrides: Partial<HarnessManifest> = {}): HarnessManifest {
  return {
    schema_version: '1.1',
    format: 'agent',
    targets: ['claude'],
    components: [
      { path: 'foo.md', kind: 'file', size_bytes: 5, sha256: sha256Of('hello'), content: 'hello' },
    ],
    ...overrides,
  }
}

test('planInstall: no existing file -> action "create"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nm-plan-test-'))
  try {
    const result = await planInstall(manifest(), 'claude', 'project', { projectRoot: dir })
    assert.equal(result.diff.length, 1)
    assert.equal(result.diff[0].action, 'create')
    assert.equal(result.diff[0].destination, join(dir, '.claude', 'agents', 'foo.md'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('planInstall: existing file with identical sha256 -> action "skip"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nm-plan-test-'))
  try {
    const destDir = join(dir, '.claude', 'agents')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'foo.md'), 'hello')
    const result = await planInstall(manifest(), 'claude', 'project', { projectRoot: dir })
    assert.equal(result.diff[0].action, 'skip')
    assert.equal(result.diff[0].existing_sha256, sha256Of('hello'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('planInstall: existing file with different sha256 -> action "overwrite"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nm-plan-test-'))
  try {
    const destDir = join(dir, '.claude', 'agents')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'foo.md'), 'stale content')
    const result = await planInstall(manifest(), 'claude', 'project', { projectRoot: dir })
    assert.equal(result.diff[0].action, 'overwrite')
    assert.equal(result.diff[0].existing_sha256, sha256Of('stale content'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('planInstall: hook/claude_code_plugin formats set requires_acknowledgement and a warning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nm-plan-test-'))
  try {
    const m = manifest({
      format: 'hook',
      components: [{ path: 'pre-commit.sh', kind: 'file', size_bytes: 4, sha256: sha256Of('run'), content: 'run', executable: true }],
    })
    const result = await planInstall(m, 'claude', 'project', { projectRoot: dir })
    assert.equal(result.requires_acknowledgement, true)
    assert.ok(result.warnings.length >= 1)
    assert.ok(result.diff[0].warning)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('planInstall: non-executable agent format does not require acknowledgement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nm-plan-test-'))
  try {
    const result = await planInstall(manifest(), 'claude', 'project', { projectRoot: dir })
    assert.equal(result.requires_acknowledgement, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('planInstall: refuses unsupported format/tool pair (propagates resolver error)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nm-plan-test-'))
  try {
    const m = manifest({ format: 'skill', components: [{ path: 'SKILL.md', kind: 'file', size_bytes: 5, sha256: sha256Of('hello'), content: 'hello' }] })
    await assert.rejects(() => planInstall(m, 'codex', 'project', { projectRoot: dir }), /unsupported/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('planInstall: writes nothing to disk (zero fs-mutation calls anywhere in the plan path)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nm-plan-test-'))
  try {
    await planInstall(manifest(), 'claude', 'project', { projectRoot: dir })
    // planInstall must not have created the destination dir/file as a side effect.
    assert.equal(existsSync(join(dir, '.claude')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('planInstall: folder component with kind-shaped entries produces one create diff entry per file (not a single folder-shaped entry)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nm-plan-test-'))
  try {
    const skillContent = '# Reviewer skill\n'
    const helperContent = '# Helper\n'
    const m = manifest({
      format: 'skill',
      components: [
        {
          kind: 'folder',
          path: 'skills/reviewer',
          entries: [
            {
              kind: 'file',
              path: 'skills/reviewer/SKILL.md',
              content: skillContent,
              sha256: sha256Of(skillContent),
              size_bytes: Buffer.byteLength(skillContent),
            },
            {
              kind: 'file',
              path: 'skills/reviewer/helper.md',
              content: helperContent,
              sha256: sha256Of(helperContent),
              size_bytes: Buffer.byteLength(helperContent),
            },
          ],
        },
      ],
    } as any)

    const result = await planInstall(m, 'claude', 'project', { projectRoot: dir })

    assert.equal(result.diff.length, 2, `expected 2 diff entries (one per file), got ${result.diff.length}`)
    const byPath = Object.fromEntries(result.diff.map(d => [d.relative_path, d]))
    assert.equal(byPath['skills/reviewer/SKILL.md'].action, 'create')
    assert.equal(byPath['skills/reviewer/SKILL.md'].sha256, sha256Of(skillContent))
    assert.equal(byPath['skills/reviewer/helper.md'].action, 'create')
    assert.equal(byPath['skills/reviewer/helper.md'].sha256, sha256Of(helperContent))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plan.ts never imports materialize.ts (static source check — writes structurally unreachable from plan)', () => {
  const source = readFileSync(new URL('./plan.ts', import.meta.url), 'utf8')
  // Strip comments before checking for real import/call statements, so
  // documentation prose mentioning "materialize.js" or "writeFile" (as it
  // legitimately does, to explain the guarantee) does not produce a false
  // positive on this static check.
  const codeOnly = source
    .split('\n')
    .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/**'))
    .join('\n')
  assert.doesNotMatch(codeOnly, /from ['"]\.\/materialize\.js['"]/)
  assert.doesNotMatch(codeOnly, /\bwriteFile\s*\(/)
  assert.doesNotMatch(codeOnly, /\brename\s*\(/)
  assert.doesNotMatch(codeOnly, /\bmkdir\s*\(/)
})
