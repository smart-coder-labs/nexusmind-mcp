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
    const needle = query.trim().toLowerCase()
    const matches = this.definitions.filter(tool => {
      const text = [tool.name, tool.namespace, tool.summary, ...tool.capabilities].join(' ').toLowerCase()
      const queryMatch = !needle || text.includes(needle)
      const effectMatch = !effectClass || tool.effects.includes(effectClass)
      const permissionMatch = tool.permissions.every(permission => permissions.includes(permission))
      return queryMatch && effectMatch && permissionMatch
    })
    metric('find', matches.length)
    return matches.map(({ schema, examples, input, run, ...descriptor }) => descriptor)
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
    if (!lease || lease.owner !== this.owner || lease.expiresAt <= Date.now() || !lease.permissions.every(permission => permissions.includes(permission))) {
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
    if (tool.effects.some(effect => effect !== 'read')) { metric('denied_effect', 1); throw new Error('FABRIC_READONLY_EFFECT_DENIED') }
    if (!tool.permissions.every(permission => permissions.includes(permission))) { metric('denied_effect', 1); throw new Error('FABRIC_PERMISSION_DENIED') }
    return tool
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
