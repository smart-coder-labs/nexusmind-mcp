// Faithful TS port of apps/backend/src/models/types.rs::validate_typed_harness_manifest
// (nexus-mind repo). Used ONLY by tests as a local cross-check that manifests
// produced by build-manifest.ts pass the real backend validator's rules
// (tasks.md task 3.10) — never imported by production tool-registration code.
// Keep this in sync with the Rust source if that validator changes; drift
// here is a test-only risk, not a production one (the backend re-validates
// independently on publish).

import type { BuiltManifest, BuiltManifestComponent } from './build-manifest.js'

const VALID_TARGETS = new Set(['claude', 'codex', 'cursor'])
const VALID_FORMATS = new Set([
  'agent', 'skill', 'command', 'hook', 'output_style', 'claude_code_plugin', 'theme',
])

function looksLikeWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path)
}

function validateSafeManifestPath(path: string): string | undefined {
  const lower = path.toLowerCase()
  if (
    path.trim() === '' ||
    path.startsWith('/') ||
    path.startsWith('~') ||
    looksLikeWindowsAbsolutePath(path) ||
    path.includes('..') ||
    lower.includes('/users/') ||
    lower.includes('\\users\\') ||
    lower.includes('.ssh') ||
    lower.includes('.env')
  ) {
    return 'unsafe_component_path'
  }
  return undefined
}

function validateSafeManifestContent(content: string): string | undefined {
  if (Buffer.byteLength(content) > 64 * 1024) return 'component_content_too_large'
  const lower = content.toLowerCase()
  if (
    lower.includes('raw-secret') ||
    lower.includes('bearer ') ||
    lower.includes('nm_live') ||
    lower.includes('ghp_') ||
    lower.includes('sk-') ||
    lower.includes('/users/')
  ) {
    return 'secret_scan_failed'
  }
  return undefined
}

function requireFileMetadata(value: BuiltManifestComponent): string | undefined {
  const mediaType = (value.media_type ?? '').trim()
  const sha256 = (value.sha256 ?? '').trim()
  if (value.size_bytes === undefined) return 'missing_component_metadata'
  if (mediaType === '' || sha256 === '') return 'missing_component_metadata'
  return undefined
}

function jsonContentIsObject(content: string): boolean {
  try {
    const parsed = JSON.parse(content)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}

function validateManifestComponent(format: string, component: BuiltManifestComponent): string | undefined {
  const kind = component.kind
  const path = component.path
  if (!kind) return 'missing_component_kind'
  if (!path) return 'missing_component_path'

  const pathErr = validateSafeManifestPath(path)
  if (pathErr) return pathErr

  if (typeof component.content === 'string') {
    const contentErr = validateSafeManifestContent(component.content)
    if (contentErr) return contentErr
  }

  if (kind === 'folder') {
    const entries = component.entries
    if (!entries || entries.length === 0) return 'missing_folder_entries'
    for (const entry of entries) {
      if (entry.kind !== 'file') return 'format_component_mismatch'
      if (!entry.path) return 'missing_component_path'
      const entryPathErr = validateSafeManifestPath(entry.path)
      if (entryPathErr) return entryPathErr
      const metaErr = requireFileMetadata(entry)
      if (metaErr) return metaErr
      if (typeof entry.content === 'string') {
        const entryContentErr = validateSafeManifestContent(entry.content)
        if (entryContentErr) return entryContentErr
      }
    }
  } else {
    const metaErr = requireFileMetadata(component)
    if (metaErr) return metaErr
  }

  const valid = (() => {
    switch (format) {
      case 'agent':
        return kind === 'file' && path.endsWith('.md')
      case 'skill':
        return (kind === 'file' && path.endsWith('.md')) || kind === 'folder'
      case 'command':
        return kind === 'file' && path.endsWith('.md')
      case 'hook':
        return kind === 'file' && path.endsWith('.sh')
      case 'output_style':
        return kind === 'file' && path.endsWith('.md')
      case 'claude_code_plugin':
        return (
          kind === 'plugin_marketplace' &&
          path.endsWith('.json') &&
          typeof component.content === 'string' &&
          jsonContentIsObject(component.content)
        )
      case 'theme':
        return (
          kind === 'theme_json' &&
          path.endsWith('.json') &&
          typeof component.content === 'string' &&
          jsonContentIsObject(component.content)
        )
      default:
        return false
    }
  })()
  if (!valid) return 'format_component_mismatch'

  return undefined
}

/** Returns 'ok' when the manifest validates, or the Rust-equivalent error code string. */
export function validateTypedHarnessManifest(manifest: BuiltManifest): string {
  if (manifest.schema_version !== '1.1') return 'unsupported_schema_version'

  const targets = manifest.targets
  if (!targets || targets.length === 0 || targets.some(t => !VALID_TARGETS.has(t))) {
    return 'missing_targets'
  }

  if (!manifest.format || !VALID_FORMATS.has(manifest.format)) return 'missing_format'

  const source = manifest.provenance?.source?.trim() ?? ''
  if (source === '') return 'missing_provenance'

  const security = manifest.security
  if (!security) return 'missing_security'
  if (security.requires_approval !== true) return 'approval_required'
  if ((security as any).secret_scan_status === 'failed') return 'secret_scan_failed'

  if ((manifest.format === 'hook' || manifest.format === 'claude_code_plugin') && security.executable !== true) {
    return 'executable_warning_required'
  }

  const components = manifest.components
  if (!components || components.length === 0) return 'missing_components'

  for (const component of components) {
    const err = validateManifestComponent(manifest.format, component)
    if (err) return err
  }

  return 'ok'
}
