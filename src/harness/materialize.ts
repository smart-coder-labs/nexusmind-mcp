// applyPlan(diff) -> { written, skipped, errors }
//
// The ONLY module in this feature that opens files for writing (design.md §1,
// §5). Never imported by plan.ts. Rules enforced here:
//
//  1. Path-traversal defense (defense-in-depth): reject any relative_path
//     containing ".." segments or an absolute path, and reject any resolved
//     destination that escapes the tool root after realpath resolution.
//     Refuse the WHOLE apply if any entry fails — no partial write.
//  2. sha256 verification: recompute sha256 of inline content and assert it
//     equals the manifest component sha256 before writing.
//  3. Atomicity: write to a sibling temp file then rename into place; mkdir -p
//     parents first; chmod 0o755 when executable, else 0o644.
//  4. settings.json merges: read-modify-write, idempotent, same temp+rename.
//  5. Reporting: return exactly what was written/skipped/errored — never file
//     contents.

import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

import type { DiffEntry } from './plan.js'

export interface WrittenEntry {
  destination: string
  action: 'create' | 'overwrite'
  size_bytes: number
}

export interface SkippedEntry {
  destination: string
  reason: 'unchanged'
}

export interface ErrorEntry {
  destination: string
  message: string
}

export interface ApplyPlanResult {
  written: WrittenEntry[]
  skipped: SkippedEntry[]
  errors: ErrorEntry[]
}

export interface ApplyPlanOptions {
  /** The tool's destination root (design.md §5 "tool root") — writes must resolve inside this dir. */
  root: string
}

function sha256Of(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex')
}

/**
 * Validate a diff entry's relative_path and destination against traversal.
 * Returns a validation error message, or undefined if the entry is safe.
 * Pure/sync — no fs access beyond string checks, so this can run as a
 * pre-flight over ALL entries before any write is attempted.
 */
function validateNoTraversal(entry: DiffEntry, root: string): string | undefined {
  if (entry.relative_path.includes('..')) {
    return `path traversal rejected: relative_path "${entry.relative_path}" contains ".."`
  }
  if (isAbsolute(entry.relative_path)) {
    return `path traversal rejected: relative_path "${entry.relative_path}" is absolute`
  }
  if (isAbsolute(entry.destination) === false) {
    return `destination must be an absolute path, got "${entry.destination}"`
  }
  const normalizedRoot = root.endsWith(sep) ? root : root + sep
  if (!entry.destination.startsWith(normalizedRoot) && entry.destination !== root) {
    return `path traversal rejected: destination "${entry.destination}" escapes tool root "${root}"`
  }
  return undefined
}

/** Resolve the real path of the nearest existing ancestor of `p`, plus the non-existent suffix re-appended. */
async function realpathNearestAncestor(p: string): Promise<string> {
  let existing = p
  const missingSegments: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break // reached filesystem root without finding an existing ancestor
    missingSegments.unshift(existing.slice(parent.length + 1))
    existing = parent
  }
  const realExisting = await realpath(existing)
  return missingSegments.length > 0 ? join(realExisting, ...missingSegments) : realExisting
}

/**
 * Post-resolution check: resolve real paths (following symlinks) for both the
 * tool root and the destination's parent dir — neither may exist yet — and
 * assert the real destination is still inside the real root. Catches
 * symlink-escape attacks that string checks alone miss (e.g. a symlinked
 * subdirectory of the root pointing outside it).
 */
async function assertRealpathWithinRoot(destination: string, root: string): Promise<string | undefined> {
  try {
    const realRoot = await realpathNearestAncestor(root)
    const destDir = dirname(destination)
    const realDestDir = await realpathNearestAncestor(destDir)
    const realRootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep
    if (!realDestDir.startsWith(realRootWithSep) && realDestDir !== realRoot) {
      return `path traversal rejected: destination "${destination}" resolves outside tool root (symlink escape)`
    }
    return undefined
  } catch (err) {
    return `failed to resolve real path for "${destination}": ${(err as Error).message}`
  }
}

async function atomicWrite(destination: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  const tmpPath = `${destination}.nm-tmp-${randomBytes(6).toString('hex')}`
  await writeFile(tmpPath, content, { mode })
  try {
    await rename(tmpPath, destination)
  } catch (err) {
    await rm(tmpPath, { force: true })
    throw err
  }
  // rename() does not always propagate mode bits reliably across all
  // platforms/filesystems (e.g. if destination pre-existed with different
  // perms); enforce the intended mode explicitly.
  await chmod(destination, mode)
}

async function mergeSettings(settingsPath: string, key: string, entry: Record<string, unknown>): Promise<void> {
  let existing: Record<string, unknown> = {}
  try {
    const raw = await readFile(settingsPath, 'utf8')
    existing = JSON.parse(raw)
  } catch {
    existing = {}
  }
  const list = Array.isArray(existing[key]) ? (existing[key] as Record<string, unknown>[]) : []
  const alreadyPresent = list.some(item => JSON.stringify(item) === JSON.stringify(entry))
  const nextList = alreadyPresent ? list : [...list, entry]
  const next = { ...existing, [key]: nextList }
  await atomicWrite(settingsPath, JSON.stringify(next, null, 2), 0o644)
}

export async function applyPlan(diff: DiffEntry[], options: ApplyPlanOptions): Promise<ApplyPlanResult> {
  const { root } = options
  const errors: ErrorEntry[] = []

  // Pre-flight: validate every entry before writing anything. Any failure
  // aborts the whole apply with zero writes (no partial write on a poisoned
  // manifest).
  for (const entry of diff) {
    const traversalError = validateNoTraversal(entry, root)
    if (traversalError) {
      errors.push({ destination: entry.destination, message: traversalError })
      continue
    }
    if (entry.action !== 'skip') {
      const contentSha = entry.content !== undefined ? sha256Of(entry.content) : undefined
      if (contentSha !== undefined && contentSha !== entry.sha256) {
        errors.push({
          destination: entry.destination,
          message: `sha256 mismatch: recomputed content hash does not match manifest component sha256`,
        })
      }
    }
  }

  if (errors.length > 0) {
    return { written: [], skipped: [], errors }
  }

  // Symlink-escape check requires touching the filesystem; run after the
  // sync pre-flight so obvious poisoning is caught cheaply first.
  // NOTE: this is the last check before writes begin below — there is a
  // narrow check-then-write (TOCTOU) window between here and the actual
  // write loop. Accepted as a known follow-up: exploiting it requires
  // concurrent local write access to this same tool root.
  for (const entry of diff) {
    if (entry.action === 'skip') continue
    const symlinkError = await assertRealpathWithinRoot(entry.destination, root)
    if (symlinkError) {
      errors.push({ destination: entry.destination, message: symlinkError })
    }
    if (entry.settingsMerge) {
      const settingsMergeError = await assertRealpathWithinRoot(entry.settingsMerge.settingsPath, root)
      if (settingsMergeError) {
        errors.push({ destination: entry.settingsMerge.settingsPath, message: settingsMergeError })
      }
    }
  }

  if (errors.length > 0) {
    return { written: [], skipped: [], errors }
  }

  const written: WrittenEntry[] = []
  const skipped: SkippedEntry[] = []

  for (const entry of diff) {
    if (entry.action === 'skip') {
      skipped.push({ destination: entry.destination, reason: 'unchanged' })
      continue
    }

    try {
      const mode = entry.executable ? 0o755 : 0o644
      await atomicWrite(entry.destination, entry.content ?? '', mode)
      written.push({
        destination: entry.destination,
        action: entry.action === 'overwrite' ? 'overwrite' : 'create',
        size_bytes: entry.size_bytes,
      })

      if (entry.settingsMerge) {
        await mergeSettings(entry.settingsMerge.settingsPath, entry.settingsMerge.key, entry.settingsMerge.entry)
      }
    } catch (err) {
      errors.push({ destination: entry.destination, message: (err as Error).message })
    }
  }

  return { written, skipped, errors }
}
