// _helpers.ts — shared utilities for NexusMind Codex CLI hook handlers.
// Every hook is a short-lived Node process invoked by Codex with a JSON payload
// on stdin. These helpers keep that contract consistent: parse stdin, resolve
// env config, detect the project, hit the backend with a hard timeout, and
// format/emit output the way Codex expects.
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'

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
