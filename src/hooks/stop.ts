#!/usr/bin/env node
// stop.ts — NexusMind Codex CLI hook: Stop + SubagentStop (same handler, branches
// on hook_event_name). Quality-gated passive capture: only stores messages that
// look decision-like. Ported from the Claude plugin's subagent-stop.sh
// (perf/lean-hooks); Codex's payload field is last_assistant_message, not
// stdout, so the field name changed but the quality gate stayed the same.
// Stop/SubagentStop are observation-only — no additionalContext is emitted.
import {
  getHookEnv, readStdinJson, detectProject, withTimeout, exitClean,
  DECISION_KEYWORDS, STORE_TIMEOUT_MS,
} from './_helpers.js'

const MIN_LENGTH = 100
const MAX_LENGTH = 2000

interface StopPayload {
  cwd?: string
  hook_event_name?: string
  last_assistant_message?: string
}

async function main(): Promise<void> {
  const payload = await readStdinJson<StopPayload>()
  const { apiKey } = getHookEnv()

  if (!apiKey) exitClean(0)

  const message = (payload.last_assistant_message ?? '').trim()
  if (message.length < MIN_LENGTH) exitClean(0)
  if (!DECISION_KEYWORDS.test(message)) exitClean(0)

  const eventName = payload.hook_event_name || 'Stop'
  const project    = detectProject(payload.cwd)
  const content    = message.length > MAX_LENGTH
    ? `${message.slice(0, MAX_LENGTH)}... [truncated]`
    : message
  const title = eventName === 'SubagentStop' ? `Subagent: ${project}` : `Session: ${project}`

  try {
    const { storeMemory } = await import('../client.js')
    await withTimeout(
      storeMemory({ content, title, type: 'discovery', tool: 'codex-cli', project }),
      STORE_TIMEOUT_MS,
    )
  } catch {
    // best-effort passive capture — never fail the hook
  }

  exitClean(0)
}

main().catch(() => exitClean(0))
