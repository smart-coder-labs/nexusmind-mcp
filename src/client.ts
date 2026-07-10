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
  updated_at?: string
  pinned?: boolean
  archived_at?: string | null
  session_id?: string
  collection_id?: string
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
  collection_id?: string
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
  if (input.type)          body.type          = input.type
  if (input.title)         body.title         = input.title
  if (input.topic_key)     body.topic_key     = input.topic_key
  if (input.session_id)    body.session_id    = input.session_id
  if (input.collection_id) body.collection_id = input.collection_id
  return request('/v1/memory/store', { method: 'POST', body: JSON.stringify(body) })
}

export interface SearchMemoriesInput {
  query: string
  limit?: number
  collection_id?: string
  pinned?: boolean
  archived?: boolean
}

export function searchMemories(queryOrInput: string | SearchMemoriesInput, limit = 10): Promise<Memory[]> {
  const body: Record<string, unknown> =
    typeof queryOrInput === 'string'
      ? { query: queryOrInput, limit }
      : {
          query: queryOrInput.query,
          limit: queryOrInput.limit ?? limit,
          ...(queryOrInput.collection_id !== undefined && { collection_id: queryOrInput.collection_id }),
          ...(queryOrInput.pinned        !== undefined && { pinned:        queryOrInput.pinned }),
          ...(queryOrInput.archived      !== undefined && { archived:      queryOrInput.archived }),
        }
  return request<Memory[] | { memories?: Memory[] }>('/v1/memory/search', { method: 'POST', body: JSON.stringify(body) })
    .then(res => Array.isArray(res) ? res : (res?.memories ?? []))
}

export function listMemories(params: {
  project?: string
  tool?: string
  type?: MemoryType
  scope?: MemoryScope
  session_id?: string
  since?: string
  until?: string
  sort?: string
  limit?: number
  collection_id?: string
  include_archived?: boolean
} = {}): Promise<Memory[]> {
  const qs = new URLSearchParams()
  if (params.project)          qs.set('project',          params.project)
  if (params.tool)             qs.set('tool',             params.tool)
  if (params.type)             qs.set('type',             params.type)
  if (params.scope)            qs.set('scope',            params.scope)
  if (params.session_id)       qs.set('session_id',       params.session_id)
  // GET /v1/memory deserializes date bounds as from_date/to_date; `since`/`until` are silently dropped
  if (params.since)            qs.set('from_date',        params.since)
  if (params.until)            qs.set('to_date',          params.until)
  if (params.sort)             qs.set('sort',             params.sort)
  if (params.limit)            qs.set('limit',            String(params.limit))
  if (params.collection_id)    qs.set('collection_id',    params.collection_id)
  if (params.include_archived) qs.set('include_archived', String(params.include_archived))
  return request<Memory[] | { memories?: Memory[] }>(`/v1/memory?${qs}`)
    .then(res => Array.isArray(res) ? res : (res?.memories ?? []))
}

export function getMemoryById(id: string): Promise<Memory> {
  return request<Memory>(`/v1/memory/${encodeURIComponent(id)}`, { method: 'GET' })
}

export function deleteMemory(id: string): Promise<void> {
  return request<void>(`/v1/memory/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ── Memory mutation helpers ───────────────────────────────────────────────────

export interface UpdateMemoryInput {
  id: string
  content?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

export function updateMemory(input: UpdateMemoryInput): Promise<Memory> {
  const body: Record<string, unknown> = {}
  if (input.content  !== undefined) body.content  = input.content
  if (input.tags     !== undefined) body.tags      = input.tags
  if (input.metadata !== undefined) body.metadata  = input.metadata
  return request<Memory>(`/v1/memory/${encodeURIComponent(input.id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function archiveMemory(id: string): Promise<void> {
  return request<void>(`/v1/memory/${encodeURIComponent(id)}/archive`, { method: 'POST' })
}

export function restoreMemory(id: string): Promise<void> {
  return request<void>(`/v1/memory/${encodeURIComponent(id)}/restore`, { method: 'POST' })
}

export function pinMemory(id: string): Promise<void> {
  return request<void>(`/v1/memory/${encodeURIComponent(id)}/pin`, { method: 'POST' })
}

export function unpinMemory(id: string): Promise<void> {
  return request<void>(`/v1/memory/${encodeURIComponent(id)}/unpin`, { method: 'POST' })
}

// ── Code Index Types ─────────────────────────────────────────────────────────

export interface IndexProjectInput {
  project: string
  root_path?: string
  repo_url?: string
  /** GitHub Personal Access Token for private repositories. Requires `repo` scope. */
  github_token?: string
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
  const body: Record<string, unknown> = { project: input.project }
  if (input.root_path)    body.root_path    = input.root_path
  if (input.repo_url)     body.repo_url     = input.repo_url
  if (input.github_token) body.github_token = input.github_token
  if (input.extensions)   body.extensions   = input.extensions
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

// ── Global Search ────────────────────────────────────────────────────────────

export type GlobalSearchType = 'memories' | 'code' | 'users' | 'policies' | 'conventions'

export interface GlobalSearchResult {
  memories?: unknown[]
  code?: unknown[]
  users?: unknown[]
  policies?: unknown[]
  conventions?: unknown[]
  [key: string]: unknown[] | undefined
}

export interface GlobalSearchInput {
  query: string
  types?: GlobalSearchType[]
}

export function globalSearch(input: GlobalSearchInput): Promise<GlobalSearchResult> {
  const qs = new URLSearchParams({ q: input.query })
  if (input.types && input.types.length > 0) qs.set('types', input.types.join(','))
  return request<GlobalSearchResult>(`/v1/search?${qs}`)
}

// ── List Code Projects ───────────────────────────────────────────────────────

export interface CodeProject {
  id: string
  name: string
  status: string
  last_indexed_at?: string
  file_count?: number
  chunk_count?: number
  is_archived?: boolean
  [key: string]: unknown
}

export interface ListCodeProjectsInput {
  include_archived?: boolean
}

export function listCodeProjects(input: ListCodeProjectsInput = {}): Promise<CodeProject[]> {
  const qs = input.include_archived ? '?include_archived=true' : ''
  return request<CodeProject[]>(`/v1/code/projects${qs}`)
}

export function getCodeProjectFiles(projectId: string): Promise<string[]> {
  return request<string[]>(`/v1/code/projects/${encodeURIComponent(projectId)}/files`)
}

export function deleteCodeProject(projectId: string): Promise<void> {
  return request<void>(`/v1/code/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
}

// ── Bulk Delete Memories ─────────────────────────────────────────────────────

export interface BulkDeleteInput {
  ids: string[]
}

export interface BulkDeleteResult {
  deleted: number
  [key: string]: unknown
}

export function bulkDeleteMemories(input: BulkDeleteInput): Promise<BulkDeleteResult> {
  return request<BulkDeleteResult>('/v1/memory/bulk', {
    method: 'DELETE',
    body: JSON.stringify({ ids: input.ids }),
  })
}

// ── Memory Admin ─────────────────────────────────────────────────────────────

export function mergeMemoryPair(keepId: string, mergeId: string): Promise<void> {
  return request<void>('/v1/admin/memories/merge', {
    method: 'POST',
    body: JSON.stringify({ keep_id: keepId, merge_id: mergeId }),
  })
}

export interface BulkTagSingleResult {
  updated: number
}

export function bulkTagMemoriesSingle(ids: string[], action: 'add' | 'remove', tag: string): Promise<BulkTagSingleResult> {
  return request<BulkTagSingleResult>('/v1/admin/memories/bulk-tag', {
    method: 'POST',
    body: JSON.stringify({ ids, action, tag }),
  })
}

// ── Collections ──────────────────────────────────────────────────────────────

export interface CollectionItem {
  id: string
  org_id: string
  name: string
  description?: string | null
  created_at: string
  memory_count?: number | null
}

export function listCollections(): Promise<CollectionItem[]> {
  return request<CollectionItem[]>('/v1/admin/collections')
}

export function assignMemoryToCollection(memoryId: string, collectionId: string | null): Promise<void> {
  return request<void>(`/v1/memories/${encodeURIComponent(memoryId)}/collection`, {
    method: 'POST',
    body: JSON.stringify({ collection_id: collectionId }),
  })
}

export function createCollection(data: { name: string; description?: string }): Promise<CollectionItem> {
  return request<CollectionItem>('/v1/admin/collections', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function deleteCollection(id: string): Promise<void> {
  return request<void>(`/v1/admin/collections/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function updateCollection(id: string, data: { name?: string; description?: string }): Promise<CollectionItem> {
  return request<CollectionItem>(`/v1/admin/collections/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

// ── Admin Keys (Agents) ───────────────────────────────────────────────────────

export interface OrgKey {
  id: number | string
  name?: string
  key_prefix?: string
  role?: string
  times_used?: number
  created_at?: string
  expires_at?: string
  [key: string]: unknown
}

export function listOrgKeys(): Promise<OrgKey[]> {
  return request<OrgKey[]>('/v1/admin/keys')
}

export function revokeApiKey(id: string): Promise<void> {
  return request<void>(`/v1/admin/keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export interface CreateOrgKeyRequest {
  name: string
  expires_at?: string
  role?: string
  description?: string
}

export interface CreatedOrgKey {
  id: string | number
  name: string
  key: string
  role?: string
  expires_at?: string
  created_at?: string
  [key: string]: unknown
}

export function createApiKey(data: CreateOrgKeyRequest): Promise<CreatedOrgKey> {
  return request<CreatedOrgKey>('/v1/admin/keys', { method: 'POST', body: JSON.stringify(data) })
}

// ── Audit Log ────────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  id: string | number
  user_id?: string
  action?: string
  resource_type?: string
  resource_id?: string
  created_at?: string
  [key: string]: unknown
}

export interface GetAuditLogInput {
  user_id?: string
  action?: string
  limit?: number
}

export function getAuditLog(input: GetAuditLogInput = {}): Promise<AuditLogEntry[]> {
  const qs = new URLSearchParams()
  if (input.user_id) qs.set('user_id', input.user_id)
  if (input.action)  qs.set('action',  input.action)
  qs.set('limit', String(input.limit ?? 50))
  return request<AuditLogEntry[]>(`/v1/audit?${qs}`)
}

// ── Conventions ───────────────────────────────────────────────────────────────

export interface Convention {
  id: string | number
  title?: string
  category?: string
  content: string
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export interface StoreConventionInput {
  title?: string
  category?: string
  content: string
  weight?: number
}

export interface UpdateConventionInput {
  title?: string
  category?: string
  content?: string
  weight?: number
}

export function listConventions(category?: string, includeArchived?: boolean, project?: string): Promise<Convention[]> {
  const qs = new URLSearchParams()
  if (category) qs.set('category', encodeURIComponent(category))
  if (includeArchived) qs.set('include_archived', 'true')
  if (project) qs.set('project', project)
  const query = qs.toString()
  return request<Convention[]>(query ? `/v1/conventions?${query}` : '/v1/conventions')
}

export function getConvention(id: string | number): Promise<Convention> {
  return request<Convention>(`/v1/conventions/${encodeURIComponent(String(id))}`)
}

export function storeConvention(input: StoreConventionInput): Promise<Convention> {
  return request<Convention>('/v1/conventions', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateConvention(id: string | number, input: UpdateConventionInput): Promise<Convention> {
  return request<Convention>(`/v1/conventions/${encodeURIComponent(String(id))}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function archiveConvention(id: string | number): Promise<void> {
  return request<void>(`/v1/conventions/${encodeURIComponent(String(id))}/archive`, { method: 'POST' })
}

export function restoreConvention(id: string | number): Promise<void> {
  return request<void>(`/v1/conventions/${encodeURIComponent(String(id))}/restore`, { method: 'POST' })
}

export function deleteConvention(id: string | number): Promise<void> {
  return request<void>(`/v1/conventions/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
}

// ── Policy Check ──────────────────────────────────────────────────────────────

export function checkPolicy(action: string, resource: string, context?: Record<string, any>): Promise<any> {
  return request<any>('/v1/policy/check', {
    method: 'POST',
    body: JSON.stringify({ action, resource, context }),
  })
}

// ── Policies ──────────────────────────────────────────────────────────────────

export interface Policy {
  id: string
  name?: string
  description?: string
  rules?: unknown
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export function listPolicies(project?: string): Promise<Policy[]> {
  const qs = new URLSearchParams()
  if (project) qs.set('project', project)
  const query = qs.toString()
  return request<Policy[]>(query ? `/v1/policies?${query}` : '/v1/policies')
}

export function createPolicy(data: { name: string; description?: string; rules?: unknown }): Promise<Policy> {
  return request<Policy>('/v1/policies', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function deletePolicy(id: string): Promise<void> {
  return request<void>(`/v1/policies/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function updatePolicy(id: string, data: { name?: string; description?: string; rules?: unknown }): Promise<Policy> {
  return request<Policy>(`/v1/policies/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

// ── Projects ──────────────────────────────────────────────────────────────────

export interface Project {
  id: string
  name: string
  description?: string | null
  is_archived?: boolean
  created_at?: string
  [key: string]: unknown
}

export interface ProjectMember {
  user_id: string
  role: string
  name?: string
  email?: string
  [key: string]: unknown
}

export function listProjects(params: { include_archived?: boolean } = {}): Promise<Project[]> {
  const qs = params.include_archived ? '?include_archived=true' : ''
  return request<Project[]>(`/v1/projects${qs}`)
}

export function createProject(data: { name: string; description?: string }): Promise<Project> {
  return request<Project>('/v1/projects', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function updateProject(
  id: string,
  data: Partial<{ description: string; custom_instructions: string; retention_days: number; archived: boolean }>,
): Promise<void> {
  return request<void>(`/v1/admin/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export function getProjectMembers(projectId: string): Promise<ProjectMember[]> {
  return request<ProjectMember[]>(`/v1/projects/${encodeURIComponent(projectId)}/members`)
}

export function addProjectMember(projectId: string, userId: string): Promise<void> {
  return request<void>(`/v1/projects/${encodeURIComponent(projectId)}/members`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  })
}

// ── Admin Users ───────────────────────────────────────────────────────────────

export interface OrgUser {
  id: string
  email?: string
  name?: string
  role?: string
  status?: string
  last_login_at?: string
  api_key_usage?: number
  [key: string]: unknown
}

export interface OrgRole {
  id: string
  name: string
  permissions?: string[]
  [key: string]: unknown
}

export function listUsers(): Promise<OrgUser[]> {
  return request<OrgUser[]>('/v1/admin/users')
}

export function inviteUser(data: { email: string; role?: string }): Promise<{ id: string; [key: string]: unknown }> {
  return request('/v1/admin/invites', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function disableUser(userId: string): Promise<void> {
  return request<void>(`/v1/admin/users/${encodeURIComponent(userId)}/disable`, { method: 'POST' })
}

export function enableUser(userId: string): Promise<void> {
  return request<void>(`/v1/admin/users/${encodeURIComponent(userId)}/enable`, { method: 'POST' })
}

export function listRoles(): Promise<OrgRole[]> {
  return request<OrgRole[]>('/v1/roles')
}

export interface CreateRoleInput {
  name: string
  description?: string
  permissions: string[]
}

export function createRole(data: CreateRoleInput): Promise<OrgRole> {
  return request<OrgRole>('/v1/roles', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function deleteRole(id: string): Promise<void> {
  return request<void>(`/v1/roles/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function assignUserRole(userId: string, role: string): Promise<void> {
  return request<void>(`/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  })
}

export function getUsersByRole(role: string): Promise<OrgUser[]> {
  return request<OrgUser[]>(`/v1/admin/users?role=${encodeURIComponent(role)}`)
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

export interface Webhook {
  id: string
  url: string
  name?: string
  events?: string[]
  created_at?: string
  [key: string]: unknown
}

export function listWebhooks(): Promise<Webhook[]> {
  return request<Webhook[]>('/v1/webhooks')
}

export function createWebhook(data: { url: string; events: string[]; name?: string }): Promise<Webhook> {
  return request<Webhook>('/v1/webhooks', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function updateWebhook(id: string, data: { url?: string; events?: string[]; name?: string }): Promise<Webhook> {
  return request<Webhook>(`/v1/webhooks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export function deleteWebhook(id: string): Promise<void> {
  return request<void>(`/v1/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function testWebhook(id: string): Promise<unknown> {
  return request<unknown>(`/v1/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST' })
}

// ── Org Settings ──────────────────────────────────────────────────────────────

export interface OrgSettings {
  retention_days?: number | null
  custom_instructions?: string | null
  announcement?: string | null
  min_password_length?: number | null
  branding?: Record<string, unknown> | null
  [key: string]: unknown
}

export interface UpdateOrgSettingsInput {
  custom_instructions?: string
  retention_days?: number
  min_password_length?: number
}

export function getOrgSettings(): Promise<OrgSettings> {
  return request<OrgSettings>('/v1/admin/org/settings')
}

export function updateOrgSettings(input: UpdateOrgSettingsInput): Promise<OrgSettings> {
  const body: Record<string, unknown> = {}
  if (input.custom_instructions !== undefined) body.custom_instructions = input.custom_instructions
  if (input.retention_days      !== undefined) body.retention_days      = input.retention_days
  if (input.min_password_length !== undefined) body.min_password_length = input.min_password_length
  return request<OrgSettings>('/v1/admin/org/settings', {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

// ── Org Stats ─────────────────────────────────────────────────────────────────

export interface OrgStats {
  total_memories?: number | null
  total_users?: number | null
  total_code_projects?: number | null
  total_api_calls?: number | null
  storage_usage?: number | null
  [key: string]: unknown
}

export interface AgentActivityEvent {
  id?: string | number
  agent?: string
  action?: string
  project?: string
  created_at?: string
  [key: string]: unknown
}

export interface TagStat {
  tag: string
  count: number
  [key: string]: unknown
}

export function getStats(): Promise<OrgStats> {
  return request<OrgStats>('/v1/admin/stats')
}

export function getAgentActivity(limit?: number): Promise<AgentActivityEvent[]> {
  const qs = limit !== undefined ? `?limit=${limit}` : ''
  return request<AgentActivityEvent[]>(`/v1/admin/stats/agent-activity${qs}`)
}

export function getTagStats(): Promise<TagStat[]> {
  return request<TagStat[]>('/v1/admin/stats/tags')
}

// ── Import Memories ───────────────────────────────────────────────────────────

export interface ImportMemoryItem {
  content: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

export interface ImportMemoriesResult {
  imported: number
  [key: string]: unknown
}

export function importMemories(memories: ImportMemoryItem[]): Promise<ImportMemoriesResult> {
  return request<ImportMemoriesResult>('/v1/admin/memories/import', {
    method: 'POST',
    body: JSON.stringify({ memories }),
  })
}

// ── Duplicate Memories ────────────────────────────────────────────────────────

export interface DuplicateGroup {
  ids: string[]
  [key: string]: unknown
}

export function findDuplicateMemories(): Promise<DuplicateGroup[]> {
  return request<DuplicateGroup[]>('/v1/admin/stats/duplicates')
}

// ── Memory Trends ─────────────────────────────────────────────────────────────

export interface TrendEntry {
  date: string
  count: number
  [key: string]: unknown
}

export function getMemoryTrends(period?: string): Promise<TrendEntry[]> {
  const qs = period ? `?period=${encodeURIComponent(period)}` : ''
  return request<TrendEntry[]>(`/v1/admin/stats/trends${qs}`)
}

// ── Org Identity ──────────────────────────────────────────────────────────────

export interface OrgIdentity {
  id?: string | number
  name?: string
  slug?: string
  [key: string]: unknown
}

export function updateOrg(data: { name?: string; slug?: string }): Promise<OrgIdentity> {
  return request<OrgIdentity>('/v1/admin/org', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

// ── Tag Rename ────────────────────────────────────────────────────────────────

export interface RenameTagResult {
  updated: number
  [key: string]: unknown
}

export function renameTag(oldTag: string, newTag: string): Promise<RenameTagResult> {
  return request<RenameTagResult>('/v1/admin/tags/rename', {
    method: 'POST',
    body: JSON.stringify({ old_tag: oldTag, new_tag: newTag }),
  })
}

// ── Announcement ──────────────────────────────────────────────────────────────

export interface AnnouncementResult {
  message?: string | null
  type?: string | null
  [key: string]: unknown
}

export function setAnnouncement(message: string | null, type?: 'info' | 'warning' | 'error'): Promise<AnnouncementResult> {
  const body: Record<string, unknown> = { message }
  if (type !== undefined) body.type = type
  return request<AnnouncementResult>('/v1/admin/org/announcement', {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

// ── Memory Facets ─────────────────────────────────────────────────────────────

export interface MemoryFacets {
  tags: { value: string; count: number }[]
  projects: { value: string; count: number }[]
  types: { value: string; count: number }[]
  periods: { value: string; count: number }[]
  [key: string]: unknown
}

export function getMemoryFacets(): Promise<MemoryFacets> {
  return request<MemoryFacets>('/v1/admin/stats/memory-facets')
}

// ── Usage Stats ───────────────────────────────────────────────────────────────

export interface UsageStats {
  total_requests?: number | null
  active_api_keys?: number | null
  most_active_agents?: { agent: string; requests: number }[] | null
  rate_limit_data?: unknown | null
  [key: string]: unknown
}

export function getUsageStats(): Promise<UsageStats> {
  return request<UsageStats>('/v1/admin/stats/usage')
}

// ── Session Update ────────────────────────────────────────────────────────────

export interface UpdateSessionInput {
  summary?: string
  description?: string
}

export interface SessionSummary {
  id: string
  summary?: string
  description?: string
  [key: string]: unknown
}

export function updateSession(id: string, input: UpdateSessionInput): Promise<SessionSummary> {
  return request<SessionSummary>(`/v1/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export interface Session {
  id: string
  summary?: string
  description?: string
  created_at?: string
  updated_at?: string
  memory_count?: number
  [key: string]: unknown
}

export interface ListSessionsInput {
  limit?: number
}

export function listSessions(input: ListSessionsInput = {}): Promise<Session[]> {
  const qs = input.limit !== undefined ? `?limit=${input.limit}` : ''
  return request<Session[]>(`/v1/sessions${qs}`)
}

export function deleteSession(id: string): Promise<void> {
  return request<void>(`/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function createSession(data: { summary?: string; description?: string } = {}): Promise<Session> {
  return request<Session>('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

// ── Convention Pin ────────────────────────────────────────────────────────────

export function pinConvention(id: string): Promise<Convention> {
  return request<Convention>(`/v1/conventions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ weight: 999 }),
  })
}

// ── Memory Note ───────────────────────────────────────────────────────────────

export function updateMemoryNote(id: string, note: string): Promise<void> {
  return request<void>(`/v1/admin/memories/${encodeURIComponent(id)}/note`, {
    method: 'PATCH',
    body: JSON.stringify({ note }),
  })
}

// ── Schedule Memory Delete ───────────────────────────────────────────────────

export function scheduleMemoryDelete(memoryId: string, deleteAt: string): Promise<void> {
  return request<void>(`/v1/admin/memories/${encodeURIComponent(memoryId)}/schedule-delete`, {
    method: 'PATCH',
    body: JSON.stringify({ delete_at: deleteAt }),
  })
}

// ── Reindex Code Project ──────────────────────────────────────────────────────

export function reindexProject(projectId: string): Promise<void> {
  return request<void>(`/v1/code/projects/${encodeURIComponent(projectId)}/reindex`, { method: 'POST' })
}

// ── Memory Health ─────────────────────────────────────────────────────────────

export interface MemoryHealth {
  total_memories: number
  duplicate_count: number
  stale_count: number
  untagged_count: number
  [key: string]: unknown
}

export function getMemoryHealth(): Promise<MemoryHealth> {
  return request<MemoryHealth>('/v1/admin/memories/health')
}

// ── Export Memories ───────────────────────────────────────────────────────────

export interface ExportMemoriesInput {
  query?: string
  tags?: string[]
  collection_id?: string
  format?: 'json' | 'csv'
}

export async function exportMemories(input: ExportMemoriesInput = {}): Promise<string> {
  if (!BASE_URL) throw new Error('NEXUSMIND_BASE_URL is not set. Run: npx @smart-coder-labs/nexusmind-mcp setup')
  if (!API_KEY)  throw new Error('NEXUSMIND_API_KEY is not set. Run: npx @smart-coder-labs/nexusmind-mcp setup')

  const qs = new URLSearchParams()
  if (input.query)         qs.set('query',         input.query)
  if (input.collection_id) qs.set('collection_id', input.collection_id)
  if (input.format)        qs.set('format',        input.format)
  if (input.tags && input.tags.length > 0) qs.set('tags', input.tags.join(','))

  const res = await fetch(`${BASE_URL}/v1/memory/export?${qs}`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
    throw new Error(body.error ?? res.statusText)
  }

  return res.text()
}

// ── Harnesses (read-only, Phase 1) ───────────────────────────────────────────
//
// These are thin, permissioned wrappers over already-shipped backend harness
// endpoints. The MCP layer adds no new authority: `harness:read` is enforced
// backend-side on the Bearer token, and a missing permission surfaces here as
// a normal `request<T>()` error (see the 401/`!res.ok` branches above), which
// the calling tool renders as `isError: true` — no client-side permission
// logic lives in this file.
//
// `getHarnessVersion` hits the *preview* endpoint, which returns the manifest
// for display without requiring a prior `approve_install` — see design.md
// §1 step 1 (`version_manifest_is_readable_for_preview_without_approval`).
// It is metadata/preview-only: callers must not treat its response as an
// authorization to write files (that requires the separate approval-gated
// `downloadHarnessVersion` + `approve_install` flow, out of scope for Phase 1).

export type HarnessFormat =
  | 'agent' | 'skill' | 'command' | 'hook'
  | 'output_style' | 'claude_code_plugin' | 'theme'

export type HarnessTarget = 'claude' | 'codex' | 'cursor'

export interface HarnessWarningMetadata {
  executable?: boolean
  requires_approval?: boolean
  [key: string]: unknown
}

export interface Harness {
  id: string
  slug: string
  name: string
  description?: string | null
  owner_user_id?: string
  project_id?: string | null
  visibility?: string
  latest_version?: string
  targets?: HarnessTarget[]
  format?: HarnessFormat
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export interface HarnessRecommendation {
  harness_id: string
  version: string
  name: string
  targets: HarnessTarget[]
  format: HarnessFormat
  approval_required?: boolean
  warning_metadata?: HarnessWarningMetadata
  [key: string]: unknown
}

export interface HarnessManifestComponentSummary {
  path?: string
  kind?: string
  media_type?: string
  size_bytes?: number
  sha256?: string
  executable?: boolean
  [key: string]: unknown
}

export interface HarnessVersion {
  harness_id: string
  version: string
  schema_version?: string
  format: HarnessFormat
  targets: HarnessTarget[]
  manifest_hash: string
  components?: HarnessManifestComponentSummary[]
  security?: { requires_approval?: boolean; executable?: boolean; secret_scan_status?: string; [key: string]: unknown }
  provenance?: { source?: string; [key: string]: unknown }
  created_at?: string
  [key: string]: unknown
}

export interface HarnessConfigReview {
  id: string
  source_tool: HarnessTarget
  status: string
  redacted_config?: unknown
  redaction_report?: unknown
  content_hash?: string
  created_at?: string
  [key: string]: unknown
}

export interface ListHarnessesInput {
  target?: HarnessTarget
  owner_user_id?: string
}

export function listHarnesses(input: ListHarnessesInput = {}): Promise<Harness[]> {
  const qs = new URLSearchParams()
  if (input.target)        qs.set('target',        input.target)
  if (input.owner_user_id) qs.set('owner_user_id', input.owner_user_id)
  const query = qs.toString()
  return request<Harness[]>(query ? `/v1/harnesses?${query}` : '/v1/harnesses')
}

export interface RecommendHarnessesInput {
  target?: HarnessTarget
}

export function recommendHarnesses(input: RecommendHarnessesInput = {}): Promise<HarnessRecommendation[]> {
  const qs = new URLSearchParams()
  if (input.target) qs.set('target', input.target)
  const query = qs.toString()
  return request<HarnessRecommendation[]>(query ? `/v1/harness-recommendations?${query}` : '/v1/harness-recommendations')
}

export function getHarnessVersion(harnessId: string, version: string): Promise<HarnessVersion> {
  return request<HarnessVersion>(
    `/v1/harnesses/${encodeURIComponent(harnessId)}/versions/${encodeURIComponent(version)}`,
  )
}

export interface ListHarnessConfigReviewsInput {
  status?: string
}

export function listHarnessConfigReviews(input: ListHarnessConfigReviewsInput = {}): Promise<HarnessConfigReview[]> {
  const qs = new URLSearchParams()
  if (input.status) qs.set('status', input.status)
  const query = qs.toString()
  return request<HarnessConfigReview[]>(query ? `/v1/harness-config-reviews?${query}` : '/v1/harness-config-reviews')
}

// ── Harnesses (install core, Phase 2) ────────────────────────────────────────
//
// `downloadHarnessVersion` is the approval-gated read: unlike `getHarnessVersion`
// (preview, always readable), the backend requires a persisted `approve_install`
// before this succeeds. `approveHarnessInstall` records that approval keyed on
// `manifest_hash` (and warning acknowledgement for executable formats).
// `recordHarnessInstallResult` reports the outcome after materialization —
// never raw file contents, only status + metadata (design.md §1, §4).

export type HarnessTargetScope = 'user' | 'project'

export interface HarnessManifestComponent {
  path: string
  kind: string
  media_type?: string
  size_bytes: number
  sha256: string
  content?: string
  executable?: boolean
  entries?: HarnessManifestComponent[]
  [key: string]: unknown
}

export interface HarnessManifest {
  schema_version: string
  format: HarnessFormat
  targets: HarnessTarget[]
  components: HarnessManifestComponent[]
  provenance?: { source?: string; [key: string]: unknown }
  security?: { requires_approval?: boolean; executable?: boolean; secret_scan_status?: string; [key: string]: unknown }
  [key: string]: unknown
}

export interface HarnessDownloadResponse {
  harness_id: string
  version: string
  manifest: HarnessManifest
  manifest_hash: string
  approval_required?: boolean
  [key: string]: unknown
}

export function downloadHarnessVersion(harnessId: string, version: string): Promise<HarnessDownloadResponse> {
  return request<HarnessDownloadResponse>(
    `/v1/harnesses/${encodeURIComponent(harnessId)}/versions/${encodeURIComponent(version)}/download`,
  )
}

export interface HarnessApproval {
  approval_id: string
  harness_id: string
  version: string
  manifest_hash: string
  target_tool?: HarnessTarget
  target_scope?: HarnessTargetScope
  status?: string
  created_at?: string
  [key: string]: unknown
}

export interface ApproveHarnessInstallInput {
  target_tool: HarnessTarget
  target_scope: HarnessTargetScope
  manifest_hash: string
  metadata?: Record<string, unknown>
}

export function approveHarnessInstall(
  harnessId: string,
  version: string,
  input: ApproveHarnessInstallInput,
): Promise<HarnessApproval> {
  return request<HarnessApproval>(
    `/v1/harnesses/${encodeURIComponent(harnessId)}/versions/${encodeURIComponent(version)}/approval`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}

export type HarnessInstallResultStatus = 'installed' | 'failed'

export interface RecordHarnessInstallResultInput {
  approval_id: string
  manifest_hash: string
  status: HarnessInstallResultStatus
  metadata?: Record<string, unknown>
}

export function recordHarnessInstallResult(
  harnessId: string,
  version: string,
  input: RecordHarnessInstallResultInput,
): Promise<HarnessApproval> {
  return request<HarnessApproval>(
    `/v1/harnesses/${encodeURIComponent(harnessId)}/versions/${encodeURIComponent(version)}/install-result`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}

// ── Harnesses (create/upload, Phase 3) ───────────────────────────────────────
//
// Thin, permissioned wrappers over already-shipped backend endpoints,
// gated by `harness:write` — a missing permission surfaces as a normal
// `request<T>()` error (403), same pattern as the Phase 1/2 harness
// methods above. No client-side authority is added here: the manifest
// passed to `publishHarnessVersion` must already be built locally by
// `build_harness_manifest_from_path` (secret-scanned, sha256-hashed,
// inline-limited); this client method does not re-run that logic, it only
// transports the already-validated manifest (design.md §4).

export interface CreateHarnessRequest {
  slug: string
  name: string
  description?: string
  project_id?: string
  visibility?: string
  owner_user_id?: string
}

export interface CreateHarnessResponse {
  id: string
  slug: string
  owner_user_id?: string
  [key: string]: unknown
}

export function createHarness(input: CreateHarnessRequest): Promise<CreateHarnessResponse> {
  const body: Record<string, unknown> = { slug: input.slug, name: input.name }
  if (input.description !== undefined)   body.description   = input.description
  if (input.project_id !== undefined)    body.project_id    = input.project_id
  if (input.visibility !== undefined)    body.visibility    = input.visibility
  if (input.owner_user_id !== undefined) body.owner_user_id = input.owner_user_id
  return request<CreateHarnessResponse>('/v1/harnesses', { method: 'POST', body: JSON.stringify(body) })
}

export interface PublishHarnessVersionInput {
  version: string
  manifest: Record<string, unknown>
  manifest_hash?: string
}

export function publishHarnessVersion(
  harnessId: string,
  input: PublishHarnessVersionInput,
): Promise<HarnessVersion> {
  const body: Record<string, unknown> = { version: input.version, manifest: input.manifest }
  if (input.manifest_hash !== undefined) body.manifest_hash = input.manifest_hash
  return request<HarnessVersion>(
    `/v1/harnesses/${encodeURIComponent(harnessId)}/versions`,
    { method: 'POST', body: JSON.stringify(body) },
  )
}

// ── Harness config review upload (Phase 4, optional) ────────────────────────
//
// The local redaction/preview MUST happen before this call (harness-config-review
// spec: "Agent-session config review requires local preview before upload").
// This method only transports the already-redacted snapshot; it performs no
// redaction itself. The backend still enforces raw-content rejection
// independently as a second gate.

export interface CreateHarnessConfigReviewInput {
  source_tool: HarnessTarget
  redacted_config: unknown
  redaction_report: unknown
  content_hash: string
  status?: string
}

export function createHarnessConfigReview(
  input: CreateHarnessConfigReviewInput,
): Promise<HarnessConfigReview> {
  const body: Record<string, unknown> = {
    source_tool: input.source_tool,
    redacted_config: input.redacted_config,
    redaction_report: input.redaction_report,
    content_hash: input.content_hash,
  }
  if (input.status !== undefined) body.status = input.status
  return request<HarnessConfigReview>('/v1/harness-config-reviews', { method: 'POST', body: JSON.stringify(body) })
}
