import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildManifestFromPath } from './build-manifest.js'

// buildManifestFromPath(path, format, targets, source) — design.md §6.
//
// 1. Walk `path` (file -> single component; dir -> folder walk).
// 2. sha256 + size_bytes per file.
// 3. Inline content <= 64KiB; refuse (not truncate) above that.
// 4. Refuse entirely on any secret-scan hit — no partial manifest.
// 5. Assemble a valid schema_version "1.1" manifest matching the backend's
//    `validate_typed_harness_manifest` component-kind expectations (kind:
//    "file" | "folder" | "plugin_marketplace" | "theme_json").

function sha256Of(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex')
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'nm-build-manifest-test-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('buildManifestFromPath builds a valid schema-1.1 manifest for a single agent file', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'reviewer.md')
    await writeFile(filePath, '# Reviewer Agent\n\nDoes reviews.', 'utf8')

    const result = await buildManifestFromPath(filePath, 'agent', ['claude'], 'test-source')

    assert.equal(result.refused, false)
    const manifest = result.manifest!
    assert.equal(manifest.schema_version, '1.1')
    assert.equal(manifest.format, 'agent')
    assert.deepEqual(manifest.targets, ['claude'])
    assert.equal(manifest.provenance?.source, 'test-source')
    assert.equal(manifest.security?.requires_approval, true)
    assert.equal(manifest.security?.secret_scan_status, 'passed')
    assert.equal(manifest.components.length, 1)
    const component = manifest.components[0] as any
    assert.equal(component.kind, 'file')
    assert.equal(component.path, 'reviewer.md')
    assert.equal(component.media_type, 'text/markdown')
    const content = '# Reviewer Agent\n\nDoes reviews.'
    assert.equal(component.sha256, sha256Of(content))
    assert.equal(component.size_bytes, Buffer.byteLength(content))
    assert.equal(component.content, content)
  })
})

test('buildManifestFromPath cursor is accepted as a target', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'reviewer.md')
    await writeFile(filePath, '# Reviewer', 'utf8')
    const result = await buildManifestFromPath(filePath, 'agent', ['cursor'], 'test-source')
    assert.equal(result.refused, false)
    assert.deepEqual(result.manifest!.targets, ['cursor'])
  })
})

test('buildManifestFromPath walks a skill folder into a folder component with entries', async () => {
  await withTempDir(async dir => {
    const skillDir = join(dir, 'my-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: my-skill\n---\nBody', 'utf8')

    const result = await buildManifestFromPath(skillDir, 'skill', ['claude'], 'test-source')
    assert.equal(result.refused, false)
    const manifest = result.manifest!
    assert.equal(manifest.components.length, 1)
    const folder = manifest.components[0] as any
    assert.equal(folder.kind, 'folder')
    assert.equal(folder.path, 'my-skill')
    assert.ok(Array.isArray(folder.entries))
    assert.equal(folder.entries.length, 1)
    assert.equal(folder.entries[0].kind, 'file')
    assert.equal(folder.entries[0].path, 'my-skill/SKILL.md')
  })
})

test('buildManifestFromPath refuses a file exceeding 64KiB with no silent truncation', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'huge.md')
    const bigContent = 'a'.repeat(64 * 1024 + 1)
    await writeFile(filePath, bigContent, 'utf8')

    const result = await buildManifestFromPath(filePath, 'agent', ['claude'], 'test-source')
    assert.equal(result.refused, true)
    assert.equal(result.manifest, undefined)
    assert.match(result.reason ?? '', /64\s*ki?b|size|too large/i)
  })
})

test('buildManifestFromPath refuses entirely on a secret-scan hit with no partial manifest', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'agent.md')
    await writeFile(filePath, 'token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz01"', 'utf8')

    const result = await buildManifestFromPath(filePath, 'agent', ['claude'], 'test-source')
    assert.equal(result.refused, true)
    assert.equal(result.manifest, undefined)
    assert.ok(result.secretFindings && result.secretFindings.length >= 1)
    // Refusal reason must never leak the actual secret value.
    assert.doesNotMatch(JSON.stringify(result), /ghp_1234567890abcdefghijklmnopqrstuvwxyz01/)
  })
})

test('buildManifestFromPath produces a claude_code_plugin manifest with plugin_marketplace kind and executable=true', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'plugin.json')
    await writeFile(filePath, JSON.stringify({ name: 'reviewer' }), 'utf8')

    const result = await buildManifestFromPath(filePath, 'claude_code_plugin', ['claude'], 'test-source')
    assert.equal(result.refused, false)
    const manifest = result.manifest!
    assert.equal(manifest.security?.executable, true)
    const component = manifest.components[0] as any
    assert.equal(component.kind, 'plugin_marketplace')
    assert.equal(component.media_type, 'application/json')
  })
})

test('buildManifestFromPath produces a hook manifest with executable component flag', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'pre-commit.sh')
    await writeFile(filePath, '#!/bin/sh\nexit 0', 'utf8')

    const result = await buildManifestFromPath(filePath, 'hook', ['claude'], 'test-source')
    assert.equal(result.refused, false)
    const manifest = result.manifest!
    assert.equal(manifest.security?.executable, true)
    const component = manifest.components[0] as any
    assert.equal(component.kind, 'file')
    assert.equal(component.executable, true)
  })
})
