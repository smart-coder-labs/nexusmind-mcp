#!/usr/bin/env node
// post-compact.ts — NexusMind Codex CLI hook: PostCompact
// Emits recovery instructions + recent memories right after Codex compacts
// context. Ported from the Claude plugin's post-compaction.sh (perf/lean-hooks);
// Codex has a native PostCompact event, unlike Claude Code's SessionStart(compact)
// matcher, so this registers directly against it.
import {
  getHookEnv, readStdinJson, detectProject, isBackendHealthy, formatMemoryLines,
  emitAdditionalContext, exitClean, withTimeout,
  SESSION_RECENT_LIMIT, FETCH_TIMEOUT_MS,
} from './_helpers.js'

interface PostCompactPayload {
  cwd?: string
  session_id?: string
  hook_event_name?: string
}

async function main(): Promise<void> {
  const payload = await readStdinJson<PostCompactPayload>()
  const { apiKey, baseUrl } = getHookEnv()

  if (!apiKey) exitClean(0)
  if (!(await isBackendHealthy(baseUrl))) exitClean(0)

  const { listMemories } = await import('../client.js')
  const project = detectProject(payload.cwd)

  let recentBlock = ''
  try {
    const recent = await withTimeout(listMemories({ limit: SESSION_RECENT_LIMIT }), FETCH_TIMEOUT_MS)
    recentBlock = formatMemoryLines(recent, SESSION_RECENT_LIMIT)
  } catch {
    // best-effort — omit the block on failure
  }

  const lines: string[] = [
    `## NexusMind — Post-Compaction Recovery (project: ${project})`,
    '',
    'Context was compacted. FIRST: call store_memory (type="session_summary") with what was in progress. ' +
      `THEN call search_memories or get_context with project="${project}" as a filter to recover history — never as the search query text.`,
  ]

  if (recentBlock) {
    lines.push('', `### Recent Team Memories (last ${SESSION_RECENT_LIMIT})`, recentBlock)
  }

  emitAdditionalContext(payload.hook_event_name || 'PostCompact', lines.join('\n'))
  exitClean(0)
}

main().catch(() => exitClean(0))
