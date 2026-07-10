import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { applyPlan } from './materialize.js'
import type { DiffEntry } from './plan.js'

// materialize.ts is the ONLY module in this feature that opens files for
// writing (design.md §1, §5). These tests exercise it against a real temp
// directory (no fs mocks) so the path-traversal, sha256, and atomicity
// guarantees are verified against actual filesystem behavior.

function sha256Of(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex')
}

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'nm-materialize-test-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function baseEntry(root: string, overrides: Partial<DiffEntry> & { content: string }): DiffEntry & { content: string } {
  const content = overrides.content
  return {
    destination: join(root, 'agents', 'foo.md'),
    relative_path: 'foo.md',
    action: 'create',
    sha256: sha256Of(content),
    size_bytes: Buffer.byteLength(content),
    executable: false,
    ...overrides,
  } as DiffEntry & { content: string }
}

// ── Path-traversal defense ───────────────────────────────────────────────────

test('applyPlan rejects a relative_path containing ".." and writes nothing', async () => {
  await withTempRoot(async root => {
    const entry = baseEntry(root, {
      relative_path: '../../etc/passwd',
      destination: join(root, '..', '..', 'etc', 'passwd'),
      content: 'evil',
    })
    const result = await applyPlan([entry], { root })
    assert.equal(result.written.length, 0)
    assert.ok(result.errors.length >= 1)
    assert.match(result.errors[0].message, /traversal|escap|\.\./i)
  })
})

test('applyPlan rejects an absolute relative_path and writes nothing', async () => {
  await withTempRoot(async root => {
    const entry = baseEntry(root, {
      relative_path: '/etc/passwd',
      destination: '/etc/passwd',
      content: 'evil',
    })
    const result = await applyPlan([entry], { root })
    assert.equal(result.written.length, 0)
    assert.ok(result.errors.length >= 1)
  })
})

test('applyPlan rejects a destination that resolves outside the tool root (symlink escape)', async () => {
  await withTempRoot(async root => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'nm-materialize-outside-'))
    try {
      await mkdir(root, { recursive: true })
      const linkPath = join(root, 'escape-link')
      await symlink(outsideDir, linkPath, 'dir')

      const entry = baseEntry(root, {
        relative_path: 'escape-link/pwned.md',
        destination: join(root, 'escape-link', 'pwned.md'),
        content: 'evil',
      })
      const result = await applyPlan([entry], { root })
      assert.equal(result.written.length, 0)
      assert.ok(result.errors.length >= 1)

      await assert.rejects(() => stat(join(outsideDir, 'pwned.md')))
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})

test('applyPlan refuses the whole apply with no partial writes when one entry is poisoned', async () => {
  await withTempRoot(async root => {
    const good = baseEntry(root, {
      relative_path: 'good.md',
      destination: join(root, 'good.md'),
      content: 'hello',
    })
    const poisoned = baseEntry(root, {
      relative_path: '../evil.md',
      destination: join(root, '..', 'evil.md'),
      content: 'evil',
    })
    const result = await applyPlan([good, poisoned], { root })
    assert.equal(result.written.length, 0)
    await assert.rejects(() => readFile(join(root, 'good.md')))
  })
})

test('applyPlan rejects a settingsMerge.settingsPath that escapes the tool root and writes nothing', async () => {
  await withTempRoot(async root => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'nm-materialize-outside-'))
    try {
      const entry = baseEntry(root, {
        relative_path: 'hooks/pre-commit.sh',
        destination: join(root, 'hooks', 'pre-commit.sh'),
        content: '#!/bin/sh\necho hook',
        executable: true,
      })
      ;(entry as any).settingsMerge = {
        settingsPath: join(outsideDir, 'settings.json'),
        key: 'hooks',
        entry: { name: 'pre-commit', command: join(root, 'hooks', 'pre-commit.sh') },
      }

      const result = await applyPlan([entry], { root })
      assert.equal(result.written.length, 0)
      assert.ok(result.errors.length >= 1)
      assert.match(result.errors[0].message, /traversal|escap/i)

      await assert.rejects(() => stat(join(outsideDir, 'settings.json')))
      await assert.rejects(() => stat(join(root, 'hooks', 'pre-commit.sh')))
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})

// ── sha256 verification ──────────────────────────────────────────────────────

test('applyPlan aborts when recomputed sha256 does not match the manifest component sha256', async () => {
  await withTempRoot(async root => {
    const entry = baseEntry(root, { relative_path: 'foo.md', destination: join(root, 'foo.md'), content: 'real content' })
    entry.sha256 = sha256Of('tampered content') // mismatch
    const result = await applyPlan([entry], { root })
    assert.equal(result.written.length, 0)
    assert.ok(result.errors.length >= 1)
    assert.match(result.errors[0].message, /sha256|hash|mismatch/i)
    await assert.rejects(() => readFile(join(root, 'foo.md')))
  })
})

test('applyPlan writes successfully when sha256 matches', async () => {
  await withTempRoot(async root => {
    const entry = baseEntry(root, { relative_path: 'foo.md', destination: join(root, 'foo.md'), content: 'real content' })
    const result = await applyPlan([entry], { root })
    assert.equal(result.errors.length, 0)
    assert.equal(result.written.length, 1)
    const written = await readFile(join(root, 'foo.md'), 'utf8')
    assert.equal(written, 'real content')
  })
})

// ── Atomicity + chmod ─────────────────────────────────────────────────────────

test('applyPlan creates parent directories (mkdir -p) before writing', async () => {
  await withTempRoot(async root => {
    const entry = baseEntry(root, {
      relative_path: 'nested/dir/foo.md',
      destination: join(root, 'nested', 'dir', 'foo.md'),
      content: 'nested content',
    })
    const result = await applyPlan([entry], { root })
    assert.equal(result.errors.length, 0)
    const written = await readFile(join(root, 'nested', 'dir', 'foo.md'), 'utf8')
    assert.equal(written, 'nested content')
  })
})

test('applyPlan does not leave a stray temp file after a successful write', async () => {
  await withTempRoot(async root => {
    const entry = baseEntry(root, { relative_path: 'foo.md', destination: join(root, 'foo.md'), content: 'hi' })
    await applyPlan([entry], { root })
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(root)
    assert.deepEqual(entries, ['foo.md'])
  })
})

test('applyPlan chmods 0o755 when executable is true (hook script)', async () => {
  await withTempRoot(async root => {
    const entry = baseEntry(root, {
      relative_path: 'hook.sh', destination: join(root, 'hook.sh'), content: '#!/bin/sh\necho hi', executable: true,
    })
    await applyPlan([entry], { root })
    const s = await stat(join(root, 'hook.sh'))
    // POSIX permission bits don't exist on Windows (chmod is effectively a
    // no-op there), so the executable-bit assertion only applies on POSIX.
    if (process.platform !== 'win32') assert.equal(s.mode & 0o777, 0o755)
  })
})

test('applyPlan chmods 0o644 when executable is false', async () => {
  await withTempRoot(async root => {
    const entry = baseEntry(root, { relative_path: 'foo.md', destination: join(root, 'foo.md'), content: 'hi', executable: false })
    await applyPlan([entry], { root })
    const s = await stat(join(root, 'foo.md'))
    // POSIX permission bits don't exist on Windows; skip the mode assertion there.
    if (process.platform !== 'win32') assert.equal(s.mode & 0o777, 0o644)
  })
})

// ── skip action ───────────────────────────────────────────────────────────────

test('applyPlan skips entries whose action is "skip" (unchanged content) without writing', async () => {
  await withTempRoot(async root => {
    const entry = baseEntry(root, { relative_path: 'foo.md', destination: join(root, 'foo.md'), content: 'hi', action: 'skip' })
    const result = await applyPlan([entry], { root })
    assert.equal(result.written.length, 0)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].reason, 'unchanged')
    await assert.rejects(() => readFile(join(root, 'foo.md')))
  })
})

// ── settings.json merge (hook/plugin registration) ───────────────────────────

test('applyPlan merges a hook entry into settings.json idempotently via temp+rename', async () => {
  await withTempRoot(async root => {
    const settingsPath = join(root, 'settings.json')
    await mkdir(root, { recursive: true })
    await (await import('node:fs/promises')).writeFile(settingsPath, JSON.stringify({ existingKey: 'keep-me' }))

    const entry = baseEntry(root, {
      relative_path: 'hooks/pre-commit.sh',
      destination: join(root, 'hooks', 'pre-commit.sh'),
      content: '#!/bin/sh\necho hook',
      executable: true,
      warning: 'installs an executable hook',
    })
    ;(entry as any).settingsMerge = {
      settingsPath,
      key: 'hooks',
      entry: { name: 'pre-commit', command: join(root, 'hooks', 'pre-commit.sh') },
    }

    const result = await applyPlan([entry], { root })
    assert.equal(result.errors.length, 0)

    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    assert.equal(settings.existingKey, 'keep-me')
    assert.ok(Array.isArray(settings.hooks))
    assert.equal(settings.hooks.length, 1)
    assert.equal(settings.hooks[0].name, 'pre-commit')

    // Re-applying the same entry must be idempotent (no duplicate hook registration).
    const result2 = await applyPlan([entry], { root })
    assert.equal(result2.errors.length, 0)
    const settingsAfterSecond = JSON.parse(await readFile(settingsPath, 'utf8'))
    assert.equal(settingsAfterSecond.hooks.length, 1)
  })
})

test('applyPlan creates settings.json from scratch when it does not exist yet', async () => {
  await withTempRoot(async root => {
    const settingsPath = join(root, 'settings.json')
    const entry = baseEntry(root, {
      relative_path: 'plugins/my-plugin.json',
      destination: join(root, 'plugins', 'my-plugin.json'),
      content: '{"name":"my-plugin"}',
      warning: 'registers a plugin',
    })
    ;(entry as any).settingsMerge = {
      settingsPath,
      key: 'plugins',
      entry: { name: 'my-plugin', path: join(root, 'plugins', 'my-plugin.json') },
    }

    const result = await applyPlan([entry], { root })
    assert.equal(result.errors.length, 0)
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    assert.equal(settings.plugins.length, 1)
  })
})
