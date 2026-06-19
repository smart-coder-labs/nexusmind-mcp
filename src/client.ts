const BASE_URL = process.env.NEXUSMIND_BASE_URL ?? ''
const API_KEY  = process.env.NEXUSMIND_API_KEY  ?? ''

interface ApiError extends Error {
  status: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!BASE_URL) throw new Error('NEXUSMIND_BASE_URL is not set. Run: npx @smart-coder-labs/nexusmind-mcp setup')
  if (!API_KEY)  throw new Error('NEXUSMIND_API_KEY is not set. Run: npx @smart-coder-labs/nexusmind-mcp setup')

  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
        ...init?.headers,
      },
    })
  } catch {
    const err = new Error(
      `NexusMind backend not reachable at ${BASE_URL}. Is it running?`
    ) as ApiError
    err.status = 0
    throw err
  }

  if (res.status === 401) {
    const err = new Error(
      'Invalid API key. Set NEXUSMIND_API_KEY to your NexusMind key.'
    ) as ApiError
    err.status = 401
    throw err
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
    const err = new Error(body.error ?? res.statusText) as ApiError
    err.status = res.status
    throw err
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// ── Types ────────────────────────────────────────────────────────────────────

export type MemoryType =
  | 'architecture' | 'bugfix' | 'decision' | 'discovery'
  | 'config' | 'pattern' | 'feedback' | 'preference'
  | 'project' | 'session_summary' | 'feature' | 'refactoring' | 'manual'

export type MemoryScope = 'project' | 'personal'

export interface Memory {
  id: string
  user_id: string
  project: string
  tool: string
  type?: MemoryType
  title?: string
  topic_key?: string
  scope: MemoryScope
  content: string
  tags: string[]
  revision_count: number
  created_at: string
}

export interface StoreMemoryInput {
  content: string
  project?: string
  tool?: string
  type?: MemoryType
  title?: string
  topic_key?: string
  scope?: MemoryScope
  tags?: string[]
  session_id?: string
}

export interface StoreMemoryResponse {
  id: string
}

// ── API calls ────────────────────────────────────────────────────────────────

export function storeMemory(input: StoreMemoryInput): Promise<StoreMemoryResponse> {
  const body: Record<string, unknown> = {
    content:  input.content,
    project:  input.project   ?? '',
    tool:     input.tool      ?? 'claude-code',
    tags:     input.tags      ?? [],
    scope:    input.scope     ?? 'project',
  }
  if (input.type)       body.type       = input.type
  if (input.title)      body.title      = input.title
  if (input.topic_key)  body.topic_key  = input.topic_key
  if (input.session_id) body.session_id = input.session_id
  return request('/v1/memory/store', { method: 'POST', body: JSON.stringify(body) })
}

export function searchMemories(query: string, limit = 10): Promise<Memory[]> {
  return request('/v1/memory/search', {
    method: 'POST',
    body: JSON.stringify({ query, limit }),
  })
}

export function listMemories(params: {
  project?: string
  tool?: string
  type?: MemoryType
  scope?: MemoryScope
  limit?: number
} = {}): Promise<Memory[]> {
  const qs = new URLSearchParams()
  if (params.project) qs.set('project', params.project)
  if (params.tool)    qs.set('tool',    params.tool)
  if (params.type)    qs.set('type',    params.type)
  if (params.scope)   qs.set('scope',   params.scope)
  if (params.limit)   qs.set('limit',   String(params.limit))
  return request(`/v1/memory?${qs}`)
}

export function getMemoryById(id: string): Promise<Memory> {
  return request<Memory>(`/v1/memory/${encodeURIComponent(id)}`, { method: 'GET' })
}

export function deleteMemory(id: string): Promise<void> {
  return request<void>(`/v1/memory/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ── Code Index Types ─────────────────────────────────────────────────────────

export interface IndexProjectInput {
  project: string
  root_path: string
  extensions?: string[]
}

export interface IndexProjectResponse {
  status: string
  project: string
  file_count: number
  chunk_count: number
}

export interface SearchCodeInput {
  query: string
  project: string
  limit?: number
}

export interface CodeSearchResult {
  project: string
  file_path: string
  symbol?: string
  kind?: string
  start_line: number
  end_line: number
  content: string
  score: number
}

export interface GetSymbolContextInput {
  project: string
  file_path: string
  symbol: string
}

export interface CodeChunk {
  project: string
  file_path: string
  symbol?: string
  kind?: string
  start_line: number
  end_line: number
  content: string
}

// ── Code Index API calls ─────────────────────────────────────────────────────

export function indexProject(input: IndexProjectInput): Promise<IndexProjectResponse> {
  const body: Record<string, unknown> = {
    project:   input.project,
    root_path: input.root_path,
  }
  if (input.extensions) body.extensions = input.extensions
  return request<IndexProjectResponse>('/v1/code/index', { method: 'POST', body: JSON.stringify(body) })
}

export function searchCode(input: SearchCodeInput): Promise<CodeSearchResult[]> {
  const body: Record<string, unknown> = {
    query:   input.query,
    project: input.project,
  }
  if (input.limit !== undefined) body.top_k = input.limit
  return request<CodeSearchResult[]>('/v1/code/search', { method: 'POST', body: JSON.stringify(body) })
}

export function getSymbolContext(input: GetSymbolContextInput): Promise<CodeChunk[]> {
  const qs = new URLSearchParams({
    project:   input.project,
    file_path: input.file_path,
    symbol:    input.symbol,
  })
  return request<CodeChunk[]>(`/v1/code/context?${qs}`)
}
