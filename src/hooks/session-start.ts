#!/usr/bin/env node
// session-start.ts — NexusMind Codex CLI hook: SessionStart
// Emits additionalContext with the memory protocol + project/recency memory lists.
// Ported from the Claude plugin's session-start.sh (perf/lean-hooks) — same
// injection budget (~80 word protocol + memory blocks), consolidated tool names.
import {
  getHookEnv, readStdinJson, detectProject, isBackendHealthy, formatMemoryLines,
  emitAdditionalContext, exitClean, withTimeout,
  SESSION_PROJECT_LIMIT, SESSION_RECENT_LIMIT, FETCH_TIMEOUT_MS,
} from './_helpers.js'

interface SessionStartPayload {
  cwd?: string
  hook_event_name?: string
}

async function main(): Promise<void> {
  const payload = await readStdinJson<SessionStartPayload>()
  const { apiKey, baseUrl } = getHookEnv()

  if (!apiKey) exitClean(0)
  if (!(await isBackendHealthy(baseUrl))) exitClean(0)

  const { listMemories } = await import('../client.js')
  const project = detectProject(payload.cwd)

  let projectBlock = ''
  let recentBlock = ''

  try {
    const projectMemories = await withTimeout(
      listMemories({ project, limit: SESSION_PROJECT_LIMIT }),
      FETCH_TIMEOUT_MS,
    )
    projectBlock = formatMemoryLines(projectMemories, SESSION_PROJECT_LIMIT)
  } catch {
    // best-effort — omit the block on failure
  }

  try {
    const recentMemories = await withTimeout(
      listMemories({ limit: SESSION_RECENT_LIMIT }),
      FETCH_TIMEOUT_MS,
    )
    recentBlock = formatMemoryLines(recentMemories, SESSION_RECENT_LIMIT)
  } catch {
    // best-effort — omit the block on failure
  }

  const lines: string[] = [
    `## NexusMind — Memory Protocol (project: ${project})`,
    '',
    'Tools: store_memory, search_memories, get_context, list_conventions, get_memory, health_check.',
    'Proactively call store_memory right after any decision, bug fix, discovery, or convention — do not wait to be asked.',
    `Before starting work that may already have context, call search_memories with project="${project}" as a FILTER (omit query to browse) — never as the search query text.`,
    'Before ending the session, call store_memory with type="session_summary" — mandatory, skipping it leaves the next session blind.',
  ]

  if (projectBlock) {
    lines.push('', `### Project Memories — ${project}`, projectBlock)
  }
  if (recentBlock) {
    lines.push('', `### Recent Team Memories (last ${SESSION_RECENT_LIMIT})`, recentBlock)
  }

  emitAdditionalContext(payload.hook_event_name || 'SessionStart', lines.join('\n'))
  exitClean(0)
}

main().catch(() => exitClean(0))
