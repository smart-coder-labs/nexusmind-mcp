// _helpers.ts — shared utilities for NexusMind Codex CLI hook handlers.
// Every hook is a short-lived Node process invoked by Codex with a JSON payload
// on stdin. These helpers keep that contract consistent: parse stdin, resolve
// env config, detect the project, hit the backend with a hard timeout, and
// format/emit output the way Codex expects.
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'

export const DEFAULT_BASE_URL = 'https://nexusmind-backend.fly.dev'
export const HEALTH_TIMEOUT_MS = 5000
export const FETCH_TIMEOUT_MS = 8000
export const STORE_TIMEOUT_MS = 10000

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const SESSION_PROJECT_LIMIT = envInt('NEXUSMIND_SESSION_PROJECT_LIMIT', 8)
export const SESSION_RECENT_LIMIT  = envInt('NEXUSMIND_SESSION_RECENT_LIMIT', 5)
export const PROMPT_MEMORY_LIMIT   = envInt('NEXUSMIND_PROMPT_MEMORY_LIMIT', 3)
export const PROMPT_INJECT_MODE    = (process.env.NEXUSMIND_PROMPT_INJECT ?? 'minimal').toLowerCase()

export const RECALL_KEYWORDS   = /remember|recall|recuerda|acordate|what did we|qué hicimos/i
export const DECISION_KEYWORDS = /decided|decision|fixed|error|warning|convention|architecture|discovered|discovery|issue|solution|implemented|changed|added|removed|refactored|pattern|config|gotcha|caveat|note|important/i

export interface HookEnv {
  apiKey: string
  baseUrl: string
}

/**
 * Resolves API key + base URL from the environment. Also writes the resolved
 * base URL back to process.env so that client.ts — which reads
 * NEXUSMIND_BASE_URL at import time — sees a usable value even when the user
 * never set one (client.ts itself has no default; hooks do).
 */
export function getHookEnv(): HookEnv {
  const apiKey  = process.env.NEXUSMIND_API_KEY ?? ''
  const baseUrl = process.env.NEXUSMIND_BASE_URL || DEFAULT_BASE_URL
  process.env.NEXUSMIND_BASE_URL = baseUrl
  return { apiKey, baseUrl }
}

/** Reads and JSON-parses the hook payload Codex writes to stdin. Never throws —
 *  returns {} on empty input, non-JSON input, or a TTY (no piped input). */
export async function readStdinJson<T = Record<string, unknown>>(): Promise<T> {
  if (process.stdin.isTTY) return {} as T
  const chunks: Buffer[] = []
  try {
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
  } catch {
    return {} as T
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {} as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return {} as T
  }
}

/** Mirrors the Claude plugin's detect_project: git remote origin repo name →
 *  git root basename → cwd basename. Uses spawnSync with a hard timeout so a
 *  hung git process cannot hang the hook. */
export function detectProject(cwd?: string): string {
  const dir = cwd && cwd.length > 0 ? cwd : process.cwd()
  const opts = { cwd: dir, encoding: 'utf8' as const, timeout: 3000 }
  try {
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], opts)
    if (inside.status === 0) {
      const remote = spawnSync('git', ['remote', 'get-url', 'origin'], opts)
      if (remote.status === 0 && remote.stdout && remote.stdout.trim()) {
        const name = basename(remote.stdout.trim()).replace(/\.git$/, '')
        if (name) return name
      }
      const root = spawnSync('git', ['rev-parse', '--show-toplevel'], opts)
      if (root.status === 0 && root.stdout && root.stdout.trim()) {
        return basename(root.stdout.trim())
      }
    }
  } catch {
    // fall through to cwd basename
  }
  return basename(dir)
}

/** Races a promise against a timeout so a stalled fetch (e.g. an unreachable
 *  backend on a black-holed port) cannot hang the hook process. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('nexusmind hook: operation timed out')), ms)
    promise.then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) },
    )
  })
}

export async function isBackendHealthy(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
    const res = await fetch(`${baseUrl}/v1/health`, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

interface MemoryLike {
  type?: string
  title?: string
  content: string
}

export function formatMemoryLines(memories: MemoryLike[], limit: number): string {
  return memories.slice(0, limit).map(m => {
    const type  = m.type ?? 'general'
    const title = m.title ?? m.content.split('\n')[0].slice(0, 120)
    return `- [${type}] ${title}`
  }).join('\n')
}

/** Emits Codex's additionalContext envelope on stdout. Only SessionStart,
 *  SubagentStart, and UserPromptSubmit consume this — Stop/SubagentStop are
 *  observation-only and must not call this. */
export function emitAdditionalContext(hookEventName: string, text: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext: text },
  }) + '\n')
}

/** Force-exits the process. A dangling fetch() from a slow/unreachable backend
 *  can otherwise keep the event loop alive well past when the hook is done. */
export function exitClean(code = 0): never {
  process.exit(code)
}

/** Emits the `{"decision":"block","reason":"..."}` envelope Codex reads from a
 *  Stop hook's stdout to force the turn to continue instead of ending. Only
 *  Stop should call this — SubagentStop is observation-only. */
export function emitBlockDecision(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n')
}

// ── Transcript parsing (JSONL) ───────────────────────────────────────────────
// Shared by pre-compact.ts (recent-message snapshot) and stop.ts (Stop gate).
// Mirrors the Python parsing logic in the Claude plugin's pre-compact.sh /
// session-stop.sh byte-for-byte so behavior stays consistent across ports.

interface TranscriptContentItem {
  type?: string
  text?: string
  name?: string
}

interface TranscriptMessage {
  role?: string
  content?: string | TranscriptContentItem[]
}

interface TranscriptEntry {
  type?: string
  isMeta?: boolean
  message?: TranscriptMessage
}

// Synthetic user-type entries (isMeta preludes, hook/skill injections, local
// command output, system notifications) must NOT count as real turn
// boundaries — only genuine user-typed text does.
const SYNTHETIC_TEXT_PREFIXES = [
  '<system-reminder>',
  '[SYSTEM NOTIFICATION',
  'Caveat:',
  '<command-name>',
  '<local-command-stdout>',
  '<task-notification>',
]

function startsWithSyntheticPrefix(text: string): boolean {
  const trimmed = text.trimStart()
  return SYNTHETIC_TEXT_PREFIXES.some(prefix => trimmed.startsWith(prefix))
}

function isRealUserText(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user') return false
  if (entry.isMeta) return false
  const message = entry.message ?? {}
  if (message.role !== 'user') return false
  const content = message.content
  if (typeof content === 'string') {
    const text = content.trim()
    return text.length > 0 && !startsWithSyntheticPrefix(text)
  }
  if (!Array.isArray(content)) return false
  for (const item of content) {
    if (item && typeof item === 'object' && item.type === 'text') {
      const text = (item.text ?? '').trim()
      if (text && !startsWithSyntheticPrefix(text)) return true
    }
  }
  return false
}

/** Reads a JSONL transcript, skipping unparseable lines defensively — same
 *  tolerance as the bash reference's Python parsing. Returns [] on any I/O
 *  error (missing file, unreadable path) instead of throwing. */
async function readTranscriptEntries(transcriptPath?: string): Promise<TranscriptEntry[]> {
  if (!transcriptPath) return []
  let raw: string
  try {
    raw = await readFile(transcriptPath, 'utf8')
  } catch {
    return []
  }
  const entries: TranscriptEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed))
    } catch {
      // skip malformed line
    }
  }
  return entries
}

/** Extracts the last `limit` assistant text messages from a JSONL transcript,
 *  joined with the same "\n\n---\n\n" separator the bash reference uses. */
export async function extractRecentAssistantText(transcriptPath: string | undefined, limit: number): Promise<string> {
  const entries = await readTranscriptEntries(transcriptPath)
  const messages: string[] = []
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const item of content) {
      if (item && typeof item === 'object' && item.type === 'text' && item.text) {
        messages.push(item.text)
      }
    }
  }
  return messages.slice(-limit).join('\n\n---\n\n')
}

export interface TranscriptSinceLastUser {
  assistantText: string
  hasStoreMemory: boolean
}

/** Analyzes transcript entries after the last REAL user text message (turn
 *  boundary), collecting assistant text and whether a store_memory tool_use
 *  occurred in that span. Tool names may be MCP-namespaced, so `store_memory`
 *  is matched by substring. If no real user message exists, falls back to
 *  scanning the whole transcript (mirrors session-stop.sh, which has no
 *  fallback-tail variant — that's session-end.sh's behavior, and Codex has no
 *  SessionEnd event to attach it to). */
export async function analyzeSinceLastRealUser(transcriptPath: string | undefined): Promise<TranscriptSinceLastUser> {
  const entries = await readTranscriptEntries(transcriptPath)

  let lastUserIdx = -1
  entries.forEach((entry, i) => {
    if (isRealUserText(entry)) lastUserIdx = i
  })

  const span = lastUserIdx >= 0 ? entries.slice(lastUserIdx + 1) : entries

  const assistantText: string[] = []
  let hasStoreMemory = false
  for (const entry of span) {
    if (entry.type !== 'assistant') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      if (item.type === 'text') {
        assistantText.push(item.text ?? '')
      } else if (item.type === 'tool_use' && typeof item.name === 'string' && item.name.includes('store_memory')) {
        hasStoreMemory = true
      }
    }
  }

  return { assistantText: assistantText.join('\n'), hasStoreMemory }
}
