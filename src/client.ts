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

  // Some relationship POST endpoints (e.g. spec-links) return 201 CREATED
  // with an empty body (content-length 0). res.json() throws SyntaxError
  // on an empty body, so read as text first and treat any empty/whitespace
  // body as no-content regardless of status, instead of special-casing 204.
  const text = await res.text()
  if (text.trim() === '') return undefined as T
  return JSON.parse(text) as T
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

export interface HarnessVersionSummary {
  id: string
  version: string
  manifest_hash: string
  targets?: string[]
  format?: string
  status?: string
  published_at?: string
}

export interface Harness {
  id: string
  slug: string
  name: string
  description?: string | null
  owner_user_id?: string
  project_id?: string | null
  visibility?: string
  // The wire shape is an OBJECT, not a string. Typing it as `string` made
  // `\`v${h.latest_version}\`` render "v[object Object]" in every harness listing.
  latest_version?: HarnessVersionSummary
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
  // Components live INSIDE the manifest on the wire. There is no top-level
  // `components` field; declaring one made every version report "Components: 0".
  manifest?: {
    components?: HarnessManifestComponentSummary[]
    [key: string]: unknown
  }
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

// ── Tasks ────────────────────────────────────────────────────────────────────
//
// Thin permissioned wrappers over the backend task API (design.md §3, §5.2).
// Every route is gated server-side on the caller's Bearer key (`task:read` /
// `task:write` / `task:assign` / `task:delete` / `task:manage`) — this file
// adds no client-side authority and never resolves `me` itself; `assignee=me`
// is a literal query value the backend resolves from the Bearer token
// (design.md §5.1 — "'me' derives from the API key server-side; no user arg").

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled'
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'
export type SprintStatus = 'planned' | 'active' | 'completed'

export interface TaskAssignee {
  id: string
  name?: string
  email?: string
  [key: string]: unknown
}

export interface Task {
  id: string
  org_id?: string
  project: string
  title: string
  description?: string | null
  status: TaskStatus
  priority?: TaskPriority
  due_date?: string | null
  parent_id?: string | null
  sprint_id?: string | null
  created_by?: string
  created_at?: string
  updated_at?: string
  archived_at?: string | null
  assignees?: TaskAssignee[]
  labels?: string[]
  comment_count?: number
  spec_links?: string[]
  subtask_count?: number
  [key: string]: unknown
}

export interface TaskComment {
  id: string
  task_id: string
  user_id: string
  author_name?: string
  body: string
  created_at?: string
  [key: string]: unknown
}

export interface Sprint {
  id: string
  org_id?: string
  project: string
  name: string
  goal?: string | null
  starts_at?: string | null
  ends_at?: string | null
  status: SprintStatus
  created_by?: string
  created_at?: string
  archived_at?: string | null
  task_count?: number
  [key: string]: unknown
}

export interface SprintRetrospective {
  id: string
  sprint_id: string
  went_well?: string | null
  went_wrong?: string | null
  action_items?: string | null
  created_by?: string
  author_name?: string
  created_at?: string
  [key: string]: unknown
}

export interface ListTasksInput {
  project?: string
  assignee?: string
  status?: TaskStatus
  sprint?: string
  label?: string
  parent_id?: string
  include_archived?: boolean
  limit?: number
  offset?: number
}

function taskListQuery(input: ListTasksInput): string {
  const qs = new URLSearchParams()
  if (input.project)          qs.set('project',          input.project)
  if (input.assignee)         qs.set('assignee',         input.assignee)
  if (input.status)           qs.set('status',           input.status)
  if (input.sprint)           qs.set('sprint',           input.sprint)
  if (input.label)            qs.set('label',            input.label)
  if (input.parent_id)        qs.set('parent_id',        input.parent_id)
  if (input.include_archived) qs.set('include_archived', 'true')
  if (input.limit !== undefined)  qs.set('limit',  String(input.limit))
  if (input.offset !== undefined) qs.set('offset', String(input.offset))
  return qs.toString()
}

export function listTasks(input: ListTasksInput = {}): Promise<Task[]> {
  const query = taskListQuery(input)
  return request<Task[]>(query ? `/v1/tasks?${query}` : '/v1/tasks')
}

export type ListMyTasksInput = Omit<ListTasksInput, 'assignee'>

// `assignee=me` is a literal string the backend resolves server-side from the
// Bearer token — this function never accepts or forwards a user id.
export function listMyTasks(input: ListMyTasksInput = {}): Promise<Task[]> {
  return listTasks({ ...input, assignee: 'me' })
}

export function getTask(taskId: string): Promise<Task> {
  return request<Task>(`/v1/tasks/${encodeURIComponent(taskId)}`)
}

export interface CreateTaskInput {
  project: string
  title: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  due_date?: string
  parent_id?: string
  sprint_id?: string
}

export function createTask(input: CreateTaskInput): Promise<Task> {
  const body: Record<string, unknown> = { project: input.project, title: input.title }
  if (input.description !== undefined) body.description = input.description
  if (input.status !== undefined)      body.status      = input.status
  if (input.priority !== undefined)    body.priority    = input.priority
  if (input.due_date !== undefined)    body.due_date    = input.due_date
  if (input.parent_id !== undefined)   body.parent_id   = input.parent_id
  if (input.sprint_id !== undefined)   body.sprint_id   = input.sprint_id
  return request<Task>('/v1/tasks', { method: 'POST', body: JSON.stringify(body) })
}

export interface UpdateTaskInput {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  due_date?: string
  sprint_id?: string
}

export function updateTask(taskId: string, input: UpdateTaskInput): Promise<Task> {
  const body: Record<string, unknown> = {}
  if (input.title !== undefined)       body.title       = input.title
  if (input.description !== undefined) body.description = input.description
  if (input.status !== undefined)      body.status      = input.status
  if (input.priority !== undefined)    body.priority    = input.priority
  if (input.due_date !== undefined)    body.due_date    = input.due_date
  if (input.sprint_id !== undefined)   body.sprint_id   = input.sprint_id
  return request<Task>(`/v1/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export function deleteTask(taskId: string): Promise<void> {
  return request<void>(`/v1/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' })
}

export function assignTask(taskId: string, userIds: string[]): Promise<TaskAssignee[]> {
  return request<TaskAssignee[]>(
    `/v1/tasks/${encodeURIComponent(taskId)}/assignees`,
    { method: 'POST', body: JSON.stringify({ user_ids: userIds }) },
  )
}

export function unassignTask(taskId: string, userId: string): Promise<void> {
  return request<void>(
    `/v1/tasks/${encodeURIComponent(taskId)}/assignees/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  )
}

export function addTaskComment(taskId: string, body: string): Promise<TaskComment> {
  return request<TaskComment>(
    `/v1/tasks/${encodeURIComponent(taskId)}/comments`,
    { method: 'POST', body: JSON.stringify({ body }) },
  )
}

export function listTaskComments(taskId: string): Promise<TaskComment[]> {
  return request<TaskComment[]>(`/v1/tasks/${encodeURIComponent(taskId)}/comments`)
}

export function addTaskLabel(taskId: string, label: string): Promise<string[]> {
  return request<string[]>(
    `/v1/tasks/${encodeURIComponent(taskId)}/labels`,
    { method: 'POST', body: JSON.stringify({ label }) },
  )
}

export function linkTaskSpec(taskId: string, specChangeName: string): Promise<void> {
  return request<void>(
    `/v1/tasks/${encodeURIComponent(taskId)}/spec-links`,
    { method: 'POST', body: JSON.stringify({ spec_change_name: specChangeName }) },
  )
}

export function listTaskSpecs(taskId: string): Promise<string[]> {
  return request<string[]>(`/v1/tasks/${encodeURIComponent(taskId)}/spec-links`)
}

export interface ResolveTasksForSpecResponse {
  resolved: string[]
}

export function resolveTasksForSpec(specChangeName: string): Promise<ResolveTasksForSpecResponse> {
  return request<ResolveTasksForSpecResponse>(
    '/v1/tasks/resolve-by-spec',
    { method: 'POST', body: JSON.stringify({ spec_change_name: specChangeName }) },
  )
}

export interface ListSprintsInput {
  project?: string
  status?: SprintStatus
  include_archived?: boolean
  limit?: number
  offset?: number
}

export function listSprints(input: ListSprintsInput = {}): Promise<Sprint[]> {
  const qs = new URLSearchParams()
  if (input.project)          qs.set('project',          input.project)
  if (input.status)           qs.set('status',           input.status)
  if (input.include_archived) qs.set('include_archived', 'true')
  if (input.limit !== undefined)  qs.set('limit',  String(input.limit))
  if (input.offset !== undefined) qs.set('offset', String(input.offset))
  const query = qs.toString()
  return request<Sprint[]>(query ? `/v1/sprints?${query}` : '/v1/sprints')
}

export interface CreateSprintInput {
  project: string
  name: string
  goal?: string
  starts_at?: string
  ends_at?: string
}

export function createSprint(input: CreateSprintInput): Promise<Sprint> {
  const body: Record<string, unknown> = { project: input.project, name: input.name }
  if (input.goal !== undefined)       body.goal       = input.goal
  if (input.starts_at !== undefined)  body.starts_at  = input.starts_at
  if (input.ends_at !== undefined)    body.ends_at    = input.ends_at
  return request<Sprint>('/v1/sprints', { method: 'POST', body: JSON.stringify(body) })
}

export interface CreateRetrospectiveInput {
  went_well?: string
  went_wrong?: string
  action_items?: string
}

export function createSprintRetrospective(
  sprintId: string,
  input: CreateRetrospectiveInput,
): Promise<SprintRetrospective> {
  const body: Record<string, unknown> = {}
  if (input.went_well !== undefined)    body.went_well    = input.went_well
  if (input.went_wrong !== undefined)   body.went_wrong   = input.went_wrong
  if (input.action_items !== undefined) body.action_items = input.action_items
  return request<SprintRetrospective>(
    `/v1/sprints/${encodeURIComponent(sprintId)}/retrospectives`,
    { method: 'POST', body: JSON.stringify(body) },
  )
}

// ── SDD Artifacts ────────────────────────────────────────────────────────────
//
// Thin wrappers over the backend SDD API (openspec/changes/sdd-artifacts,
// design.md §4). Every fn is a straight `request<T>()` call — no client-side
// resolution, no caching, no content truncation. The store is the source of
// truth for a change's spec-driven-development artifacts, so an agent on a
// machine with no checkout can read a proposal/spec/design/tasks document in
// full.
//
// Two contracts worth stating here because they shape the callers:
//   * `PUT /v1/sdd/artifacts` is idempotent by content hash and returns **200
//     always, never 201**. "Was a revision created?" is a body flag
//     (`created_revision`), not an HTTP status.
//   * A missing artifact is a **404**, never a 200 carrying an empty document —
//     an agent must be able to tell "no design yet" from "an empty design".

/** SDD lifecycle phase. Advisory ordering; the artifact inventory is the real state. */
export type SddPhase = 'explore' | 'propose' | 'spec' | 'design' | 'tasks' | 'apply' | 'verify' | 'archive'

export type SddStatus = 'active' | 'archived' | 'abandoned'

export type SddArtifactKind =
  | 'exploration' | 'proposal' | 'spec' | 'design' | 'tasks'
  | 'apply-progress' | 'verify-report' | 'archive-report' | 'state'

export type SddMemoryRelation = 'produced' | 'informed'

/** A change — one `openspec/changes/{name}/` folder. Never carries artifact content. */
export interface SddChange {
  id: string
  org_id: string
  project: string
  name: string
  title?: string
  status: string
  phase: string
  repo_url?: string
  repo_ref?: string
  sprint_id?: string
  created_by: string
  created_at: string
  updated_at: string
  archived_at?: string | null
  /** Hydrated on the detail read only. Metadata only — no content, by design. */
  artifacts?: SddArtifact[]
  task_links?: Task[]
  memory_links?: Memory[]
}

/** One artifact file within a change. Carries NO content — content lives in revisions. */
export interface SddArtifact {
  id: string
  change_id: string
  kind: string
  /** Empty string for every kind except `spec`. Never null. */
  capability: string
  path?: string
  latest_revision: number
  created_at: string
  updated_at: string
}

/** An artifact plus the FULL content of its latest revision (the backend flattens the artifact in). */
export interface SddArtifactDetail extends SddArtifact {
  change_name: string
  project: string
  content?: string
  content_hash?: string
}

/** A full, immutable revision — with content. */
export interface SddRevision {
  id: string
  artifact_id: string
  revision: number
  content: string
  content_hash: string
  byte_size: number
  git_commit?: string
  git_path?: string
  source: string
  created_by: string
  created_at: string
}

/** Revision metadata. Has no `content` field on purpose — it cannot leak a document. */
export interface SddRevisionMeta {
  id: string
  artifact_id: string
  revision: number
  content_hash: string
  byte_size: number
  git_commit?: string
  git_path?: string
  source: string
  created_by: string
  created_at: string
}

/**
 * An FTS5 hit — a snippet plus the natural key needed to fetch the full document.
 *
 * `GET /v1/sdd/search` spans BOTH openspec trees, so `hit_type` is the discriminator:
 * a `spec` hit is the living specification (`openspec/specs/{capability}/spec.md`) and
 * has no change; an `artifact` hit is a draft inside a change and has no spec_id.
 * Those two answers mean very different things, so the fields are optional rather
 * than faked.
 */
export interface SddSearchHit {
  hit_type: 'spec' | 'artifact'
  project: string
  capability: string
  snippet: string
  /** Artifact hits only. */
  artifact_id?: string
  change_id?: string
  change_name?: string
  kind?: string
  /** Spec hits only. */
  spec_id?: string
  title?: string
}

export interface SaveSddArtifactInput {
  project: string
  change_name: string
  kind: string
  capability?: string
  content: string
  path?: string
  git_commit?: string
  git_ref?: string
}

/** `PUT /v1/sdd/artifacts` response. 200 always — `created_revision` carries the news. */
export interface SaveSddArtifactResponse {
  artifact: SddArtifact
  created_revision: boolean
}

export interface SddArtifactKey {
  project: string
  change_name: string
  kind: string
  capability?: string
}

export interface ListSddChangesInput {
  project?: string
  status?: string
  phase?: string
  sprint_id?: string
  include_archived?: boolean
}

export interface UpdateSddChangeInput {
  title?: string
  status?: string
  phase?: string
  sprint_id?: string
}

export interface LinkSddChangeMemoryInput {
  memory_id: string
  relation?: SddMemoryRelation
}

/**
 * The write path. Idempotent by content hash: re-saving byte-identical content
 * creates no revision. Creates the change when it does not exist. 200 always.
 */
export function saveSddArtifact(input: SaveSddArtifactInput): Promise<SaveSddArtifactResponse> {
  const body: Record<string, unknown> = {
    project: input.project,
    change_name: input.change_name,
    kind: input.kind,
    content: input.content,
  }
  if (input.capability  !== undefined) body.capability  = input.capability
  if (input.path        !== undefined) body.path        = input.path
  if (input.git_commit  !== undefined) body.git_commit  = input.git_commit
  if (input.git_ref     !== undefined) body.git_ref     = input.git_ref
  return request<SaveSddArtifactResponse>('/v1/sdd/artifacts', {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

/** By id → the artifact plus the FULL content of its latest revision. */
export function getSddArtifact(artifactId: string): Promise<SddArtifactDetail> {
  return request<SddArtifactDetail>(`/v1/sdd/artifacts/${encodeURIComponent(artifactId)}`)
}

/**
 * The natural-key read — a real backend route, not client-side resolution. How an
 * agent fetches "the design of change X" knowing only the change name and kind.
 */
export function getSddArtifactByKey(key: SddArtifactKey): Promise<SddArtifactDetail> {
  const qs = new URLSearchParams()
  qs.set('project',     key.project)
  qs.set('change_name', key.change_name)
  qs.set('kind',        key.kind)
  if (key.capability !== undefined) qs.set('capability', key.capability)
  return request<SddArtifactDetail>(`/v1/sdd/artifacts?${qs.toString()}`)
}

/** Revision metadata only — the response type physically cannot carry content. */
export function listSddArtifactRevisions(artifactId: string): Promise<SddRevisionMeta[]> {
  return request<SddRevisionMeta[]>(`/v1/sdd/artifacts/${encodeURIComponent(artifactId)}/revisions`)
}

/** One historical revision, with its full content. */
export function getSddArtifactRevision(artifactId: string, revision: number): Promise<SddRevision> {
  return request<SddRevision>(
    `/v1/sdd/artifacts/${encodeURIComponent(artifactId)}/revisions/${encodeURIComponent(String(revision))}`,
  )
}

/** Metadata only, never content. */
export function listSddChanges(input: ListSddChangesInput = {}): Promise<SddChange[]> {
  const qs = new URLSearchParams()
  if (input.project)          qs.set('project',          input.project)
  if (input.status)           qs.set('status',           input.status)
  if (input.phase)            qs.set('phase',            input.phase)
  if (input.sprint_id)        qs.set('sprint_id',        input.sprint_id)
  if (input.include_archived) qs.set('include_archived', 'true')
  const query = qs.toString()
  return request<SddChange[]>(query ? `/v1/sdd/changes?${query}` : '/v1/sdd/changes')
}

/** Hydrated: artifact inventory (no content) + linked tasks + linked memories. */
export function getSddChange(changeId: string): Promise<SddChange> {
  return request<SddChange>(`/v1/sdd/changes/${encodeURIComponent(changeId)}`)
}

/**
 * Phase/status transitions. `project` and `name` are deliberately not patchable —
 * the backend `deny_unknown_fields` rejects them with a 422 rather than silently
 * no-op'ing a rename that would orphan every task linked by name.
 */
export function updateSddChange(changeId: string, input: UpdateSddChangeInput): Promise<SddChange> {
  const body: Record<string, unknown> = {}
  if (input.title     !== undefined) body.title     = input.title
  if (input.status    !== undefined) body.status    = input.status
  if (input.phase     !== undefined) body.phase     = input.phase
  if (input.sprint_id !== undefined) body.sprint_id = input.sprint_id
  return request<SddChange>(`/v1/sdd/changes/${encodeURIComponent(changeId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

/** FTS across BOTH openspec trees in the caller's org — snippets, never whole documents. */
export function searchSddArtifacts(q: string, limit?: number): Promise<SddSearchHit[]> {
  const qs = new URLSearchParams()
  qs.set('q', q)
  if (limit !== undefined) qs.set('limit', String(limit))
  return request<SddSearchHit[]>(`/v1/sdd/search?${qs.toString()}`)
}

/** Idempotent for a (change, memory) pair. Returns the change's linked memories. */
export function linkSddChangeMemory(changeId: string, input: LinkSddChangeMemoryInput): Promise<Memory[]> {
  const body: Record<string, unknown> = { memory_id: input.memory_id }
  if (input.relation !== undefined) body.relation = input.relation
  return request<Memory[]>(`/v1/sdd/changes/${encodeURIComponent(changeId)}/memories`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// ── SDD Specs — the living specification ─────────────────────────────────────
//
// `openspec/specs/{capability}/spec.md` — the SOURCE OF TRUTH, as opposed to the
// in-flight drafts under `openspec/changes/{name}/`. `sdd-archive` merges a
// closing change's delta specs into it, which is when `save_sdd_spec` is called.
//
// A spec is NOT an artifact of a change. It belongs to the project and outlives the
// changes that amend it, so it has its own id, its own revision history and its own
// routes. `merged_from_change_name` is what ties the two trees together: from a spec
// you can see which changes shaped each revision.
//
// Same two contracts as the artifacts above, because they are the same contracts:
//   * `PUT /v1/sdd/specs` is idempotent by content hash and answers **200 always**;
//     "was a revision created?" is `created_revision` in the body, not the status.
//   * A missing spec is a **404**, never a 200 carrying an empty document — "this
//     capability has no contract yet" and "its contract is empty" are different facts.

/** One living specification. Never carries content — that lives in revisions. */
export interface SddSpec {
  id: string
  org_id: string
  project: string
  capability: string
  title?: string
  path?: string
  latest_revision: number
  created_by: string
  created_at: string
  updated_at: string
  archived_at?: string | null
  /** The change whose deltas produced the LATEST revision. Metadata — the list carries it. */
  last_merged_from_change_id?: string
  last_merged_from_change_name?: string
}

/** A spec plus the FULL content of its latest revision (the backend flattens the spec in). */
export interface SddSpecDetail extends SddSpec {
  content?: string
  content_hash?: string
}

/** A spec a change has merged into, and the revision that merge produced. Flattened. */
export interface SddSpecMerge extends SddSpec {
  merged_revision: number
}

/** A full, immutable spec revision — with content. */
export interface SddSpecRevision {
  id: string
  spec_id: string
  revision: number
  content: string
  content_hash: string
  byte_size: number
  merged_from_change_id?: string
  merged_from_change_name?: string
  git_commit?: string
  git_path?: string
  source: string
  created_by: string
  created_at: string
}

/** Spec revision metadata. Has no `content` field on purpose. */
export interface SddSpecRevisionMeta {
  id: string
  spec_id: string
  revision: number
  content_hash: string
  byte_size: number
  merged_from_change_id?: string
  merged_from_change_name?: string
  git_commit?: string
  git_path?: string
  source: string
  created_by: string
  created_at: string
}

export interface SaveSddSpecInput {
  project: string
  capability: string
  content: string
  title?: string
  path?: string
  merged_from_change_name?: string
  git_commit?: string
}

/** `PUT /v1/sdd/specs` response. 200 always — `created_revision` carries the news. */
export interface SaveSddSpecResponse {
  spec: SddSpec
  created_revision: boolean
}

export interface ListSddSpecsInput {
  project?: string
  include_archived?: boolean
}

/**
 * The write path. Idempotent by content hash: re-saving byte-identical content
 * creates no revision. 200 always. A `merged_from_change_name` that resolves to no
 * change is a 404 and writes NOTHING — the provenance is the point of the call.
 */
export function saveSddSpec(input: SaveSddSpecInput): Promise<SaveSddSpecResponse> {
  const body: Record<string, unknown> = {
    project: input.project,
    capability: input.capability,
    content: input.content,
  }
  if (input.title                   !== undefined) body.title                   = input.title
  if (input.path                    !== undefined) body.path                    = input.path
  if (input.merged_from_change_name !== undefined) body.merged_from_change_name = input.merged_from_change_name
  if (input.git_commit              !== undefined) body.git_commit              = input.git_commit
  return request<SaveSddSpecResponse>('/v1/sdd/specs', {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

/** By id → the spec plus the FULL content of its latest revision. */
export function getSddSpec(specId: string): Promise<SddSpecDetail> {
  return request<SddSpecDetail>(`/v1/sdd/specs/${encodeURIComponent(specId)}`)
}

/** The natural-key read — a real backend route, not client-side resolution. */
export function getSddSpecByCapability(project: string, capability: string): Promise<SddSpecDetail> {
  const qs = new URLSearchParams()
  qs.set('project', project)
  qs.set('capability', capability)
  return request<SddSpecDetail>(`/v1/sdd/specs?${qs.toString()}`)
}

/** One historical revision, with its full content. */
export function getSddSpecRevision(specId: string, revision: number): Promise<SddSpecRevision> {
  return request<SddSpecRevision>(
    `/v1/sdd/specs/${encodeURIComponent(specId)}/revisions/${encodeURIComponent(String(revision))}`,
  )
}

/** Revision metadata only — the response type physically cannot carry content. */
export function listSddSpecRevisions(specId: string): Promise<SddSpecRevisionMeta[]> {
  return request<SddSpecRevisionMeta[]>(`/v1/sdd/specs/${encodeURIComponent(specId)}/revisions`)
}

/** Metadata only, never content. */
export function listSddSpecs(input: ListSddSpecsInput = {}): Promise<SddSpec[]> {
  const qs = new URLSearchParams()
  if (input.project)          qs.set('project',          input.project)
  if (input.include_archived) qs.set('include_archived', 'true')
  const query = qs.toString()
  return request<SddSpec[]>(query ? `/v1/sdd/specs?${query}` : '/v1/sdd/specs')
}

/** Which living specifications a change has merged its deltas into. */
export function listSddSpecsForChange(changeId: string): Promise<SddSpecMerge[]> {
  return request<SddSpecMerge[]>(`/v1/sdd/changes/${encodeURIComponent(changeId)}/specs`)
}

// ── Clients (company brain) ──────────────────────────────────────────────────
//
// Thin permissioned wrappers over the backend client API. Every route is gated
// server-side (`client:read` / `client:write`) on the caller's Bearer key, and
// a hidden client is reported as 404 (never 403) by the backend — this file adds
// no client-side authority. `slug` is immutable after create: `updateClient`
// deliberately omits it, matching the backend which rejects a slug in a PATCH.

export type ClientStatus = 'active' | 'paused' | 'offboarded'

export interface Client {
  id: string
  org_id: string
  name: string
  slug: string
  status: string
  archived_at?: string | null
  created_at: string
  [key: string]: unknown
}

export interface ClientMember {
  id: string
  client_id: string
  user_id: string
  email: string
  name: string
  role: string
  created_at: string
  [key: string]: unknown
}

export interface ListClientsInput {
  include_archived?: boolean
}

export function listClients(input: ListClientsInput = {}): Promise<Client[]> {
  const qs = input.include_archived ? '?include_archived=true' : ''
  return request<Client[]>(`/v1/clients${qs}`)
}

export interface CreateClientInput {
  name: string
  slug: string
  status?: ClientStatus
}

export function createClient(input: CreateClientInput): Promise<Client> {
  const body: Record<string, unknown> = { name: input.name, slug: input.slug }
  if (input.status !== undefined) body.status = input.status
  return request<Client>('/v1/clients', { method: 'POST', body: JSON.stringify(body) })
}

export interface UpdateClientInput {
  name?: string
  status?: ClientStatus
}

export function updateClient(id: string, input: UpdateClientInput): Promise<Client> {
  const body: Record<string, unknown> = {}
  if (input.name   !== undefined) body.name   = input.name
  if (input.status !== undefined) body.status = input.status
  return request<Client>(`/v1/clients/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function archiveClient(id: string): Promise<void> {
  return request<void>(`/v1/clients/${encodeURIComponent(id)}/archive`, { method: 'POST' })
}

/** Refused with 422 by the backend if the client still owns projects. */
export function deleteClient(id: string): Promise<void> {
  return request<void>(`/v1/clients/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function listClientMembers(id: string): Promise<ClientMember[]> {
  return request<ClientMember[]>(`/v1/clients/${encodeURIComponent(id)}/members`)
}

export interface AddClientMemberInput {
  user_id: string
  role?: string
}

export function addClientMember(id: string, input: AddClientMemberInput): Promise<void> {
  const body: Record<string, unknown> = { user_id: input.user_id }
  if (input.role !== undefined) body.role = input.role
  return request<void>(`/v1/clients/${encodeURIComponent(id)}/members`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function removeClientMember(id: string, userId: string): Promise<void> {
  return request<void>(
    `/v1/clients/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  )
}

// ── Usage metrics (tokens + execution time) ──────────────────────────────────
//
// `reportUsage` ingests one work event (gated `memory:write` on the target
// project). `getUsageSummary` and `runUsageBackfill` are privileged: the backend
// restricts summary to admin/super_user (admins scoped to visible projects) and
// backfill to super_user only. This client adds no scoping of its own.

export interface ReportUsageInput {
  project?: string
  task_id?: string
  session_id?: string
  model?: string
  tokens_in?: number
  tokens_out?: number
  duration_ms?: number
  event_ts?: string
}

export function reportUsage(input: ReportUsageInput): Promise<{ id: string }> {
  const body: Record<string, unknown> = {}
  if (input.project     !== undefined) body.project     = input.project
  if (input.task_id     !== undefined) body.task_id     = input.task_id
  if (input.session_id  !== undefined) body.session_id  = input.session_id
  if (input.model       !== undefined) body.model       = input.model
  if (input.tokens_in   !== undefined) body.tokens_in   = input.tokens_in
  if (input.tokens_out  !== undefined) body.tokens_out  = input.tokens_out
  if (input.duration_ms !== undefined) body.duration_ms = input.duration_ms
  if (input.event_ts    !== undefined) body.event_ts    = input.event_ts
  return request<{ id: string }>('/v1/usage', { method: 'POST', body: JSON.stringify(body) })
}

export type UsageSummaryLevel = 'task' | 'project' | 'client' | 'org' | 'model' | 'user'

export interface UsageSummaryRow {
  key_id: string | null
  key_name: string
  tokens_in: number
  tokens_out: number
  tokens_total: number
  duration_ms: number
  event_count: number
}

export interface UsageSummaryResponse {
  rows: UsageSummaryRow[]
  totals: UsageSummaryRow
}

export interface GetUsageSummaryInput {
  level?: UsageSummaryLevel
  from?: string
  to?: string
  client_id?: string
  project_id?: string
}

export function getUsageSummary(input: GetUsageSummaryInput = {}): Promise<UsageSummaryResponse> {
  const qs = new URLSearchParams()
  if (input.level)      qs.set('level',      input.level)
  if (input.from)       qs.set('from',       input.from)
  if (input.to)         qs.set('to',         input.to)
  if (input.client_id)  qs.set('client_id',  input.client_id)
  if (input.project_id) qs.set('project_id', input.project_id)
  const query = qs.toString()
  return request<UsageSummaryResponse>(query ? `/v1/usage/summary?${query}` : '/v1/usage/summary')
}

export function runUsageBackfill(): Promise<{ inserted: number }> {
  return request<{ inserted: number }>('/v1/usage/backfill', { method: 'POST' })
}

// ── Code locate (token-cheap "jump to the file") ─────────────────────────────
//
// Same query embedding + cosine ranking as `searchCode`, but the response is a
// lean, deduped-by-file list of ranked file paths — no chunk bodies. Returns 404
// if the project has not been indexed. Default limit 5 (backend-applied).

export interface LocateCodeHit {
  file_path: string
  top_symbol?: string | null
  score: number
}

export interface LocateCodeResponse {
  results: LocateCodeHit[]
}

export interface LocateCodeInput {
  project: string
  query: string
  limit?: number
}

export function locateCode(input: LocateCodeInput): Promise<LocateCodeResponse> {
  const body: Record<string, unknown> = { project: input.project, query: input.query }
  if (input.limit !== undefined) body.limit = input.limit
  return request<LocateCodeResponse>('/v1/code/locate', { method: 'POST', body: JSON.stringify(body) })
}

// ── Promote memory (client/project scope → org asset) ────────────────────────
//
// Always an explicit call. The backend promotes a client- or project-scoped
// memory into an organization asset, keeping lineage in `promoted_from`. Returns
// the newly promoted memory (HTTP 201).

export function promoteMemory(id: string): Promise<Memory> {
  return request<Memory>(`/v1/memory/${encodeURIComponent(id)}/promote`, { method: 'POST' })
}

// ── Record decision (ADR) ────────────────────────────────────────────────────
//
// Composes a structured ADR document and stores it as a `decision` memory. Same
// composition the legacy `record_decision` tool performs — kept here as a single
// wrapper so the reduced profile can wire it to one `run` closure. Adds no
// authority: it delegates to `storeMemory` (gated `memory:write` server-side).

export interface RecordDecisionInput {
  title: string
  context: string
  options_considered: string[]
  decision: string
  rationale: string
  consequences?: string
  project?: string
  tags?: string[]
}

export function recordDecision(input: RecordDecisionInput): Promise<StoreMemoryResponse> {
  const content = [
    `# Decision: ${input.title}`,
    '',
    '## Context',
    input.context,
    '',
    '## Options Considered',
    ...input.options_considered.map(o => `- ${o}`),
    '',
    '## Decision',
    input.decision,
    '',
    '## Rationale',
    input.rationale,
    ...(input.consequences ? ['', '## Consequences', input.consequences] : []),
  ].join('\n')
  return storeMemory({
    content,
    title: input.title,
    type: 'decision',
    tags: ['adr', 'decision', ...(input.tags ?? [])],
    project: input.project,
  })
}

// ── Get context (team conventions + memories) ────────────────────────────────
//
// The session-bootstrap read: team conventions (highest authority) plus recent
// memories for a project. Returns structured data (the reduced fabric paginates
// it); the legacy `get_context` tool renders the same two lists as prose. Reuses
// the existing `listConventions` / `listMemories` reads — no new endpoint.

export interface GetContextInput {
  project?: string
  limit?: number
  include_conventions?: boolean
  include_memories?: boolean
}

export interface ContextResponse {
  project?: string
  conventions: Convention[]
  memories: Memory[]
}

export function getContext(input: GetContextInput = {}): Promise<ContextResponse> {
  const wantConventions = input.include_conventions !== false
  const wantMemories    = input.include_memories    !== false
  return Promise.all([
    wantMemories    ? listMemories({ project: input.project, limit: input.limit ?? 40 }) : Promise.resolve([] as Memory[]),
    wantConventions ? listConventions(undefined, undefined, input.project)               : Promise.resolve([] as Convention[]),
  ]).then(([memories, conventions]) => ({ project: input.project, conventions, memories }))
}
