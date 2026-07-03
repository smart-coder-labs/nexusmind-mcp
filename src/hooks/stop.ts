#!/usr/bin/env node
// stop.ts — NexusMind Codex CLI hook: Stop + SubagentStop (same handler,
// branches on hook_event_name — Codex maps both events to this one script).
// The two events have deliberately DIFFERENT behavior, ported from two
// separate scripts in the Claude plugin:
//   - SubagentStop → subagent-stop.sh: quality-gated PASSIVE CAPTURE. Saves
//     the subagent's output as a `discovery` memory if it looks decision-like.
//     Observation-only, never blocks.
//   - Stop → session-stop.sh: an ENFORCEMENT GATE, not a save path. If the
//     turn since the last real user message looks decision-like and nothing
//     was saved via store_memory, it emits {"decision":"block"} so Codex
//     continues instead of ending the turn — once per session (state file),
//     with a stop_hook_active anti-loop check so the resulting continuation
//     can't re-trigger the same block forever.
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getHookEnv, readStdinJson, detectProject, withTimeout, exitClean,
  emitBlockDecision, analyzeSinceLastRealUser,
  DECISION_KEYWORDS, STORE_TIMEOUT_MS,
} from './_helpers.js'

const MIN_LENGTH = 100
const MAX_LENGTH = 2000

interface StopPayload {
  cwd?: string
  session_id?: string
  transcript_path?: string
  hook_event_name?: string
  stop_hook_active?: boolean
  last_assistant_message?: string
}

// Rate-limit state dir — same layout as the Claude plugin's session-stop.sh:
// ${XDG_CACHE_HOME:-$HOME/.cache}/nexusmind/stop-gate-{session_id}.
function stopGateStateFile(sessionId: string): string {
  const cacheDir = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  return join(cacheDir, 'nexusmind', `stop-gate-${sessionId}`)
}

async function runSubagentStopCapture(payload: StopPayload): Promise<void> {
  const message = (payload.last_assistant_message ?? '').trim()
  if (message.length < MIN_LENGTH) return
  if (!DECISION_KEYWORDS.test(message)) return

  const project = detectProject(payload.cwd)
  const content = message.length > MAX_LENGTH
    ? `${message.slice(0, MAX_LENGTH)}... [truncated]`
    : message

  try {
    const { storeMemory } = await import('../client.js')
    await withTimeout(
      storeMemory({ content, title: `Subagent: ${project}`, type: 'discovery', tool: 'codex-cli', project }),
      STORE_TIMEOUT_MS,
    )
  } catch {
    // best-effort passive capture — never fail the hook
  }
}

async function runStopGate(payload: StopPayload): Promise<void> {
  // MANDATORY anti-loop: bail out immediately if this Stop event was itself
  // triggered by a previous block decision from this hook.
  if (payload.stop_hook_active) return

  if ((process.env.NEXUSMIND_STOP_GATE ?? 'on') === 'off') return

  const { apiKey } = getHookEnv()
  if (!apiKey) return

  const sessionId = payload.session_id
  if (!sessionId) return

  const stateFile = stopGateStateFile(sessionId)
  if (existsSync(stateFile)) return

  if (!payload.transcript_path) return

  const { assistantText, hasStoreMemory } = await analyzeSinceLastRealUser(payload.transcript_path)
  if (hasStoreMemory) return
  if (!assistantText) return
  if (!DECISION_KEYWORDS.test(assistantText)) return

  // Write the state file BEFORE emitting the block decision: if the cache
  // dir is unwritable, fail open (no block) instead of blocking on every
  // Stop event for this session.
  try {
    await mkdir(dirname(stateFile), { recursive: true })
    await writeFile(stateFile, '')
  } catch {
    return
  }

  emitBlockDecision(
    'NexusMind gate: this turn looks like it produced a decision, fix, or discovery, but nothing was saved. ' +
    'Call store_memory now (set type, title, project) — or finish normally if there is genuinely nothing worth ' +
    'persisting; this gate will not fire again this session.',
  )
}

async function main(): Promise<void> {
  const payload = await readStdinJson<StopPayload>()
  const eventName = payload.hook_event_name || 'Stop'

  if (eventName === 'SubagentStop') {
    await runSubagentStopCapture(payload)
  } else {
    await runStopGate(payload)
  }

  exitClean(0)
}

main().catch(() => exitClean(0))
