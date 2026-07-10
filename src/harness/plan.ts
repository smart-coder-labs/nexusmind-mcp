// planInstall(manifest, tool, scope) -> DiffEntry[]
//
// This module imports only read + hash utilities (`node:fs/promises` readFile,
// `node:crypto` createHash) — it NEVER imports `./materialize.js` or any write
// primitive (`writeFile`, `rename`, `mkdir`). This is what makes writes
// structurally unreachable from the plan phase (design.md §1): the plan
// handler in index.ts only ever imports this module, and this module cannot
// write no matter what input it receives.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { HarnessFormat, HarnessManifest, HarnessManifestComponent, HarnessTarget, HarnessTargetScope } from '../client.js'
import { resolveComponentDestination } from './resolver.js'

export interface DiffEntry {
  /** ABSOLUTE resolved path, e.g. /Users/x/.claude/skills/foo/SKILL.md */
  destination: string
  /** manifest-relative path (traversal-checked), for display */
  relative_path: string
  action: 'create' | 'overwrite' | 'skip'
  /** manifest component sha256 (sha256:hex) */
  sha256: string
  /** on-disk sha256 if a file already exists */
  existing_sha256?: string
  size_bytes: number
  /** true -> chmod +x on write (hook .sh) */
  executable: boolean
  /** e.g. "installs an executable hook", "modifies settings.json" */
  warning?: string
  /** inline content carried through from the manifest component, for materialize.ts to write */
  content?: string
  /** present for hook/claude_code_plugin components that also require a settings.json (or mcp.json) merge */
  settingsMerge?: {
    settingsPath: string
    key: string
    entry: Record<string, unknown>
  }
}

export interface PlanInstallResult {
  format: HarnessFormat
  requires_acknowledgement: boolean
  warnings: string[]
  diff: DiffEntry[]
}

async function sha256OfFile(path: string): Promise<string | undefined> {
  try {
    const buf = await readFile(path)
    return 'sha256:' + createHash('sha256').update(buf).digest('hex')
  } catch {
    // File does not exist (or is unreadable) -> no existing_sha256, action = create.
    return undefined
  }
}

function flattenComponents(components: HarnessManifestComponent[]): HarnessManifestComponent[] {
  const out: HarnessManifestComponent[] = []
  for (const c of components) {
    if (c.kind === 'folder' && c.entries) {
      // Folder entries already carry their full manifest-relative path
      // (e.g. folder "my-skill" -> entry path "my-skill/SKILL.md", per
      // build-manifest.ts) — do not re-prefix with the folder's own path.
      out.push(...flattenComponents(c.entries))
    } else {
      out.push(c)
    }
  }
  return out
}

const EXECUTABLE_FORMATS: HarnessFormat[] = ['hook', 'claude_code_plugin']

export interface PlanInstallOptions {
  projectRoot?: string
}

export async function planInstall(
  manifest: HarnessManifest,
  tool: HarnessTarget,
  scope: HarnessTargetScope,
  options: PlanInstallOptions = {},
): Promise<PlanInstallResult> {
  const format = manifest.format
  const requiresAcknowledgement = EXECUTABLE_FORMATS.includes(format)
  const warnings: string[] = []
  const flatComponents = flattenComponents(manifest.components)

  const diff: DiffEntry[] = []
  for (const component of flatComponents) {
    const resolved = resolveComponentDestination({
      format,
      tool,
      scope,
      relativePath: component.path,
      projectRoot: options.projectRoot,
    })

    const existingSha256 = await sha256OfFile(resolved.destination)
    let action: DiffEntry['action']
    if (existingSha256 === undefined) {
      action = 'create'
    } else if (existingSha256 === component.sha256) {
      action = 'skip'
    } else {
      action = 'overwrite'
    }

    let warning: string | undefined
    if (requiresAcknowledgement) {
      warning = format === 'hook' ? 'installs an executable hook' : 'installs a Claude Code plugin (settings.json merge)'
    }
    if (resolved.requiresSettingsMerge && !warning) {
      warning = `modifies ${resolved.settingsPath ? resolved.settingsPath.split('/').pop() : 'settings.json'}`
    }
    if (warning && !warnings.includes(warning)) warnings.push(warning)

    let settingsMerge: DiffEntry['settingsMerge']
    if (resolved.requiresSettingsMerge && resolved.settingsPath) {
      const key = format === 'hook' ? 'hooks' : 'plugins'
      settingsMerge = {
        settingsPath: resolved.settingsPath,
        key,
        entry: { name: component.path, path: resolved.destination },
      }
    }

    diff.push({
      destination: resolved.destination,
      relative_path: component.path,
      action,
      sha256: component.sha256,
      existing_sha256: existingSha256,
      size_bytes: component.size_bytes,
      executable: component.executable === true,
      warning,
      content: component.content,
      settingsMerge,
    })
  }

  return { format, requires_acknowledgement: requiresAcknowledgement, warnings, diff }
}
