import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildManifestFromPath } from './build-manifest.js'
import { validateTypedHarnessManifest } from './manifest-validator.js'

// Cross-check (tasks.md 3.10): a manifest produced by buildManifestFromPath
// must pass the backend's `validate_typed_harness_manifest` fixture/contract
// without a 422. `manifest-validator.ts` is a faithful TS port of
// apps/backend/src/models/types.rs::validate_typed_harness_manifest, kept in
// this test file's dependency graph ONLY to assert alignment — it is not
// used by any production code path (the real backend re-validates on
// publish; this is a local safety net so drift is caught here first).

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'nm-manifest-crosscheck-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a manifest built from a single agent file passes validate_typed_harness_manifest', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'reviewer.md')
    await writeFile(filePath, '# Agent', 'utf8')
    const result = await buildManifestFromPath(filePath, 'agent', ['claude'], 'admin-ui')
    assert.equal(result.refused, false)
    assert.equal(validateTypedHarnessManifest(result.manifest!), 'ok')
  })
})

test('a manifest built from a skill folder passes validate_typed_harness_manifest', async () => {
  await withTempDir(async dir => {
    const skillDir = join(dir, 'reviewer')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: reviewer\n---', 'utf8')
    const result = await buildManifestFromPath(skillDir, 'skill', ['claude'], 'admin-ui')
    assert.equal(result.refused, false)
    assert.equal(validateTypedHarnessManifest(result.manifest!), 'ok')
  })
})

test('a manifest built from a hook script passes validate_typed_harness_manifest', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'pre-commit.sh')
    await writeFile(filePath, '#!/bin/sh\nexit 0', 'utf8')
    const result = await buildManifestFromPath(filePath, 'hook', ['claude'], 'admin-ui')
    assert.equal(result.refused, false)
    assert.equal(validateTypedHarnessManifest(result.manifest!), 'ok')
  })
})

test('a manifest built from a claude_code_plugin json passes validate_typed_harness_manifest', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'plugin.json')
    await writeFile(filePath, JSON.stringify({ name: 'reviewer' }), 'utf8')
    const result = await buildManifestFromPath(filePath, 'claude_code_plugin', ['claude'], 'admin-ui')
    assert.equal(result.refused, false)
    assert.equal(validateTypedHarnessManifest(result.manifest!), 'ok')
  })
})

test('a manifest built from a theme json passes validate_typed_harness_manifest', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'dark.json')
    await writeFile(filePath, JSON.stringify({ name: 'Dark' }), 'utf8')
    const result = await buildManifestFromPath(filePath, 'theme', ['claude'], 'admin-ui')
    assert.equal(result.refused, false)
    assert.equal(validateTypedHarnessManifest(result.manifest!), 'ok')
  })
})

test('a manifest built targeting cursor passes validate_typed_harness_manifest', async () => {
  await withTempDir(async dir => {
    const filePath = join(dir, 'agent.md')
    await writeFile(filePath, '# Agent', 'utf8')
    const result = await buildManifestFromPath(filePath, 'agent', ['cursor'], 'admin-ui')
    assert.equal(result.refused, false)
    assert.equal(validateTypedHarnessManifest(result.manifest!), 'ok')
  })
})
