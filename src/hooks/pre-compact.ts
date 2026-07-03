#!/usr/bin/env node
// pre-compact.ts — NexusMind Codex CLI hook: PreCompact
// Persists a session snapshot BEFORE compaction destroys context, without
// depending on the model to do it. Codex's PreCompact is synchronous/blocking
// (see https://developers.openai.com/codex/hooks), so this runs to completion
// before compaction proceeds — same guarantee the Claude plugin's
// pre-compact.sh relies on. Ported from that script; behavior matches exactly
// (last ~15 assistant messages, 100-char skip floor, 2000-char truncation,
// same session-snapshot/{session_id} topic_key so PreCompact snapshots for the
// same session upsert instead of piling up duplicates).
import {
  getHookEnv, readStdinJson, detectProject, extractRecentAssistantText,
  exitClean, withTimeout, STORE_TIMEOUT_MS,
} from './_helpers.js'

const MIN_LENGTH = 100
const MAX_LENGTH = 2000
const RECENT_MESSAGE_COUNT = 15

interface PreCompactPayload {
  cwd?: string
  session_id?: string
  transcript_path?: string
}

async function main(): Promise<void> {
  const payload = await readStdinJson<PreCompactPayload>()
  const { apiKey } = getHookEnv()

  if (!apiKey) exitClean(0)

  const recentText = await extractRecentAssistantText(payload.transcript_path, RECENT_MESSAGE_COUNT)
  if (recentText.length < MIN_LENGTH) exitClean(0)

  const project = detectProject(payload.cwd)
  const fullContent = `Pre-compaction snapshot — last assistant messages before compaction:\n\n${recentText}`
  const content = fullContent.length > MAX_LENGTH
    ? `${fullContent.slice(0, MAX_LENGTH)}... [truncated]`
    : fullContent

  try {
    const { storeMemory } = await import('../client.js')
    await withTimeout(
      storeMemory({
        content,
        title: `Pre-compaction snapshot: ${project}`,
        type: 'session_summary',
        tool: 'codex-cli',
        project,
        ...(payload.session_id ? { topic_key: `session-snapshot/${payload.session_id}` } : {}),
      }),
      STORE_TIMEOUT_MS,
    )
  } catch {
    // best-effort — never fail the hook
  }

  exitClean(0)
}

main().catch(() => exitClean(0))
