// Per-tool destination resolver — the format→tool applicability matrix from
// design.md §2. Pure functions, no I/O: this module never imports `node:fs`
// and is safe to call from `plan_harness_install` (which must write nothing).
//
// `target_scope` selects the root: `user` -> the tool's home config dir;
// `project` -> the repo-local dir (`.claude/`, `.cursor/`, `.codex/` under a
// caller-supplied project root). Cells marked unsupported in the matrix throw
// so `plan`/`apply` refuse identically instead of guessing a path.

import { homedir } from 'node:os'
import { join } from 'node:path'

import type { HarnessFormat, HarnessTarget, HarnessTargetScope } from '../client.js'

export type { HarnessFormat, HarnessTarget, HarnessTargetScope }

/** Home-dir folder name per tool, e.g. `claude` -> `.claude`. */
const TOOL_DIR_NAME: Record<HarnessTarget, string> = {
  claude: '.claude',
  codex: '.codex',
  cursor: '.cursor',
}

export function resolveDestinationRoot(
  tool: HarnessTarget,
  scope: HarnessTargetScope,
  projectRoot?: string,
): string {
  const dirName = TOOL_DIR_NAME[tool]
  if (scope === 'project') {
    if (!projectRoot) throw new Error(`resolveDestinationRoot: projectRoot is required for scope "project"`)
    return join(projectRoot, dirName)
  }
  return join(homedir(), dirName)
}

/**
 * The format→tool applicability matrix (design.md §2). `true` = supported,
 * `false` = refused (unsupported cell). Claude Code is the reference
 * consumer and supports every format; Codex ships a conservative default for
 * markdown-only formats (`agent`, `command`); Cursor supports `agent`
 * (as a rule) and `claude_code_plugin` (as an mcp.json entry) only.
 */
const MATRIX: Record<HarnessFormat, Record<HarnessTarget, boolean>> = {
  agent:               { claude: true,  codex: true,  cursor: true },
  skill:               { claude: true,  codex: false, cursor: false },
  command:             { claude: true,  codex: true,  cursor: false },
  hook:                { claude: true,  codex: false, cursor: false },
  output_style:        { claude: true,  codex: false, cursor: false },
  claude_code_plugin:  { claude: true,  codex: false, cursor: true },
  theme:               { claude: true,  codex: false, cursor: false },
}

/** Human-readable reason a cell is unsupported, for refusal messages. */
const UNSUPPORTED_REASON: Partial<Record<HarnessFormat, string>> = {
  skill: 'Claude Code-only format (no equivalent install target)',
  output_style: 'Claude Code-only format (no equivalent install target)',
  theme: 'Claude Code-only format (no equivalent install target)',
  hook: 'requires tool-specific registration semantics not guessed for this target',
  claude_code_plugin: 'requires tool-specific registration semantics not guessed for this target',
  command: 'no stable slash-command destination for this target',
}

export function isSupportedPair(format: HarnessFormat, tool: HarnessTarget): boolean {
  return MATRIX[format]?.[tool] === true
}

function assertSupported(format: HarnessFormat, tool: HarnessTarget): void {
  if (isSupportedPair(format, tool)) return
  const reason = UNSUPPORTED_REASON[format] ?? 'no destination mapping for this target'
  throw new Error(
    `Unsupported format/tool combination: format "${format}" has no valid destination for target "${tool}" (${reason}).`,
  )
}

export interface ResolveComponentDestinationInput {
  format: HarnessFormat
  tool: HarnessTarget
  scope: HarnessTargetScope
  /** Manifest-relative path of the component/entry, e.g. "foo.md" or "my-skill/SKILL.md". */
  relativePath: string
  /** Required when scope === 'project'. */
  projectRoot?: string
}

export interface ResolvedComponentDestination {
  /** Absolute resolved destination path for this component. */
  destination: string
  /** True when materializing this component also requires a settings.json (or mcp.json) merge. */
  requiresSettingsMerge: boolean
  /** Absolute path to the settings/config file to merge into, when requiresSettingsMerge is true. */
  settingsPath?: string
}

/**
 * Resolve a single manifest component (or folder entry) to a concrete
 * destination. Throws for unsupported format/tool pairs — callers (plan and
 * apply) must refuse identically rather than catching and guessing.
 */
export function resolveComponentDestination(
  input: ResolveComponentDestinationInput,
): ResolvedComponentDestination {
  const { format, tool, scope, relativePath, projectRoot } = input
  assertSupported(format, tool)

  const root = resolveDestinationRoot(tool, scope, projectRoot)

  switch (tool) {
    case 'claude': {
      switch (format) {
        case 'agent':
          return { destination: join(root, 'agents', relativePath), requiresSettingsMerge: false }
        case 'skill':
          return { destination: join(root, 'skills', relativePath), requiresSettingsMerge: false }
        case 'command':
          return { destination: join(root, 'commands', relativePath), requiresSettingsMerge: false }
        case 'hook':
          return {
            destination: join(root, 'hooks', relativePath),
            requiresSettingsMerge: true,
            settingsPath: join(root, 'settings.json'),
          }
        case 'output_style':
          return { destination: join(root, 'output-styles', relativePath), requiresSettingsMerge: false }
        case 'claude_code_plugin':
          return {
            destination: join(root, 'plugins', relativePath),
            requiresSettingsMerge: true,
            settingsPath: join(root, 'settings.json'),
          }
        case 'theme':
          return { destination: join(root, 'themes', relativePath), requiresSettingsMerge: false }
      }
      break
    }
    case 'codex': {
      switch (format) {
        case 'agent':
          return { destination: join(root, 'agents', relativePath), requiresSettingsMerge: false }
        case 'command':
          return { destination: join(root, 'prompts', relativePath), requiresSettingsMerge: false }
      }
      break
    }
    case 'cursor': {
      switch (format) {
        case 'agent':
          return { destination: join(root, 'rules', relativePath), requiresSettingsMerge: false }
        case 'claude_code_plugin':
          return {
            destination: join(root, 'mcp.json'),
            requiresSettingsMerge: true,
            settingsPath: join(root, 'mcp.json'),
          }
      }
      break
    }
  }

  // Unreachable given assertSupported + the exhaustive MATRIX, but keeps
  // TypeScript honest and gives a clear error if the matrix and switch drift.
  throw new Error(`resolveComponentDestination: no resolution rule implemented for format "${format}" + tool "${tool}"`)
}
