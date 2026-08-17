import { randomBytes } from 'node:crypto'
import { z } from 'zod'

export const FABRIC_VERSION = '1.0.0'
export const REGISTRY_VERSION = 'context-fabric-v3-reduced-readonly-1'
const DEFAULT_TTL_MS = 5 * 60 * 1000
const MAX_PAGE_SIZE = 50

export type EffectClass = 'read' | 'write' | 'delete'

export interface ToolDescriptor {
  name: string
  namespace: string
  summary: string
  capabilities: string[]
  io: { input: 'object'; output: 'json' }
  effects: EffectClass[]
  permissions: string[]
  cost: 'low' | 'medium' | 'high'
  latency: 'low' | 'medium' | 'high'
  failures: string[]
  schema_handle: string
  version: string
}

export interface ToolDefinition extends ToolDescriptor {
  schema: Record<string, unknown>
  examples: Array<{ args: Record<string, unknown>; description: string }>
  input: z.ZodType<Record<string, unknown>>
  run: (args: Record<string, unknown>) => Promise<unknown>
}

interface Lease { expiresAt: number; owner: string }
interface ResultLease extends Lease { value: unknown; permissions: string[] }

export class ToolFabric {
  private readonly loaded = new Map<string, Lease>()
  private readonly results = new Map<string, ResultLease>()
  private readonly owner: string

  constructor(
    private readonly definitions: readonly ToolDefinition[],
    private readonly ttlMs = DEFAULT_TTL_MS,
    owner = randomBytes(18).toString('hex'),
  ) { this.owner = owner }

  findTools(query = '', effectClass?: EffectClass, permissions: string[] = []): ToolDescriptor[] {
    // Tokenized keyword ranking instead of whole-query substring: a natural
    // multi-word query ("locate code file", "store memory decision") rarely
    // appears verbatim in a summary, so substring matching returned [] and the
    // agent could never obtain a handle. We score by how many distinct query
    // tokens hit the tool (name matches weighted higher) and rank by score.
    const tokens = this.tokenizeQuery(query)
    const scored = this.definitions
      .filter(tool => {
        const effectMatch = !effectClass || tool.effects.includes(effectClass)
        return effectMatch && this.permits(tool.permissions, permissions)
      })
      .map(tool => {
        const name = tool.name.toLowerCase()
        const text = [tool.name, tool.namespace, tool.summary, ...tool.capabilities].join(' ').toLowerCase()
        const score = tokens.length === 0
          ? 1
          : tokens.reduce((sum, t) => sum + (name.includes(t) ? 2 : text.includes(t) ? 1 : 0), 0)
        return { tool, score }
      })
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score)
    metric('find', scored.length)
    return scored.map(({ tool: { schema, examples, input, run, ...descriptor } }) => descriptor)
  }

  private tokenizeQuery(query: string): string[] {
    const STOP = new Set(['where', 'is', 'the', 'a', 'an', 'of', 'to', 'in', 'for', 'and', 'on', 'at', 'by', 'with', 'how', 'do', 'does', 'me', 'my', 'it', 'that', 'this'])
    return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !STOP.has(t)))]
  }

  loadTool(handle: string, permissions: string[] = []): ToolDefinition {
    const tool = this.authorize(handle, permissions)
    this.loaded.set(handle, { owner: this.owner, expiresAt: Date.now() + this.ttlMs })
    metric('load', 1)
    return tool
  }

  async executeTool(handle: string, args: Record<string, unknown>, version: string, permissions: string[] = []): Promise<string> {
    const tool = this.authorize(handle, permissions)
    if (version !== tool.version) {
      metric('version_mismatch', 1)
      throw new Error('FABRIC_VERSION_MISMATCH')
    }
    const loaded = this.loaded.get(handle)
    if (!loaded || loaded.owner !== this.owner || loaded.expiresAt <= Date.now()) {
      this.loaded.delete(handle)
      metric('invalid_handle', 1)
      throw new Error('FABRIC_HANDLE_EXPIRED')
    }
    const parsed = tool.input.safeParse(args)
    if (!parsed.success) {
      metric('invalid_args', 1)
      throw new Error('FABRIC_INVALID_ARGS')
    }
    const value = await tool.run(parsed.data)
    const resultHandle = `result://${randomBytes(18).toString('hex')}`
    this.results.set(resultHandle, { owner: this.owner, expiresAt: Date.now() + this.ttlMs, value, permissions: tool.permissions })
    metric('execute', 1)
    return resultHandle
  }

  fetchResult(handle: string, range?: { start?: number; end?: number }, cursor?: string, permissions: string[] = []): { items: unknown[]; next_cursor?: string; expires_at: string } {
    if (!this.isResultHandle(handle) || !permissions) {
      metric('invalid_handle', 1)
      throw new Error('FABRIC_INVALID_HANDLE')
    }
    const lease = this.results.get(handle)
    if (!lease || lease.owner !== this.owner || lease.expiresAt <= Date.now() || !this.permits(lease.permissions, permissions)) {
      this.results.delete(handle)
      metric('invalid_handle', 1)
      throw new Error('FABRIC_HANDLE_EXPIRED')
    }
    const values = Array.isArray(lease.value) ? lease.value : [lease.value]
    const start = cursor ? decodeCursor(cursor) : Math.max(0, range?.start ?? 0)
    const requestedEnd = range?.end ?? start + MAX_PAGE_SIZE
    const end = Math.min(values.length, Math.max(start, requestedEnd), start + MAX_PAGE_SIZE)
    const next = end < values.length ? encodeCursor(end) : undefined
    return { items: values.slice(start, end), ...(next ? { next_cursor: next } : {}), expires_at: new Date(lease.expiresAt).toISOString() }
  }

  private authorize(handle: string, permissions: string[]): ToolDefinition {
    const tool = this.definitions.find(candidate => candidate.schema_handle === handle)
    if (!tool) { metric('invalid_handle', 1); throw new Error('FABRIC_INVALID_HANDLE') }
    if (tool.effects.includes('delete')) { metric('denied_effect', 1); throw new Error('FABRIC_DESTRUCTIVE_EFFECT_DENIED') }
    if (!this.permits(tool.permissions, permissions)) { metric('denied_effect', 1); throw new Error('FABRIC_PERMISSION_DENIED') }
    return tool
  }

  // The caller's `held` permissions PRE-FILTER the fabric so an agent is not
  // offered tools its key cannot use. This is a UX filter, not a security
  // boundary: every tool call is independently gated server-side on the Bearer
  // key, and an unauthorized call returns permission_denied from the backend.
  //
  // An empty `held` means "unspecified" — the common case, because an agent has
  // no way to enumerate its own key's grants and nothing supplies them. Treating
  // empty as "matches only zero-permission tools" hid EVERY tool and made the
  // whole reduced profile look empty (find_tools returned [] for every query).
  // Empty therefore means "do not pre-filter, defer to the backend"; a non-empty
  // list still pre-filters exactly as before for a permission-aware host.
  private permits(required: string[], held: string[]): boolean {
    return held.length === 0 || required.every(permission => held.includes(permission))
  }

  private isResultHandle(handle: string): boolean { return handle.startsWith('result://') }
}

function encodeCursor(value: number): string { return Buffer.from(String(value)).toString('base64url') }
function decodeCursor(value: string): number {
  const parsed = Number(Buffer.from(value, 'base64url').toString('utf8'))
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error('FABRIC_INVALID_CURSOR')
  return parsed
}

// Metrics intentionally contain only operation names and counts, never args or results.
function metric(operation: string, count: number): void {
  if (process.env.NEXUSMIND_MCP_METRICS === 'off') return
  process.stderr.write(`[nexusmind-fabric] ${operation}=${count}\n`)
}

export function descriptorSchema(tool: ToolDefinition): Record<string, unknown> {
  return { ...tool.schema }
}
