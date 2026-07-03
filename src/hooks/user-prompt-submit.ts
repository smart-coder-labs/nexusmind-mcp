#!/usr/bin/env node
// user-prompt-submit.ts — NexusMind Codex CLI hook: UserPromptSubmit
// Runs on EVERY prompt, so it is the most token-sensitive hook. Behavior is
// controlled by NEXUSMIND_PROMPT_INJECT (default "minimal"):
//   off     — inject nothing (after the API-key gate).
//   minimal — inject nothing unless the prompt matches recall-intent keywords;
//             on a match, inject up to 3 memory lines + one save reminder.
//   full    — protocol skeleton + a single project-scoped memory fetch on
//             every prompt (one listMemories call, not two — the previous
//             recent-global fetch was dropped to keep this hook cheap).
// Ported from the Claude plugin's user-prompt-submit.sh (perf/lean-hooks),
// with consolidated tool names (search_memories, not search_memory/list_memories).
import {
  getHookEnv, readStdinJson, detectProject, formatMemoryLines,
  emitAdditionalContext, exitClean, withTimeout,
  PROMPT_INJECT_MODE, PROMPT_MEMORY_LIMIT, RECALL_KEYWORDS, FETCH_TIMEOUT_MS,
} from './_helpers.js'

interface UserPromptSubmitPayload {
  cwd?: string
  prompt?: string
  hook_event_name?: string
}

async function main(): Promise<void> {
  const payload = await readStdinJson<UserPromptSubmitPayload>()
  const { apiKey } = getHookEnv()

  if (!apiKey) exitClean(0)
  if (PROMPT_INJECT_MODE === 'off') exitClean(0)

  const prompt     = payload.prompt ?? ''
  const project    = detectProject(payload.cwd)
  const eventName  = payload.hook_event_name || 'UserPromptSubmit'

  const { listMemories } = await import('../client.js')

  if (PROMPT_INJECT_MODE === 'full') {
    let projectBlock = '(none)'

    try {
      const projectMemories = await withTimeout(
        listMemories({ project, limit: PROMPT_MEMORY_LIMIT }),
        FETCH_TIMEOUT_MS,
      )
      const formatted = formatMemoryLines(projectMemories, PROMPT_MEMORY_LIMIT)
      if (formatted) projectBlock = formatted
    } catch {
      // best-effort
    }

    const message = [
      `## NexusMind — Per-Prompt Protocol (project: ${project})`,
      '',
      `### 1) Project-specific memories — ${project}`,
      '```',
      projectBlock,
      '```',
      '',
      '### 2) Behavioral rule (bounded)',
      'If this prompt references past work you lack context on, call `search_memories` ONCE with a semantic query describing the topic — the project name goes in the `project` filter, never in the query. At most 1-2 memory searches per task; do not re-search on every turn.',
      '',
      '### 3) Save reminder',
      'After completing any decision, bug fix, or non-obvious discovery, call `store_memory` BEFORE moving on.',
      '',
      '### 4) Format hint',
      'When you call `store_memory`, always set `type`, always set `title`, always set `project`.',
    ].join('\n')

    emitAdditionalContext(eventName, message)
    exitClean(0)
  }

  // minimal (default): only inject on recall-intent prompts.
  if (!RECALL_KEYWORDS.test(prompt)) exitClean(0)

  let recentBlock = '(none)'
  try {
    const recent = await withTimeout(listMemories({ limit: 3 }), FETCH_TIMEOUT_MS)
    const formatted = formatMemoryLines(recent, 3)
    if (formatted) recentBlock = formatted
  } catch {
    // best-effort
  }

  const message = [
    `## NexusMind — Recall (project: ${project})`,
    recentBlock,
    '',
    'Save any decision you make with store_memory before moving on.',
  ].join('\n')

  emitAdditionalContext(eventName, message)
  exitClean(0)
}

main().catch(() => exitClean(0))
