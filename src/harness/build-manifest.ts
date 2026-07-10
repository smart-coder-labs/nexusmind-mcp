// buildManifestFromPath(path, format, targets, source) — design.md §6.
//
// Reads local files at `path`, computes sha256 + size_bytes per component,
// inlines content up to 64KiB per component, runs the local secret scanner
// and REFUSES the entire build on any hit (never inlines or hashes the
// offending content into a returned artifact), and assembles a manifest
// matching the backend's `validate_typed_harness_manifest` shape exactly —
// `kind: "file" | "folder" | "plugin_marketplace" | "theme_json"` component
// discriminator, `provenance.source`, `security.requires_approval`, and
// `security.executable` for hook / claude_code_plugin formats. This mirrors
// apps/backend/src/models/types.rs so `publish_harness_version` never 422s on
// a clean input built here (task 3.10 cross-check).
//
// Reuses the same relative-path/no-".." discipline as harness/materialize.ts:
// this module only ever reads from `path` (never writes), and manifest-facing
// paths are always POSIX-style forward-slash relative paths regardless of
// host OS, matching validate_safe_manifest_path's expectations server-side.

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'

import type { HarnessFormat, HarnessTarget } from '../client.js'
import { scanForSecrets, type SecretFinding } from './secret-scan.js'

const INLINE_LIMIT_BYTES = 64 * 1024

export interface BuiltManifestComponent {
  kind: 'file' | 'folder' | 'plugin_marketplace' | 'theme_json'
  path: string
  media_type?: string
  size_bytes?: number
  sha256?: string
  content?: string
  executable?: boolean
  entries?: BuiltManifestComponent[]
  [key: string]: unknown
}

export interface BuiltManifest {
  schema_version: '1.1'
  format: HarnessFormat
  targets: HarnessTarget[]
  components: BuiltManifestComponent[]
  provenance: { source: string }
  security: {
    requires_approval: true
    executable?: boolean
    secret_scan_status: 'passed'
  }
}

export interface BuildManifestResult {
  refused: boolean
  manifest?: BuiltManifest
  /** Human-readable refusal reason (size limit, format mismatch, etc). Never contains a secret value. */
  reason?: string
  /** Present when refused due to a secret-scan hit. Never contains the matched secret value. */
  secretFindings?: SecretFinding[]
}

const EXECUTABLE_FORMATS: HarnessFormat[] = ['hook', 'claude_code_plugin']

function mediaTypeFor(format: HarnessFormat, path: string): string {
  if (format === 'claude_code_plugin' || format === 'theme') return 'application/json'
  if (format === 'hook') return 'text/x-shellscript'
  if (path.endsWith('.json')) return 'application/json'
  return 'text/markdown'
}

function componentKindFor(format: HarnessFormat): 'file' | 'plugin_marketplace' | 'theme_json' {
  if (format === 'claude_code_plugin') return 'plugin_marketplace'
  if (format === 'theme') return 'theme_json'
  return 'file'
}

/** Convert an OS-specific relative path to the POSIX-style form the backend expects. */
function toManifestPath(p: string): string {
  return p.split(/[\\/]+/).filter(Boolean).join('/')
}

interface WalkedFile {
  /** manifest-relative path, POSIX-style, relative to the build root */
  relativePath: string
  absolutePath: string
  content: string
}

async function walk(root: string, current: string, out: WalkedFile[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const abs = join(current, entry.name)
    if (entry.isDirectory()) {
      await walk(root, abs, out)
    } else if (entry.isFile()) {
      const content = await readFile(abs, 'utf8')
      out.push({ relativePath: toManifestPath(relative(root, abs)), absolutePath: abs, content })
    }
  }
}

async function collectFiles(path: string): Promise<{ root: string; files: WalkedFile[]; isDir: boolean }> {
  const st = await stat(path)
  if (st.isDirectory()) {
    const files: WalkedFile[] = []
    await walk(path, path, files)
    return { root: path, files, isDir: true }
  }
  const content = await readFile(path, 'utf8')
  return {
    root: path,
    files: [{ relativePath: basename(path), absolutePath: path, content }],
    isDir: false,
  }
}

function sha256Of(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex')
}

export async function buildManifestFromPath(
  path: string,
  format: HarnessFormat,
  targets: HarnessTarget[],
  source: string,
): Promise<BuildManifestResult> {
  const { files, isDir } = await collectFiles(path)

  // Step: size limit check (refuse, never truncate) BEFORE secret scanning so
  // an oversized file is reported clearly rather than scanned unnecessarily.
  for (const file of files) {
    const sizeBytes = Buffer.byteLength(file.content)
    if (sizeBytes > INLINE_LIMIT_BYTES) {
      return {
        refused: true,
        reason: `component "${file.relativePath}" exceeds the 64KiB inline limit (${sizeBytes} bytes) — refused, not truncated`,
      }
    }
  }

  // Step: secret scan every file. Any hit refuses the ENTIRE build — no
  // partial manifest, and findings never carry the raw matched value.
  const allFindings: SecretFinding[] = []
  for (const file of files) {
    allFindings.push(...scanForSecrets(file.relativePath, file.content))
  }
  if (allFindings.length > 0) {
    const categories = [...new Set(allFindings.map(f => f.category))]
    const filesWithHits = [...new Set(allFindings.map(f => f.file))]
    return {
      refused: true,
      reason: `secret scan detected ${allFindings.length} finding(s) in [${filesWithHits.join(', ')}] (categories: ${categories.join(', ')}) — refusing to build manifest`,
      secretFindings: allFindings,
    }
  }

  const executable = EXECUTABLE_FORMATS.includes(format)

  let components: BuiltManifestComponent[]
  if (isDir) {
    // Folder component (e.g. `skill` format) with per-file entries. Entry
    // paths are prefixed with the folder's own manifest path (matching the
    // backend fixture: folder "skills/reviewer" -> entry
    // "skills/reviewer/SKILL.md"), not bare file names.
    const folderPath = toManifestPath(basename(path))
    const entries: BuiltManifestComponent[] = files.map(file => ({
      kind: 'file',
      path: `${folderPath}/${file.relativePath}`,
      media_type: mediaTypeFor(format, file.relativePath),
      size_bytes: Buffer.byteLength(file.content),
      sha256: sha256Of(file.content),
      content: file.content,
      ...(executable ? { executable: true } : {}),
    }))
    components = [{ kind: 'folder', path: folderPath, entries }]
  } else {
    const file = files[0]
    components = [{
      kind: componentKindFor(format),
      path: file.relativePath,
      media_type: mediaTypeFor(format, file.relativePath),
      size_bytes: Buffer.byteLength(file.content),
      sha256: sha256Of(file.content),
      content: file.content,
      ...(executable ? { executable: true } : {}),
    }]
  }

  const manifest: BuiltManifest = {
    schema_version: '1.1',
    format,
    targets,
    components,
    provenance: { source },
    security: {
      requires_approval: true,
      ...(executable ? { executable: true } : {}),
      secret_scan_status: 'passed',
    },
  }

  return { refused: false, manifest }
}
