#!/usr/bin/env node
if (process.argv[2] === 'setup') {
  const { main } = await import('./setup.js')
  await main()
  process.exit(0)
}

if (process.argv[2] === 'sync-agents') {
  const { syncAgents } = await import('./sync-agents.js')
  await syncAgents()
  process.exit(0)
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { storeMemory, searchMemories, listMemories, getMemoryById, deleteMemory, updateMemory, archiveMemory, restoreMemory, pinMemory, unpinMemory, updateMemoryNote, indexProject, searchCode, getSymbolContext, globalSearch, listCodeProjects, getCodeProjectFiles, deleteCodeProject, bulkDeleteMemories, mergeMemoryPair, bulkTagMemoriesSingle, listCollections, createCollection, updateCollection, deleteCollection, assignMemoryToCollection, listConventions, getConvention, storeConvention, updateConvention, archiveConvention, restoreConvention, deleteConvention, checkPolicy, listPolicies, createPolicy, updatePolicy, deletePolicy, listProjects, createProject, updateProject, getProjectMembers, addProjectMember, listUsers, inviteUser, disableUser, enableUser, listRoles, createRole, deleteRole, assignUserRole, getUsersByRole, listWebhooks, createWebhook, updateWebhook, deleteWebhook, testWebhook, listOrgKeys, revokeApiKey, createApiKey, getAuditLog, getOrgSettings, updateOrgSettings, getStats, getAgentActivity, getTagStats, importMemories, findDuplicateMemories, getMemoryTrends, updateOrg, renameTag, setAnnouncement, exportMemories, getMemoryFacets, getUsageStats, updateSession, listSessions, deleteSession, createSession, pinConvention, getMemoryHealth, scheduleMemoryDelete, reindexProject, listHarnesses, recommendHarnesses, getHarnessVersion, listHarnessConfigReviews, downloadHarnessVersion, approveHarnessInstall, recordHarnessInstallResult, createHarness, publishHarnessVersion, createHarnessConfigReview } from './client.js'
import type { Memory, CodeSearchResult, CodeChunk, Session, Convention, MemoryHealth, Harness, HarnessRecommendation, HarnessVersion, HarnessConfigReview, HarnessFormat, HarnessTarget } from './client.js'
import { planInstall } from './harness/plan.js'
import { applyPlan } from './harness/materialize.js'
import { resolveDestinationRoot } from './harness/resolver.js'
import { buildManifestFromPath } from './harness/build-manifest.js'
import { redactConfigForReview } from './harness/config-review.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

const TITLE_FALLBACK_MAX = 150

function formatMemory(m: Memory): string {
  const date = new Date(m.created_at).toLocaleDateString()
  const type = m.type ? `${m.type}|` : ''
  const tags = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : ''
  const rev  = m.revision_count > 1 ? ` (rev ${m.revision_count})` : ''
  const label = m.title ?? (m.content.length > TITLE_FALLBACK_MAX
    ? `${m.content.slice(0, TITLE_FALLBACK_MAX)}…`
    : m.content)
  return `• [${m.id} | ${type}${m.tool}] ${m.project || '(no project)'} — ${label}${tags}${rev} (${date})`
}

function formatList(memories: Memory[]): string {
  if (memories.length === 0) return 'No memories found.'
  return memories.map(formatMemory).join('\n')
}

interface FormatConventionOpts {
  index?: number
  showWeight?: boolean
  contentChars?: number
  multiline?: boolean
}

function formatConvention(c: Convention, opts: FormatConventionOpts = {}): string {
  const title = c.title ?? `Convention ${c.id}`
  const cat   = c.category ? ` [${c.category}]` : ''
  const weightLabel = opts.showWeight ? `[${(c as any).weight ?? 0}] ` : ''
  const idxLabel    = opts.index != null ? `[${opts.index}] ` : ''
  const header = `${weightLabel}${idxLabel}${title}${cat} (id: ${c.id})`
  if (opts.contentChars === 0) return header
  const chars = opts.contentChars ?? 120
  const snippet = c.content.slice(0, chars).split('\n')[0]
  return opts.multiline ? `${header}\n    ${snippet}` : `${header}: ${snippet}`
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'nexusmind',
  version: '0.2.0',
})

const MEMORY_TYPES = [
  'architecture', 'bugfix', 'decision', 'discovery',
  'config', 'pattern', 'feedback', 'preference',
  'project', 'session_summary', 'feature', 'refactoring', 'manual',
] as const

const typeEnum = z.enum(MEMORY_TYPES).optional().describe('Memory type (see enum values)')

// store_memory — auto_tag ports smart_store_memory's regex-based tag detection.
server.tool(
  'store_memory',
  'Call immediately after any decision, bug fix, convention, or non-obvious discovery. Requires title (verb + what), type, and project. Call before moving to the next task.',
  {
    content:       z.string().describe('Full memory content (decision rationale, bug root cause, discovery, etc.)'),
    title:         z.string().optional().describe('Short searchable title (e.g. "Fixed N+1 query in UserList")'),
    type:          typeEnum,
    topic_key:     z.string().optional().describe('Stable key for upsertable topics — same key updates the existing memory (e.g. "architecture/auth-model")'),
    scope:         z.enum(['project', 'personal']).optional().describe('project (team-shared, default) or personal (cross-project)'),
    project:       z.string().optional().describe('Project or repo name (e.g. "nexusmind", "payments-api")'),
    tool:          z.string().optional().describe('Tool name — defaults to "claude-code"'),
    tags:          z.array(z.string()).optional().describe('Tags for filtering (e.g. ["auth", "convention"])'),
    session_id:    z.string().optional().describe('Session ID to link this memory to a session'),
    collection_id: z.string().optional().describe('Collection ID to assign the memory to on creation'),
    auto_tag:      z.boolean().optional().describe('Auto-detect tags from content (bugfix, decision, feature, discovery, refactor, testing) and merge with tags'),
  },
  async ({ content, title, type, topic_key, scope, project, tool, tags, session_id, collection_id, auto_tag }) => {
    try {
      let finalTags = tags
      const autoTags: string[] = []

      if (auto_tag) {
        const lower = content.toLowerCase()
        if (/fix(ed|ing)?|bug|error|crash|broken|resolv/i.test(lower)) autoTags.push('bugfix')
        if (/decid(ed|ing)?|chose|option|alternative|tradeoff|because/i.test(lower)) autoTags.push('decision')
        if (/add(ed|ing)?|implement(ed|ing)?|built|creat(ed|ing)?|new feature/i.test(lower)) autoTags.push('feature')
        if (/found|discover(ed|y)?|learn(ed|ing)?|realized|turns out|gotcha|note:/i.test(lower)) autoTags.push('discovery')
        if (/refactor(ed|ing)?|moved|reorganiz(ed|ing)?|renamed|extract(ed|ing)?/i.test(lower)) autoTags.push('refactor')
        if (/test(ed|ing)?|spec|coverage|unit|integration/i.test(lower)) autoTags.push('testing')
        finalTags = [...new Set([...autoTags, ...(tags ?? [])])]
      }

      const res = await storeMemory({ content, title, type, topic_key, scope, project, tool, tags: finalTags, session_id, collection_id })
      const label = title ? `"${title}"` : `id: ${res.id}`
      const autoTagLine = auto_tag ? `\nAuto-detected tags: [${autoTags.join(', ') || 'none'}]` : ''
      return {
        content: [{ type: 'text', text: `Memory stored (${label})${autoTagLine}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// search_memories — unified read tool: semantic search when query is present, plain
// filtered browse/list when it is absent. Absorbs search_memory, search_memories_advanced,
// list_memories, get_memory_timeline, get_session_memories.
//
// POST /v1/memory/search only accepts {query, limit, mode} server-side — every other
// filter must be applied client-side when `query` is present. GET /v1/memory (list mode)
// does support project/tool/type/scope/session_id/collection_id/include_archived as
// query params, so those are forwarded server-side there; only `tags` and `pinned` stay
// client-side in list mode since the backend does not filter on them.
server.tool(
  'search_memories',
  'Search or browse team memories. Pass query for semantic search (filtered client-side over the top 100 ranked matches — narrow filters may under-return beyond that window); omit it to list/browse with filters (project, type, tags, date range, session).',
  {
    query:            z.string().optional().describe('Semantic search text — omit to list/browse instead'),
    project:          z.string().optional().describe('Filter by project name'),
    type:             typeEnum,
    scope:            z.enum(['project', 'personal']).optional().describe('Filter by scope'),
    session_id:       z.string().optional().describe('Filter by session ID'),
    collection_id:    z.string().optional().describe('Filter by collection ID'),
    tool:             z.string().optional().describe('Filter by tool (e.g. "claude-code", "cursor")'),
    since:            z.string().optional().describe('ISO date — only memories on/after this date'),
    until:            z.string().optional().describe('ISO date — only memories on/before this date'),
    tags:             z.array(z.string()).optional().describe('Filter by tags'),
    tag_mode:         z.enum(['any', 'all']).optional().describe('"any" (default) or "all" tags must match'),
    pinned:           z.boolean().optional().describe('When true, return only pinned memories'),
    include_archived: z.boolean().optional().describe('Include archived memories (default: false)'),
    sort:             z.enum(['created_at']).optional().describe('created_at for timeline ordering — applies only when query is omitted'),
    limit:            z.number().int().min(1).max(200).optional().describe('Max results (default: 20)'),
  },
  async (input) => {
    try {
      const requestedLimit = input.limit ?? 20
      const BACKEND_MAX_LIMIT = 100
      const isQueryMode = Boolean(input.query)

      // Client-side filters run AFTER the backend result set — if we ask the backend for
      // only `requestedLimit` results, filtering can silently under-return even when more
      // matches exist. Fetch the backend max instead whenever a client-side filter is
      // present, then slice to the requested limit ourselves.
      //
      // Query mode: the search endpoint only honors {query, limit, mode} — every filter
      // below is applied client-side, so every one of them must count toward the trigger.
      const queryModeClientFilters = Boolean(
        input.project || input.type || input.scope || input.session_id || input.tool ||
        input.collection_id || input.tags?.length || input.since || input.until ||
        input.pinned !== undefined || !input.include_archived
      )
      // List mode: project/type/scope/session_id/tool/collection_id/include_archived are
      // forwarded as server-side query params, so only tags/pinned stay client-side here.
      const listModeClientFilters = Boolean(input.tags?.length || input.pinned !== undefined)

      const hasClientSideFilter = isQueryMode ? queryModeClientFilters : listModeClientFilters
      const fetchLimit = hasClientSideFilter ? BACKEND_MAX_LIMIT : requestedLimit

      let results: Memory[]
      if (isQueryMode) {
        // Backend ignores anything beyond {query, limit, mode} here — filter everything
        // else client-side rather than relying on the endpoint to honor it.
        results = await searchMemories({ query: input.query!, limit: fetchLimit })
        if (input.project)       results = results.filter(m => m.project === input.project)
        if (input.type)          results = results.filter(m => m.type === input.type)
        if (input.scope)         results = results.filter(m => m.scope === input.scope)
        if (input.session_id)    results = results.filter(m => m.session_id === input.session_id)
        if (input.tool)          results = results.filter(m => m.tool === input.tool)
        if (input.collection_id) results = results.filter(m => m.collection_id === input.collection_id)
        if (input.since)         results = results.filter(m => m.created_at >= input.since!)
        if (input.until)         results = results.filter(m => m.created_at <= input.until! + 'T23:59:59')
        if (input.pinned !== undefined) results = results.filter(m => Boolean(m.pinned) === input.pinned)
        if (!input.include_archived)    results = results.filter(m => !m.archived_at)
      } else {
        results = await listMemories({
          project:          input.project,
          type:             input.type,
          scope:            input.scope,
          session_id:       input.session_id,
          tool:             input.tool,
          collection_id:    input.collection_id,
          include_archived: input.include_archived,
          since:            input.since,
          until:            input.until,
          sort:             input.sort,
          limit:            fetchLimit,
        })
        // Defensive client-side filter — the list endpoint does not filter on pinned status.
        if (input.pinned !== undefined) results = results.filter(m => Boolean(m.pinned) === input.pinned)
      }

      if (input.tags?.length) {
        results = input.tag_mode === 'all'
          ? results.filter(m => input.tags!.every(t => m.tags?.includes(t)))
          : results.filter(m => m.tags?.some(t => input.tags!.includes(t)))
      }

      if (hasClientSideFilter) results = results.slice(0, requestedLimit)

      const text = results.length === 0
        ? (input.query ? `No memories found for query: "${input.query}"` : 'No memories found.')
        : `${results.length} memory(ies)${input.query ? ` for "${input.query}"` : ''}:\n\n${formatList(results)}`
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Context builder ─────────────────────────────────────────────────────────
// Shared by get_context and onboard_agent. Absorbs get_project_context,
// summarize_project, get_agent_dashboard, and get_agent_context.

interface ContextParams {
  project?: string
  mode?: 'compact' | 'full'
  include_conventions?: boolean
  include_memories?: boolean
  include_stats?: boolean
  include_activity?: boolean
  limit?: number
}

function formatMemoryCompact(m: Memory): string {
  const label = m.title ?? (m.content.length > 80 ? `${m.content.slice(0, 80)}…` : m.content)
  return `[${m.id}] ${label}`
}

async function buildContext(params: ContextParams): Promise<string> {
  const mode = params.mode ?? 'full'
  const wantConventions = params.include_conventions !== false
  const wantMemories    = params.include_memories    !== false
  const wantStats       = params.include_stats === true
  const wantActivity    = params.include_activity === true

  const [memories, conventions, stats, activity] = await Promise.all([
    wantMemories    ? listMemories({ project: params.project, limit: params.limit ?? 40 }) : Promise.resolve([]),
    wantConventions ? listConventions(undefined, undefined, params.project) : Promise.resolve([]),
    wantStats       ? getStats().catch(() => null) : Promise.resolve(null),
    wantActivity    ? getAgentActivity().catch(() => []) : Promise.resolve([]),
  ])

  if (memories.length === 0 && conventions.length === 0 && !stats && activity.length === 0) {
    return 'No team context found.'
  }

  const projectLabel = params.project ? ` — ${params.project}` : ''

  if (mode === 'compact') {
    const lines: string[] = [`## NexusMind Context${projectLabel} (compact)`]
    if (wantConventions) {
      lines.push('', `### Conventions (${conventions.length})`)
      lines.push(conventions.length ? conventions.map(c => formatConvention(c, { contentChars: 0 })).join('\n') : '(none)')
    }
    if (wantMemories) {
      lines.push('', `### Memories (${memories.length})`)
      lines.push(memories.length ? memories.map(formatMemoryCompact).join('\n') : '(none)')
    }
    if (wantStats && stats) {
      lines.push('', '### Stats', `- Total memories: ${stats.total_memories ?? 'N/A'} · Total users: ${stats.total_users ?? 'N/A'} · Code projects: ${stats.total_code_projects ?? 'N/A'}`)
    }
    if (wantActivity) {
      lines.push('', '### Recent Activity')
      lines.push(activity.length
        ? activity.slice(0, 5).map((a: any) => `- ${a.agent ?? a.name ?? '(unknown)'}: ${a.action ?? a.request_count ?? ''}`).join('\n')
        : '(none)')
    }
    return lines.join('\n')
  }

  // full mode — complete grouped detail
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const lines: string[] = [
    `## NexusMind Team Context${projectLabel}`,
    `> Last updated: ${date} · ${memories.length} memories · ${conventions.length} conventions`,
    '',
  ]

  // Conventions first — they have the highest authority
  if (wantConventions && conventions.length > 0) {
    lines.push('=== TEAM CONVENTIONS (FOLLOW THESE FIRST) ===')
    lines.push('')
    for (const c of conventions) {
      const title = c.title ?? `Convention ${c.id}`
      const cat   = c.category ? ` [${c.category}]` : ''
      lines.push(`### ${title}${cat}`)
      lines.push(c.content)
      lines.push('')
    }
    lines.push('')
  }

  if (wantMemories && memories.length > 0) {
    // Group by type
    const groups: Record<string, typeof memories> = {}
    for (const m of memories) {
      const key = m.type ?? 'general'
      groups[key] = groups[key] ?? []
      groups[key].push(m)
    }

    const TYPE_LABELS: Record<string, string> = {
      architecture:    'Architecture & Design',
      decision:        'Decisions',
      convention:      'Conventions',
      pattern:         'Patterns',
      bugfix:          'Bugs & Fixes',
      discovery:       'Discoveries',
      config:          'Configuration',
      preference:      'Preferences',
      feature:         'Features',
      refactoring:     'Refactoring',
      session_summary: 'Session Summaries',
      general:         'General',
    }

    const PRIORITY_ORDER = [
      'architecture', 'decision', 'convention', 'pattern',
      'bugfix', 'discovery', 'config', 'feature', 'preference',
      'refactoring', 'session_summary', 'general',
    ]

    const sortedKeys = [
      ...PRIORITY_ORDER.filter(k => groups[k]),
      ...Object.keys(groups).filter(k => !PRIORITY_ORDER.includes(k)),
    ]

    lines.push('=== MEMORIES ===')
    lines.push('')

    for (const key of sortedKeys) {
      const label = TYPE_LABELS[key] ?? key
      lines.push(`#### ${label}`)
      for (const m of groups[key]) {
        const entry = m.title ?? m.content.split('\n')[0].slice(0, 120)
        lines.push(`- ${entry}`)
      }
      lines.push('')
    }
  }

  if (wantStats && stats) {
    lines.push('=== STATS ===', '')
    lines.push(`- Total memories: ${stats.total_memories ?? 'N/A'}`)
    lines.push(`- Total users: ${stats.total_users ?? 'N/A'}`)
    lines.push(`- Total code projects: ${stats.total_code_projects ?? 'N/A'}`)
    lines.push('')
  }

  if (wantActivity) {
    lines.push('=== RECENT ACTIVITY ===', '')
    if (activity.length > 0) {
      for (const a of activity.slice(0, 10) as any[]) {
        lines.push(`- ${a.agent ?? a.name ?? '(unknown)'}: ${a.action ?? a.request_count ?? 'N/A'}${a.project ? ` (${a.project})` : ''}`)
      }
    } else {
      lines.push('No recent activity.')
    }
    lines.push('')
  }

  return lines.join('\n')
}

// get_context — unified context tool. Absorbs get_project_context, summarize_project,
// get_agent_dashboard, get_agent_context.
server.tool(
  'get_context',
  'Call at the START of any significant session. Returns team conventions (highest authority) plus memories, optionally org stats and recent agent activity. mode "full" (default) is complete detail grouped by type; "compact" is titles/one-liners with ids.',
  {
    project:              z.string().optional().describe('Project to fetch context for; omit for all projects'),
    mode:                 z.enum(['compact', 'full']).optional().describe('"full" (default) or "compact" (titles/one-liners with ids)'),
    include_conventions:  z.boolean().optional().describe('Include team conventions (default: true)'),
    include_memories:     z.boolean().optional().describe('Include memories (default: true)'),
    include_stats:        z.boolean().optional().describe('Include org stats (default: false)'),
    include_activity:     z.boolean().optional().describe('Include recent agent activity (default: false)'),
    limit:                z.number().int().min(1).max(100).optional().describe('Max memories (default: 40)'),
  },
  async (input) => {
    try {
      const text = await buildContext(input)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_memory — full untruncated content by id
server.tool(
  'get_memory',
  'Fetch FULL untruncated content for a single memory by id. search_memories returns previews (often 120-300 chars); when you need to act on or quote the full record, call get_memory(id).',
  {
    id: z.string().describe('The memory id (returned by search_memories)'),
  },
  async ({ id }) => {
    try {
      const m = await getMemoryById(id)
      const date = new Date(m.created_at).toLocaleString()
      const tagsLine = m.tags.length > 0 ? `Tags: ${m.tags.join(', ')}\n` : ''
      const topicLine = m.topic_key ? `Topic key: ${m.topic_key}\n` : ''
      const text = [
        `id: ${m.id}`,
        `title: ${m.title ?? '(untitled)'}`,
        `type: ${m.type ?? '(none)'}`,
        `project: ${m.project || '(no project)'}`,
        `tool: ${m.tool}`,
        `scope: ${m.scope}`,
        `${tagsLine}${topicLine}created: ${date}`,
        `revision: ${m.revision_count}`,
        '',
        '--- content ---',
        m.content,
      ].join('\n')
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// delete_memory — hard delete with explicit confirmation
server.tool(
  'delete_memory',
  'Delete a memory permanently. The USER must request deletion explicitly — DO NOT delete autonomously. Required: confirm: true. Without confirm: true this tool refuses and returns an error. Backend hard-deletes; there is no undo. Use only for stale, incorrect, or explicitly retired memories.',
  {
    id:      z.string().describe('The memory id to delete'),
    confirm: z.boolean().describe('Must be true to perform the deletion. Without this, the tool refuses.'),
  },
  async ({ id, confirm }) => {
    if (confirm !== true) {
      return {
        content: [{
          type: 'text',
          text: 'Refused: delete_memory requires confirm: true. The user must request deletion explicitly. No HTTP request was made.',
        }],
        isError: true,
      }
    }
    try {
      await deleteMemory(id)
      return {
        content: [{ type: 'text', text: `Memory deleted (id: ${id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Code Index Helpers ───────────────────────────────────────────────────────

function formatCodeResult(r: CodeSearchResult, index: number): string {
  const symbol = r.symbol ? ` — ${r.symbol}` : ''
  const kind   = r.kind ? ` (${r.kind})` : ''
  const score  = r.score.toFixed(3)
  return [
    `[${index + 1}] ${r.file_path}${symbol}${kind} · score: ${score}`,
    `    lines ${r.start_line}–${r.end_line}`,
    `    ${r.content.trim().split('\n').slice(0, 4).join('\n    ')}`,
  ].join('\n')
}

function formatCodeChunk(c: CodeChunk, index: number): string {
  const symbol = c.symbol ? ` — ${c.symbol}` : ''
  const kind   = c.kind ? ` (${c.kind})` : ''
  return [
    `[${index + 1}] ${c.file_path}${symbol}${kind}`,
    `    lines ${c.start_line}–${c.end_line}`,
    `    ${c.content.trim().split('\n').slice(0, 4).join('\n    ')}`,
  ].join('\n')
}

// index_project
server.tool(
  'index_project',
  'Call before any semantic code search on an unindexed project, or when code has changed significantly. Chunks source files by symbol, embeds them, and persists to the code index. Supports both local directories (root_path) and remote GitHub repositories (repo_url). For private GitHub repos, provide a github_token with repo read scope.',
  {
    project:      z.string().describe('Logical project name used as the search scope key'),
    root_path:    z.string().optional().describe('Absolute path to the project root directory to index (use for local codebases)'),
    repo_url:     z.string().optional().describe('GitHub repository URL to clone and index (e.g. https://github.com/owner/repo). Use for remote repos instead of root_path.'),
    github_token: z.string().optional().describe('GitHub Personal Access Token for private repositories. Requires the repo (or contents:read) scope. Stored encrypted — never logged or returned in responses.'),
    extensions:   z.array(z.string()).optional().describe('File extensions to include (defaults to common code extensions)'),
  },
  async ({ project, root_path, repo_url, github_token, extensions }) => {
    try {
      const res = await indexProject({ project, root_path, repo_url, github_token, extensions })
      return {
        content: [{
          type: 'text',
          text: `Project "${res.project}" indexed successfully.\nStatus: ${res.status}\nFiles indexed: ${res.file_count}\nChunks created: ${res.chunk_count}`,
        }],
      }
    } catch (err) {
      const msg = (err as Error).message
      // Surface actionable guidance for private-repo auth failures
      if (msg.includes('PRIVATE_REPO_TOKEN_REQUIRED')) {
        return {
          content: [{ type: 'text', text: `This repository is not publicly accessible. Provide a github_token with the repo (read) scope and retry.` }],
          isError: true,
        }
      }
      if (msg.includes('TOKEN_ACCESS_DENIED') || msg.includes('PRIVATE_REPO_AUTH_FAILURE')) {
        return {
          content: [{ type: 'text', text: `The provided github_token cannot access this repository. Verify the token has the repo scope and permission to read this repo.` }],
          isError: true,
        }
      }
      return {
        content: [{ type: 'text', text: `Error: ${msg}` }],
        isError: true,
      }
    }
  }
)

// search_code
server.tool(
  'search_code',
  'Primary tool for understanding a codebase semantically — find where something is defined, how a pattern is implemented, or what handles a concern, without reading files manually. Requires index_project first.',
  {
    query:   z.string().describe('Natural language or code description of what to find'),
    project: z.string().describe('Project key — must match the key used in index_project'),
    limit:   z.number().int().min(1).max(20).optional().describe('Max results (default: 10, max: 20)'),
  },
  async ({ query, project, limit }) => {
    try {
      const results = await searchCode({ query, project, limit: limit ?? 10 })
      if (results.length === 0) {
        return { content: [{ type: 'text', text: `No code chunks found for query: "${query}" in project "${project}".` }] }
      }
      const text = [
        `Found ${results.length} result(s) for "${query}" in project "${project}":`,
        '',
        ...results.map(formatCodeResult),
      ].join('\n')
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_symbol_context
server.tool(
  'get_symbol_context',
  'After search_code identifies a symbol, call this to get the full context of that symbol and its immediate neighbors in the file. Returns the target chunk plus up to 2 adjacent chunks (one before, one after) in file order.',
  {
    project:   z.string().describe('Project key — must match the key used in index_project'),
    file_path: z.string().describe('File path as returned by search_code (e.g. "src/auth.rs")'),
    symbol:    z.string().describe('Symbol name to look up (e.g. "authenticate_user", "UserService")'),
  },
  async ({ project, file_path, symbol }) => {
    try {
      const chunks = await getSymbolContext({ project, file_path, symbol })
      if (chunks.length === 0) {
        return {
          content: [{ type: 'text', text: `Symbol "${symbol}" not found in ${file_path} (project: "${project}").` }],
          isError: true,
        }
      }
      const text = [
        `Context for symbol "${symbol}" in ${file_path} (project: "${project}"):`,
        '',
        ...chunks.map(formatCodeChunk),
      ].join('\n')
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// global_search
server.tool(
  'global_search',
  'Search across memories, policies, conventions, and users simultaneously. Returns grouped results by type. Use when you need a broad cross-resource search rather than targeted memory or code lookup.',
  {
    query: z.string().describe('Search query (e.g. "authentication", "user onboarding")'),
    types: z.array(z.enum(['memories', 'code', 'users', 'policies', 'conventions'])).optional()
      .describe('Resource types to search. Omit to search all types.'),
  },
  async ({ query, types }) => {
    try {
      const result = await globalSearch({ query, types })
      const parts: string[] = [`Global search results for "${query}":`, '']
      for (const [key, items] of Object.entries(result)) {
        if (Array.isArray(items)) {
          parts.push(`### ${key} (${items.length})`)
          if (items.length === 0) {
            parts.push('  No results.')
          } else {
            items.slice(0, 10).forEach((item, i) => {
              const label = typeof item === 'object' && item !== null
                ? ((item as Record<string, unknown>).title ?? (item as Record<string, unknown>).name ?? (item as Record<string, unknown>).id ?? JSON.stringify(item).slice(0, 120))
                : String(item)
              parts.push(`  [${i + 1}] ${label}`)
            })
          }
          parts.push('')
        }
      }
      return { content: [{ type: 'text', text: parts.join('\n') }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// list_code_projects
server.tool(
  'list_code_projects',
  'List all code projects registered for indexing, including their indexing status and last indexed timestamp. Use to discover which projects are available for code search before calling search_code.',
  {
    include_archived: z.boolean().optional()
      .describe('Include archived projects in the results (default: false)'),
  },
  async ({ include_archived }) => {
    try {
      const projects = await listCodeProjects({ include_archived })
      if (projects.length === 0) {
        return { content: [{ type: 'text', text: 'No code projects found. Use index_project to register one.' }] }
      }
      const lines = [
        `${projects.length} code project(s):`,
        '',
        ...projects.map((p, i) => {
          const status = p.status ?? 'unknown'
          const lastIndexed = p.last_indexed_at
            ? new Date(p.last_indexed_at).toLocaleString()
            : 'never'
          const files = p.file_count != null ? `, ${p.file_count} files` : ''
          const chunks = p.chunk_count != null ? `, ${p.chunk_count} chunks` : ''
          const archived = p.is_archived ? ' [archived]' : ''
          return `[${i + 1}] ${p.name}${archived}\n    status: ${status} · last indexed: ${lastIndexed}${files}${chunks}`
        }),
      ]
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_code_project_files
server.tool(
  'get_code_project_files',
  'List all indexed file paths for a code project. Use to inspect what files are in the search index before running semantic queries.',
  {
    project_id: z.string().describe('The numeric ID of the code project (returned by list_code_projects)'),
  },
  async ({ project_id }) => {
    try {
      const files = await getCodeProjectFiles(project_id)
      if (files.length === 0) {
        return { content: [{ type: 'text', text: `No indexed files found for project id: ${project_id}` }] }
      }
      return {
        content: [{ type: 'text', text: `${files.length} indexed file(s) in project ${project_id}:\n\n${files.join('\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// delete_code_project
server.tool(
  'delete_code_project',
  'Delete a code project and all its indexed data. Requires confirm: true. There is no undo — all chunks and embeddings for the project are permanently removed.',
  {
    id:      z.string().describe('The numeric ID of the code project to delete (returned by list_code_projects)'),
    confirm: z.boolean().describe('Must be true to perform the deletion. Without this, the tool refuses and makes no HTTP request.'),
  },
  async ({ id, confirm }) => {
    if (confirm !== true) {
      return {
        content: [{
          type: 'text',
          text: 'Refused: delete_code_project requires confirm: true. No HTTP request was made.',
        }],
        isError: true,
      }
    }
    try {
      await deleteCodeProject(id)
      return {
        content: [{ type: 'text', text: `Code project deleted (id: ${id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// bulk_delete_memories
server.tool(
  'bulk_delete_memories',
  'Permanently delete multiple memories by ID. Requires confirm: true as a safety check. Use only when the USER explicitly requests bulk deletion. There is no undo — the backend hard-deletes all specified records.',
  {
    ids: z.array(z.string()).min(1).describe('Array of memory IDs to delete'),
    confirm: z.boolean().describe('Must be true to proceed. Without confirm: true the tool refuses and makes no HTTP request.'),
  },
  async ({ ids, confirm }) => {
    if (confirm !== true) {
      return {
        content: [{
          type: 'text',
          text: 'Refused: bulk_delete_memories requires confirm: true. Set confirm: true to proceed with bulk deletion. No HTTP request was made.',
        }],
        isError: true,
      }
    }
    try {
      const result = await bulkDeleteMemories({ ids })
      const count = result.deleted ?? ids.length
      return {
        content: [{ type: 'text', text: `Bulk delete complete. ${count} memory(ies) permanently deleted.` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// update_memory
server.tool(
  'update_memory',
  'Update the content, tags, or metadata of an existing memory by ID. Call when you want to revise what was stored without creating a duplicate — preferred over delete+store for corrections or enrichments.',
  {
    id:       z.string().describe('The memory ID to update (returned by search_memories)'),
    content:  z.string().optional().describe('New full content for the memory'),
    tags:     z.array(z.string()).optional().describe('Replacement tag list (overwrites existing tags)'),
    metadata: z.record(z.unknown()).optional().describe('Arbitrary metadata key/value pairs to merge into the memory'),
  },
  async ({ id, content, tags, metadata }) => {
    try {
      const m = await updateMemory({ id, content, tags, metadata })
      return {
        content: [{ type: 'text', text: `Memory updated (id: ${m.id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// archive_memory
server.tool(
  'archive_memory',
  'Archive a memory (hide from default search results without deleting). Archived memories can be restored at any time. Use when a memory is outdated or superseded but should not be permanently deleted.',
  {
    id: z.string().describe('The memory ID to archive'),
  },
  async ({ id }) => {
    try {
      await archiveMemory(id)
      return {
        content: [{ type: 'text', text: `Memory archived (id: ${id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// restore_memory
server.tool(
  'restore_memory',
  'Restore a previously archived memory, making it visible again in default search results.',
  {
    id: z.string().describe('The memory ID to restore'),
  },
  async ({ id }) => {
    try {
      await restoreMemory(id)
      return {
        content: [{ type: 'text', text: `Memory restored (id: ${id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// pin_memory
server.tool(
  'pin_memory',
  'Pin a memory so it appears prominently in context retrieval results. Use for critical decisions, architectural constraints, or team conventions that must always be surfaced.',
  {
    id: z.string().describe('The memory ID to pin'),
  },
  async ({ id }) => {
    try {
      await pinMemory(id)
      return {
        content: [{ type: 'text', text: `Memory pinned (id: ${id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// unpin_memory
server.tool(
  'unpin_memory',
  'Unpin a previously pinned memory, returning it to standard ranking in context retrieval.',
  {
    id: z.string().describe('The memory ID to unpin'),
  },
  async ({ id }) => {
    try {
      await unpinMemory(id)
      return {
        content: [{ type: 'text', text: `Memory unpinned (id: ${id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// update_memory_note
server.tool(
  'update_memory_note',
  'Set or update the admin-only internal note on a memory. Notes are visible only to admins, not to users or agents.',
  {
    memory_id: z.string().describe('Memory ID'),
    note: z.string().describe('Admin note content (empty string to clear)'),
  },
  async ({ memory_id, note }) => {
    try {
      await updateMemoryNote(memory_id, note)
      return {
        content: [{ type: 'text', text: `Note updated on memory ${memory_id}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// merge_memories
server.tool(
  'merge_memories',
  'Merge multiple duplicate memories into one. Content from source_ids is merged into target_id.',
  {
    source_ids: z.array(z.string()).min(1).describe('IDs of the memories to merge into target_id'),
    target_id:  z.string().describe('ID of the memory to keep — all source_ids are merged into this one'),
  },
  async ({ source_ids, target_id }) => {
    try {
      let merged = 0
      for (const mergeId of source_ids) {
        await mergeMemoryPair(target_id, mergeId)
        merged++
      }
      return {
        content: [{ type: 'text', text: `Merged ${merged} memory(ies) into target id: ${target_id}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// bulk_tag_memories
server.tool(
  'bulk_tag_memories',
  'Add or remove tags from multiple memories at once.',
  {
    ids:         z.array(z.string()).min(1).describe('Memory IDs to tag or untag'),
    add_tags:    z.array(z.string()).optional().describe('Tags to add to all specified memories'),
    remove_tags: z.array(z.string()).optional().describe('Tags to remove from all specified memories'),
  },
  async ({ ids, add_tags, remove_tags }) => {
    try {
      const calls: string[] = []
      for (const tag of (add_tags ?? [])) {
        const res = await bulkTagMemoriesSingle(ids, 'add', tag)
        calls.push(`add "${tag}" → ${res.updated} updated`)
      }
      for (const tag of (remove_tags ?? [])) {
        const res = await bulkTagMemoriesSingle(ids, 'remove', tag)
        calls.push(`remove "${tag}" → ${res.updated} updated`)
      }
      if (calls.length === 0) {
        return { content: [{ type: 'text', text: 'No tags specified — nothing to do.' }] }
      }
      return {
        content: [{ type: 'text', text: `Bulk tag complete:\n${calls.join('\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// list_collections
server.tool(
  'list_collections',
  'List all memory collections in the organization.',
  {},
  async () => {
    try {
      const collections = await listCollections()
      if (collections.length === 0) {
        return { content: [{ type: 'text', text: 'No collections found.' }] }
      }
      const lines = collections.map(c => {
        const count = c.memory_count != null ? ` · ${c.memory_count} memories` : ''
        const desc = c.description ? ` — ${c.description}` : ''
        return `• ${c.name}${desc} (id: ${c.id})${count}`
      })
      return {
        content: [{ type: 'text', text: `${collections.length} collection(s):\n\n${lines.join('\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// assign_memory_to_collection
server.tool(
  'assign_memory_to_collection',
  'Assign a memory to a collection, or remove it from its collection (collection_id: null).',
  {
    memory_id:     z.string().describe('ID of the memory to assign'),
    collection_id: z.string().nullable().describe('ID of the collection to assign to, or null to remove from collection'),
  },
  async ({ memory_id, collection_id }) => {
    try {
      await assignMemoryToCollection(memory_id, collection_id)
      const msg = collection_id
        ? `Memory ${memory_id} assigned to collection ${collection_id}`
        : `Memory ${memory_id} removed from its collection`
      return { content: [{ type: 'text', text: msg }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Conventions ──────────────────────────────────────────────────────────────

// list_conventions — unified list/search. Absorbs search_conventions and get_conventions_summary.
server.tool(
  'list_conventions',
  'List or search team conventions, optionally filtered by category and/or query text. Use to discover established patterns, coding standards, or naming rules before starting work.',
  {
    category:         z.string().optional().describe('Filter by category (e.g. "naming", "architecture", "testing")'),
    query:            z.string().optional().describe('Filter by text in title or content'),
    include_archived: z.boolean().optional().describe('Include archived conventions in results (default: false)'),
    project:          z.string().optional().describe('Optional project slug to scope results to that project plus global (unscoped) items.'),
    compact:          z.boolean().optional().describe('Compact shape: weight + title + 200-char snippet (default: false)'),
  },
  async ({ category, query, include_archived, project, compact }) => {
    try {
      let conventions = await listConventions(category, include_archived, project)
      if (query) {
        const q = query.toLowerCase()
        conventions = conventions.filter(c =>
          (c.title ?? '').toLowerCase().includes(q) || c.content.toLowerCase().includes(q)
        )
      }
      if (conventions.length === 0) {
        const parts: string[] = []
        if (query) parts.push(`matching "${query}"`)
        if (category) parts.push(`in category "${category}"`)
        return { content: [{ type: 'text', text: `No conventions found${parts.length ? ' ' + parts.join(' ') : ''}.` }] }
      }
      const lines = compact
        ? conventions.map(c => formatConvention(c, { showWeight: true, contentChars: 200 }))
        : conventions.map((c, i) => formatConvention(c, { index: i + 1, multiline: true }))
      return {
        content: [{ type: 'text', text: `${conventions.length} convention(s):\n\n${lines.join(compact ? '\n' : '\n\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_convention
server.tool(
  'get_convention',
  'Fetch the full content of a single convention by ID. Use after list_conventions to read the complete rule or pattern.',
  {
    id: z.string().describe('Convention ID returned by list_conventions'),
  },
  async ({ id }) => {
    try {
      const conv = await getConvention(id)
      const title    = conv.title ?? `Convention ${conv.id}`
      const category = conv.category ? `\ncategory: ${conv.category}` : ''
      const updated  = conv.updated_at ? `\nupdated: ${new Date(conv.updated_at).toLocaleString()}` : ''
      const text = [
        `id: ${conv.id}`,
        `title: ${title}${category}${updated}`,
        '',
        '--- content ---',
        conv.content,
      ].join('\n')
      return { content: [{ type: 'text', text: text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// store_convention
server.tool(
  'store_convention',
  'Store a new team convention in NexusMind. Use to record coding standards, naming rules, architectural patterns, or any team agreement that should persist across sessions.',
  {
    content:  z.string().describe('Full convention text — what the rule is and why it exists'),
    title:    z.string().optional().describe('Short descriptive title (e.g. "Use kebab-case for file names")'),
    category: z.string().optional().describe('Category for grouping (e.g. "naming", "architecture", "testing")'),
  },
  async ({ content, title, category }) => {
    try {
      const conv = await storeConvention({ content, title, category })
      const label = title ? `"${title}"` : `id: ${conv.id}`
      return {
        content: [{ type: 'text', text: `Convention stored (${label})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// update_convention
server.tool(
  'update_convention',
  'Update an existing convention by ID. Use to refine a rule, change its category, or correct its title without deleting and re-creating it.',
  {
    id:       z.string().describe('Convention ID to update (returned by list_conventions or store_convention)'),
    content:  z.string().optional().describe('New full convention text'),
    title:    z.string().optional().describe('New title'),
    category: z.string().optional().describe('New category'),
  },
  async ({ id, content, title, category }) => {
    try {
      const conv = await updateConvention(id, { content, title, category })
      return {
        content: [{ type: 'text', text: `Convention updated (id: ${conv.id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// archive_convention
server.tool(
  'archive_convention',
  'Archive a convention to hide it from active context without deleting it. Archived conventions are excluded from get_context and list_conventions by default. Use when a rule is superseded or temporarily suspended.',
  {
    id: z.string().describe('Convention ID to archive (returned by list_conventions or store_convention)'),
  },
  async ({ id }) => {
    try {
      await archiveConvention(id)
      return {
        content: [{ type: 'text', text: `Convention archived (id: ${id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// restore_convention
server.tool(
  'restore_convention',
  'Restore an archived convention back to active status. It will appear again in list_conventions and get_context results.',
  {
    id: z.string().describe('Convention ID to restore'),
  },
  async ({ id }) => {
    try {
      await restoreConvention(id)
      return {
        content: [{ type: 'text', text: `Convention restored (id: ${id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// delete_convention
server.tool(
  'delete_convention',
  'Permanently delete a convention. There is no undo — the backend hard-deletes the record. Requires confirm: true as a safety check.',
  {
    id:      z.string().describe('Convention ID to delete'),
    confirm: z.boolean().describe('Must be true to perform the deletion. Without this, the tool refuses and makes no HTTP request.'),
  },
  async ({ id, confirm }) => {
    if (confirm !== true) {
      return {
        content: [{
          type: 'text',
          text: 'Set confirm: true to permanently delete this convention.',
        }],
        isError: true,
      }
    }
    try {
      await deleteConvention(id)
      return {
        content: [{ type: 'text', text: `Convention deleted (id: ${id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// import_conventions_from_text
server.tool(
  'import_conventions_from_text',
  'Bulk import multiple conventions at once. Each item needs a title and content. Use this to import team conventions in batch.',
  {
    conventions: z.array(z.object({
      title:    z.string().describe('Convention title'),
      content:  z.string().describe('Convention content'),
      category: z.string().optional().describe('Category (e.g. "architecture", "testing")'),
      weight:   z.number().optional().describe('Priority weight (default: 100)'),
    })).min(1).describe('Array of conventions to import'),
  },
  async ({ conventions }) => {
    const results: string[] = []
    for (const conv of conventions) {
      try {
        await storeConvention({
          title:    conv.title,
          content:  conv.content,
          category: conv.category ?? 'general',
          weight:   conv.weight ?? 100,
        })
        results.push(`✅ ${conv.title}`)
      } catch (e: any) {
        results.push(`❌ ${conv.title}: ${e.message}`)
      }
    }
    const successCount = results.filter(r => r.startsWith('✅')).length
    return {
      content: [{
        type: 'text',
        text: `Imported ${successCount}/${conventions.length} conventions:\n${results.join('\n')}`,
      }],
    }
  }
)

// check_policy
server.tool(
  'check_policy',
  'Check whether a specific action is permitted under the organization\'s policies before performing it. Returns allowed: true/false with reason.',
  {
    action:   z.string().describe('The action to check (e.g. "delete", "publish", "share")'),
    resource: z.string().describe('The resource the action targets (e.g. "memory", "convention", "project/payments-api")'),
    context:  z.record(z.unknown()).optional().describe('Optional additional context key/value pairs for the policy evaluation'),
  },
  async ({ action, resource, context }) => {
    try {
      const result = await checkPolicy(action, resource, context as Record<string, any> | undefined)
      const allowed: boolean = result.allowed ?? result.permitted ?? false
      const reason: string = result.reason ?? result.message ?? ''
      const status = allowed ? 'ALLOWED' : 'DENIED'
      const reasonLine = reason ? `\nReason: ${reason}` : ''
      const violations: any[] = Array.isArray(result.violations) ? result.violations : []
      const violationsLines = violations.length > 0
        ? `\n\nViolations:\n${violations.map((v, i) => `${i + 1}. ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')}`
        : ''
      // The backend response may carry fields beyond allowed/permitted/reason/message/violations
      // (e.g. policy_id, evaluated_at). Surface them instead of silently dropping them.
      const KNOWN_FIELDS = new Set(['allowed', 'permitted', 'reason', 'message', 'violations'])
      const extra = Object.fromEntries(Object.entries(result).filter(([k]) => !KNOWN_FIELDS.has(k)))
      const extraLine = Object.keys(extra).length > 0 ? `\nExtra: ${JSON.stringify(extra)}` : ''
      return {
        content: [{ type: 'text', text: `Policy check: ${status}\nAction: ${action}\nResource: ${resource}${reasonLine}${violationsLines}${extraLine}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── API Keys ─────────────────────────────────────────────────────────────────

// list_api_keys
server.tool(
  'list_api_keys',
  'List all API keys in the organization with their usage stats and expiry.',
  {},
  async () => {
    try {
      const keys = await listOrgKeys()
      if (keys.length === 0) {
        return { content: [{ type: 'text', text: 'No API keys found.' }] }
      }
      const lines = keys.map((k, i) => {
        const prefix  = k.key_prefix ? ` (${k.key_prefix}...)` : ''
        const role    = k.role       ? ` · role: ${k.role}`    : ''
        const used    = k.times_used != null ? ` · used: ${k.times_used}` : ''
        const expires = k.expires_at ? ` · expires: ${new Date(k.expires_at as string).toLocaleDateString()}` : ''
        const created = k.created_at ? ` · created: ${new Date(k.created_at as string).toLocaleDateString()}` : ''
        const name    = k.name ? ` "${k.name}"` : ''
        return `[${i + 1}] id: ${k.id}${name}${prefix}${role}${used}${expires}${created}`
      })
      return {
        content: [{ type: 'text', text: `${keys.length} API key(s):\n\n${lines.join('\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// revoke_api_key
server.tool(
  'revoke_api_key',
  'Revoke an API key. Requires confirm: true.',
  {
    id:      z.string().describe('The API key ID to revoke (returned by list_api_keys)'),
    confirm: z.boolean().describe('Must be true to perform the revocation. Without this, the tool refuses.'),
  },
  async ({ id, confirm }) => {
    if (confirm !== true) {
      return {
        content: [{
          type: 'text',
          text: 'Refused: revoke_api_key requires confirm: true. No HTTP request was made.',
        }],
        isError: true,
      }
    }
    try {
      await revokeApiKey(id)
      return {
        content: [{ type: 'text', text: `API key revoked (id: ${id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// create_api_key
server.tool(
  'create_api_key',
  'Create a new API key for programmatic access. Returns the key value (only shown once — save immediately).',
  {
    name:        z.string().describe('Name for the API key (e.g. "CI/CD pipeline", "My dev key")'),
    expires_at:  z.string().optional().describe('Optional expiry date in ISO 8601 format (e.g. "2025-12-31T23:59:59Z")'),
    role:        z.string().optional().describe('Role to assign to the key (e.g. "admin", "member", "viewer"). Defaults to "member".'),
    description: z.string().optional().describe('Optional description of what this key is for'),
  },
  async ({ name, expires_at, role, description }) => {
    try {
      const result = await createApiKey({
        name,
        expires_at,
        role: role ?? 'member',
        description,
      })
      return {
        content: [{
          type: 'text',
          text: `API key created: **${result.name}**\nKey: \`${result.key}\`\n\nSave this — it won't be shown again.`,
        }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_audit_log
server.tool(
  'get_audit_log',
  'Get recent audit log entries, optionally filtered by user or action type.',
  {
    user_id: z.string().optional().describe('Filter by user ID'),
    action:  z.string().optional().describe('Filter by action type (e.g. "memory.create", "key.revoke")'),
    limit:   z.number().int().min(1).max(200).optional().describe('Max entries to return (default: 50)'),
  },
  async ({ user_id, action, limit }) => {
    try {
      const entries = await getAuditLog({ user_id, action, limit: limit ?? 50 })
      if (entries.length === 0) {
        return { content: [{ type: 'text', text: 'No audit log entries found.' }] }
      }
      const lines = entries.map((e, i) => {
        const when     = e.created_at ? new Date(e.created_at as string).toLocaleString() : ''
        const who      = e.user_id    ? ` · user: ${e.user_id}` : ''
        const resource = e.resource_type ? ` · ${e.resource_type}${e.resource_id ? `:${e.resource_id}` : ''}` : ''
        return `[${i + 1}] ${e.action ?? '(unknown)'}${resource}${who} — ${when}`
      })
      return {
        content: [{ type: 'text', text: `${entries.length} audit entry(ies):\n\n${lines.join('\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_audit_summary
server.tool(
  'get_audit_summary',
  'Get a summary of recent audit activity: most active users, most common actions, and daily breakdown.',
  {
    days: z.number().int().min(1).max(90).optional().describe('Number of days to look back (default: 7)'),
  },
  async ({ days }) => {
    try {
      const entries = await getAuditLog({ limit: 500 })
      const cutoff = new Date(Date.now() - (days ?? 7) * 24 * 60 * 60 * 1000)
      const recent = (entries ?? []).filter((e: any) => new Date(e.created_at) >= cutoff)

      const byAction: Record<string, number> = {}
      const byUser: Record<string, number> = {}
      recent.forEach((e: any) => {
        byAction[e.action] = (byAction[e.action] ?? 0) + 1
        const u = e.user_email ?? e.user_id ?? 'system'
        byUser[u] = (byUser[u] ?? 0) + 1
      })

      const topActions = Object.entries(byAction).sort((a, b) => b[1] - a[1]).slice(0, 5)
      const topUsers   = Object.entries(byUser).sort((a, b) => b[1] - a[1]).slice(0, 5)

      const text = [
        `# Audit Summary (last ${days ?? 7} days)`,
        `Total events: ${recent.length}`,
        '',
        '## Top Actions',
        ...topActions.map(([action, count]) => `- ${action}: ${count}`),
        '',
        '## Most Active Users',
        ...topUsers.map(([user, count]) => `- ${user}: ${count} actions`),
      ].join('\n')

      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Projects ─────────────────────────────────────────────────────────────────

// list_projects
server.tool(
  'list_projects',
  'List all projects in the organization. Projects group memories and define event capture settings.',
  {
    include_archived: z.boolean().optional().describe('Include archived projects in the results (default: false)'),
  },
  async ({ include_archived }) => {
    try {
      const projects = await listProjects({ include_archived })
      if (projects.length === 0) {
        return { content: [{ type: 'text', text: 'No projects found.' }] }
      }
      const lines = projects.map((p, i) => {
        const archived = p.is_archived ? ' [archived]' : ''
        const desc = p.description ? ` — ${p.description}` : ''
        return `[${i + 1}] ${p.name}${archived}${desc} (id: ${p.id})`
      })
      return {
        content: [{ type: 'text', text: `${projects.length} project(s):\n\n${lines.join('\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// create_project
server.tool(
  'create_project',
  'Create a new project to organize memories and agent activity.',
  {
    name:        z.string().describe('Name for the new project'),
    description: z.string().optional().describe('Optional description for the project'),
  },
  async ({ name, description }) => {
    try {
      const project = await createProject({ name, description })
      return {
        content: [{ type: 'text', text: `Project created: "${project.name}" (id: ${project.id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// update_project
server.tool(
  'update_project',
  'Update project settings: description, custom AI instructions, data retention policy, or archive status.',
  {
    id:                  z.string().describe('Project ID to update (returned by list_projects)'),
    description:         z.string().optional().describe('New description for the project'),
    custom_instructions: z.string().optional().describe('Custom AI instructions injected into agent context'),
    retention_days:      z.number().int().min(0).optional().describe('Days to retain memories (0 = forever)'),
    archived:            z.boolean().optional().describe('true to archive, false to restore'),
  },
  async ({ id, description, custom_instructions, retention_days, archived }) => {
    try {
      await updateProject(id, { description, custom_instructions, retention_days, archived })
      const parts: string[] = [`Project ${id} updated.`]
      if (description         !== undefined) parts.push(`description: ${description || '(cleared)'}`)
      if (custom_instructions !== undefined) parts.push(`custom_instructions: ${custom_instructions ? '(set)' : '(cleared)'}`)
      if (retention_days      !== undefined) parts.push(`retention_days: ${retention_days}`)
      if (archived            !== undefined) parts.push(`archived: ${archived}`)
      return {
        content: [{ type: 'text', text: parts.join('\n') }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_project_members
server.tool(
  'get_project_members',
  'List all members of a project.',
  {
    project_id: z.string().describe('The project ID to list members for'),
  },
  async ({ project_id }) => {
    try {
      const members = await getProjectMembers(project_id)
      if (members.length === 0) {
        return { content: [{ type: 'text', text: `No members found for project ${project_id}.` }] }
      }
      const lines = members.map((m, i) => {
        const name  = m.name  ? ` — ${m.name}`  : ''
        const email = m.email ? ` <${m.email}>` : ''
        return `[${i + 1}] ${m.user_id}${name}${email} (role: ${m.role})`
      })
      return {
        content: [{ type: 'text', text: `${members.length} member(s) in project ${project_id}:\n\n${lines.join('\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// add_project_member
server.tool(
  'add_project_member',
  'Add a user to a project.',
  {
    project_id: z.string().describe('The project ID to add the user to'),
    user_id:    z.string().describe('The user ID to add to the project'),
  },
  async ({ project_id, user_id }) => {
    try {
      await addProjectMember(project_id, user_id)
      return {
        content: [{ type: 'text', text: `User ${user_id} added to project ${project_id}.` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Admin Users ───────────────────────────────────────────────────────────────

// list_users
server.tool(
  'list_users',
  'List all users in the organization with their roles, status, last login, and API key usage.',
  {},
  async () => {
    try {
      const users = await listUsers()
      if (users.length === 0) {
        return { content: [{ type: 'text', text: 'No users found.' }] }
      }
      const lines = users.map((u, i) => {
        const name     = u.name      ? ` — ${u.name}`           : ''
        const email    = u.email     ? ` <${u.email}>`          : ''
        const role     = u.role      ? ` (role: ${u.role})`     : ''
        const status   = u.status    ? ` [${u.status}]`         : ''
        const lastLogin = u.last_login_at
          ? ` · last login: ${new Date(u.last_login_at).toLocaleString()}`
          : ''
        const keyUsage = u.api_key_usage != null ? ` · API key uses: ${u.api_key_usage}` : ''
        return `[${i + 1}] ${u.id}${name}${email}${role}${status}${lastLogin}${keyUsage}`
      })
      return {
        content: [{ type: 'text', text: `${users.length} user(s):\n\n${lines.join('\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// invite_user
server.tool(
  'invite_user',
  'Invite a new user to the organization by email. They will receive an invite link.',
  {
    email: z.string().email().describe('Email address of the user to invite'),
    role:  z.string().optional().describe('Role to assign to the invited user (e.g. "member", "admin")'),
  },
  async ({ email, role }) => {
    try {
      const res = await inviteUser({ email, role })
      return {
        content: [{ type: 'text', text: `Invite sent to ${email} (id: ${res.id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// disable_user
server.tool(
  'disable_user',
  'Disable a user account to block their access without deleting them.',
  {
    user_id: z.string().describe('ID of the user to disable'),
  },
  async ({ user_id }) => {
    try {
      await disableUser(user_id)
      return {
        content: [{ type: 'text', text: `User ${user_id} has been disabled.` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// enable_user
server.tool(
  'enable_user',
  'Re-enable a previously disabled user account.',
  {
    user_id: z.string().describe('ID of the user to re-enable'),
  },
  async ({ user_id }) => {
    try {
      await enableUser(user_id)
      return {
        content: [{ type: 'text', text: `User ${user_id} has been enabled.` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// bulk_disable_users
server.tool(
  'bulk_disable_users',
  'Disable multiple users at once. Use list_users to find user IDs.',
  {
    user_ids: z.array(z.string()).min(1).describe('IDs of the users to disable'),
  },
  async ({ user_ids }) => {
    try {
      await Promise.all(user_ids.map(id => disableUser(id)))
      return {
        content: [{ type: 'text', text: `${user_ids.length} user(s) disabled.` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// bulk_enable_users
server.tool(
  'bulk_enable_users',
  'Re-enable multiple disabled users at once.',
  {
    user_ids: z.array(z.string()).min(1).describe('IDs of the users to re-enable'),
  },
  async ({ user_ids }) => {
    try {
      await Promise.all(user_ids.map(id => enableUser(id)))
      return {
        content: [{ type: 'text', text: `${user_ids.length} user(s) enabled.` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// list_roles
server.tool(
  'list_roles',
  'List all roles in the organization with their permissions.',
  {},
  async () => {
    try {
      const roles = await listRoles()
      if (roles.length === 0) {
        return { content: [{ type: 'text', text: 'No roles found.' }] }
      }
      const lines = roles.map((r, i) => {
        const perms = r.permissions && r.permissions.length > 0
          ? `\n    permissions: ${r.permissions.join(', ')}`
          : ''
        return `[${i + 1}] ${r.name} (id: ${r.id})${perms}`
      })
      return {
        content: [{ type: 'text', text: `${roles.length} role(s):\n\n${lines.join('\n\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// create_role
server.tool(
  'create_role',
  'Create a new role in the organization with a specified set of permissions.',
  {
    name:        z.string().describe('Name for the new role (e.g. "viewer", "editor")'),
    description: z.string().optional().describe('Optional description of what this role allows'),
    permissions: z.array(z.string()).describe('List of permission strings to grant (e.g. ["memory.read", "memory.write"])'),
  },
  async ({ name, description, permissions }) => {
    try {
      const role = await createRole({ name, description, permissions })
      return {
        content: [{ type: 'text', text: `Role created: "${role.name}" (id: ${role.id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// delete_role
server.tool(
  'delete_role',
  'Permanently delete a role by ID. Requires confirm: true. There is no undo — users with this role will lose it.',
  {
    role_id: z.string().describe('ID of the role to delete (returned by list_roles)'),
    confirm: z.boolean().describe('Must be true to perform the deletion. Without this, the tool refuses and makes no HTTP request.'),
  },
  async ({ role_id, confirm }) => {
    if (confirm !== true) {
      return {
        content: [{
          type: 'text',
          text: 'Refused: delete_role requires confirm: true. No HTTP request was made.',
        }],
        isError: true,
      }
    }
    try {
      await deleteRole(role_id)
      return {
        content: [{ type: 'text', text: `Role deleted (id: ${role_id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Webhooks ──────────────────────────────────────────────────────────────────

// list_webhooks
server.tool(
  'list_webhooks',
  'List all webhooks configured in the organization.',
  {},
  async () => {
    try {
      const webhooks = await listWebhooks()
      if (webhooks.length === 0) {
        return { content: [{ type: 'text', text: 'No webhooks found.' }] }
      }
      const lines = webhooks.map((w, i) => {
        const name   = w.name ? ` — ${w.name}` : ''
        const events = w.events && w.events.length > 0 ? `\n    events: ${w.events.join(', ')}` : ''
        const created = w.created_at ? ` · created: ${new Date(w.created_at).toLocaleString()}` : ''
        return `[${i + 1}] ${w.id}${name} → ${w.url}${created}${events}`
      })
      return {
        content: [{ type: 'text', text: `${webhooks.length} webhook(s):\n\n${lines.join('\n\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// create_webhook
server.tool(
  'create_webhook',
  'Create a new webhook endpoint to receive NexusMind events.',
  {
    url:    z.string().url().describe('The HTTPS URL that will receive webhook POST requests'),
    events: z.array(z.string()).min(1).describe('List of event types to subscribe to (e.g. ["memory.created", "user.invited"])'),
    name:   z.string().optional().describe('Optional human-readable label for this webhook'),
  },
  async ({ url, events, name }) => {
    try {
      const webhook = await createWebhook({ url, events, name })
      const label = webhook.name ? `"${webhook.name}"` : `id: ${webhook.id}`
      return {
        content: [{ type: 'text', text: `Webhook created (${label}) → ${webhook.url}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// update_webhook
server.tool(
  'update_webhook',
  'Update an existing webhook: change its URL, subscribed events, or display name.',
  {
    id:     z.string().describe('ID of the webhook to update (returned by list_webhooks or create_webhook)'),
    url:    z.string().url().optional().describe('New HTTPS URL for the webhook'),
    events: z.array(z.string()).optional().describe('New list of event types to subscribe to'),
    name:   z.string().optional().describe('New display name for the webhook'),
  },
  async ({ id, url, events, name }) => {
    try {
      const webhook = await updateWebhook(id, { url, events, name })
      const label = webhook.name ? `"${webhook.name}"` : `id: ${webhook.id}`
      return {
        content: [{ type: 'text', text: `Webhook updated (${label}) → ${webhook.url}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// delete_webhook
server.tool(
  'delete_webhook',
  'Delete a webhook.',
  {
    id: z.string().describe('ID of the webhook to delete (returned by list_webhooks or create_webhook)'),
  },
  async ({ id }) => {
    try {
      await deleteWebhook(id)
      return {
        content: [{ type: 'text', text: `Webhook deleted (id: ${id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// test_webhook
server.tool(
  'test_webhook',
  'Send a test ping to a webhook to verify it is receiving events. Use list_webhooks to find webhook IDs.',
  {
    id: z.string().describe('ID of the webhook to test (returned by list_webhooks or create_webhook)'),
  },
  async ({ id }) => {
    try {
      const result = await testWebhook(id)
      return {
        content: [{ type: 'text', text: result ? `Test ping sent to webhook ${id}` : `Webhook test completed for ${id}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Org Settings ─────────────────────────────────────────────────────────────

// get_org_settings
server.tool(
  'get_org_settings',
  "Get the organization's current settings: retention policy, custom AI instructions, announcement, min password length, and branding.",
  {},
  async () => {
    try {
      const settings = await getOrgSettings()
      return {
        content: [{ type: 'text', text: JSON.stringify(settings, null, 2) }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_announcement
server.tool(
  'get_announcement',
  "Get the current org announcement. Returns the announcement text, or 'No active announcement' if none is set.",
  {},
  async () => {
    try {
      const org = await getOrgSettings()
      const announcement = org?.announcement ?? ''
      return {
        content: [{
          type: 'text',
          text: announcement.trim()
            ? `Current announcement: ${announcement}`
            : 'No active announcement.',
        }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// update_org_settings
server.tool(
  'update_org_settings',
  'Update organization settings. Use custom_instructions to set org-wide AI instructions that will be injected into all agent context.',
  {
    custom_instructions: z.string().optional().describe('Org-wide AI instructions injected into all agent context'),
    retention_days:      z.number().int().min(0).optional().describe('Number of days to retain memories (0 = retain forever)'),
    min_password_length: z.number().int().min(6).optional().describe('Minimum password length for org members'),
  },
  async ({ custom_instructions, retention_days, min_password_length }) => {
    try {
      const settings = await updateOrgSettings({ custom_instructions, retention_days, min_password_length })
      return {
        content: [{ type: 'text', text: `Org settings updated.\n\n${JSON.stringify(settings, null, 2)}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Org Stats ─────────────────────────────────────────────────────────────────

// get_stats
server.tool(
  'get_stats',
  'Get organization statistics: total memories, users, code projects, API calls, and storage usage.',
  {},
  async () => {
    try {
      const stats = await getStats()
      const lines: string[] = ['Organization statistics:', '']
      if (stats.total_memories     != null) lines.push(`  Memories:      ${stats.total_memories}`)
      if (stats.total_users        != null) lines.push(`  Users:         ${stats.total_users}`)
      if (stats.total_code_projects != null) lines.push(`  Code projects: ${stats.total_code_projects}`)
      if (stats.total_api_calls    != null) lines.push(`  API calls:     ${stats.total_api_calls}`)
      if (stats.storage_usage      != null) lines.push(`  Storage usage: ${stats.storage_usage}`)
      if (lines.length === 2) lines.push(JSON.stringify(stats, null, 2))
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_agent_activity
server.tool(
  'get_agent_activity',
  'Get recent agent activity events across all agents in the organization.',
  {
    limit: z.number().int().min(1).max(200).optional().describe('Max number of activity events to return'),
  },
  async ({ limit }) => {
    try {
      const events = await getAgentActivity(limit)
      if (events.length === 0) {
        return { content: [{ type: 'text', text: 'No agent activity found.' }] }
      }
      const lines = events.map((e, i) => {
        const agent   = e.agent     ? ` [${e.agent}]`   : ''
        const action  = e.action    ? ` — ${e.action}`  : ''
        const project = e.project   ? ` (${e.project})` : ''
        const ts      = e.created_at ? ` · ${new Date(e.created_at).toLocaleString()}` : ''
        return `[${i + 1}] ${e.id ?? ''}${agent}${action}${project}${ts}`
      })
      return {
        content: [{ type: 'text', text: `${events.length} event(s):\n\n${lines.join('\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_tag_stats
server.tool(
  'get_tag_stats',
  'Get tag usage statistics: which tags are most used and their memory counts.',
  {},
  async () => {
    try {
      const tags = await getTagStats()
      if (tags.length === 0) {
        return { content: [{ type: 'text', text: 'No tag statistics available.' }] }
      }
      const lines = tags.map((t, i) => `[${i + 1}] ${t.tag} — ${t.count} memory(ies)`)
      return {
        content: [{ type: 'text', text: `${tags.length} tag(s):\n\n${lines.join('\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Admin Memory Ops ──────────────────────────────────────────────────────────

// import_memories
server.tool(
  'import_memories',
  'Bulk import multiple memories at once. Useful for migrating memories from another system or restoring from a backup.',
  {
    memories: z.array(
      z.object({
        content:  z.string().describe('Memory content'),
        tags:     z.array(z.string()).optional().describe('Tags to apply to this memory'),
        metadata: z.record(z.unknown()).optional().describe('Arbitrary metadata for this memory'),
      })
    ).min(1).describe('Array of memory objects to import'),
  },
  async ({ memories }) => {
    try {
      const result = await importMemories(memories)
      const count = result.imported ?? memories.length
      return {
        content: [{ type: 'text', text: `Import complete. ${count} memory(ies) imported.` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// find_duplicate_memories
server.tool(
  'find_duplicate_memories',
  'Find memories with similar or duplicate content. Returns groups of potentially duplicate memories for review.',
  {},
  async () => {
    try {
      const groups = await findDuplicateMemories()
      if (groups.length === 0) {
        return { content: [{ type: 'text', text: 'No duplicate memories found.' }] }
      }
      const lines = groups.map((g, i) => {
        const ids = Array.isArray(g.ids) ? g.ids.join(', ') : JSON.stringify(g)
        return `[${i + 1}] ids: ${ids}`
      })
      return {
        content: [{ type: 'text', text: `${groups.length} duplicate group(s):\n\n${lines.join('\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_memory_trends
server.tool(
  'get_memory_trends',
  'Get memory creation trends over time. Returns daily counts for charting and a weekly summary.',
  {
    days: z.number().int().min(1).max(90).optional().describe('Number of days to look back (default: 30, max: 90)'),
  },
  async (input) => {
    try {
      const days = Math.min(input.days ?? 30, 90)
      const raw = await getMemoryTrends()
      // getMemoryTrends returns TrendEntry[] (flat array of { date, count })
      const allEntries: any[] = Array.isArray(raw) ? raw : (raw as any)?.daily_counts ?? []
      const entries = allEntries.slice(-days)
      const total = entries.reduce((s: number, e: any) => s + (e.count ?? 0), 0)
      const thisWeek = entries.slice(-7).reduce((s: number, e: any) => s + (e.count ?? 0), 0)
      const text = [
        `## Memory Trends (last ${days} days)`,
        `- Total: ${total} memories created`,
        `- This week: ${thisWeek}`,
        '',
        '### Daily breakdown',
        ...entries.slice(-7).map((e: any) => `- ${e.date}: ${e.count}`)
      ].join('\n')
      return { content: [{ type: 'text', text: text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// update_org
server.tool(
  'update_org',
  "Update the organization's name or slug.",
  {
    name: z.string().optional().describe('New organization name'),
    slug: z.string().optional().describe('New organization slug (URL-safe identifier)'),
  },
  async ({ name, slug }) => {
    try {
      const org = await updateOrg({ name, slug })
      const parts: string[] = ['Organization updated.']
      if (org.name) parts.push(`name: ${org.name}`)
      if (org.slug) parts.push(`slug: ${org.slug}`)
      return {
        content: [{ type: 'text', text: parts.join('\n') }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// rename_tag — also used to merge tags: renaming to an existing tag folds the old one into it.
server.tool(
  'rename_tag',
  'Rename a tag across all memories in the organization, replacing old_tag with new_tag. Also doubles as tag merging: if new_tag already exists, old_tag is absorbed into it and removed.',
  {
    old_tag: z.string().describe('The existing tag name to rename (or merge away)'),
    new_tag: z.string().describe('The new tag name to replace it with (or merge into)'),
  },
  async ({ old_tag, new_tag }) => {
    try {
      const result = await renameTag(old_tag, new_tag)
      const count = result.updated ?? 0
      return {
        content: [{ type: 'text', text: `Tag renamed: "${old_tag}" → "${new_tag}". ${count} memory(ies) updated.` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// set_announcement
server.tool(
  'set_announcement',
  'Set or clear the organization-wide announcement banner shown to all users.',
  {
    message: z.string().nullable().describe('Announcement text to display, or null to clear the banner'),
    type:    z.enum(['info', 'warning', 'error']).optional().describe('Banner type: "info" (default), "warning", or "error"'),
  },
  async ({ message, type }) => {
    try {
      await setAnnouncement(message, type)
      const text = message === null
        ? 'Announcement cleared.'
        : `Announcement set${type ? ` (${type})` : ''}: "${message}"`
      return {
        content: [{ type: 'text', text: text }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// export_memories
server.tool(
  'export_memories',
  'Export memories matching the given filters. Returns the export data as a string (JSON or CSV).',
  {
    query:         z.string().optional().describe('Optional search query to filter exported memories'),
    tags:          z.array(z.string()).optional().describe('Filter by tags (e.g. ["auth", "convention"])'),
    collection_id: z.string().optional().describe('Filter by collection ID'),
    format:        z.enum(['json', 'csv']).optional().describe('Export format: "json" (default) or "csv"'),
  },
  async ({ query, tags, collection_id, format }) => {
    try {
      const data = await exportMemories({ query, tags, collection_id, format })
      return { content: [{ type: 'text', text: data }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_memory_facets
server.tool(
  'get_memory_facets',
  'Get memory facets: breakdown by tags, projects, types, and time periods. Useful for understanding the shape of the memory corpus.',
  {},
  async () => {
    try {
      const facets = await getMemoryFacets()
      const lines: string[] = ['Memory facets:', '']
      for (const [key, items] of Object.entries(facets)) {
        if (!Array.isArray(items) || items.length === 0) continue
        lines.push(`### ${key}`)
        items.forEach(item => {
          const entry = typeof item === 'object' && item !== null
            ? `${(item as Record<string, unknown>).value ?? JSON.stringify(item)}: ${(item as Record<string, unknown>).count ?? ''}`
            : String(item)
          lines.push(`  ${entry}`)
        })
        lines.push('')
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_usage_stats
server.tool(
  'get_usage_stats',
  'Get API usage statistics: request counts, active API keys, most active agents, and rate limit data.',
  {},
  async () => {
    try {
      const stats = await getUsageStats()
      const lines: string[] = ['Usage statistics:', '']
      if (stats.total_requests    != null) lines.push(`  Total requests:  ${stats.total_requests}`)
      if (stats.active_api_keys   != null) lines.push(`  Active API keys: ${stats.active_api_keys}`)
      if (stats.most_active_agents && Array.isArray(stats.most_active_agents) && stats.most_active_agents.length > 0) {
        lines.push('  Most active agents:')
        stats.most_active_agents.forEach((a, i) => {
          lines.push(`    [${i + 1}] ${a.agent} — ${a.requests} requests`)
        })
      }
      if (lines.length === 2) lines.push(JSON.stringify(stats, null, 2))
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// update_session
server.tool(
  'update_session',
  "Update a session's summary or description to label a group of related memories.",
  {
    id:          z.string().describe('The session ID to update'),
    summary:     z.string().optional().describe('New summary for the session'),
    description: z.string().optional().describe('New description for the session'),
  },
  async ({ id, summary, description }) => {
    try {
      const session = await updateSession(id, { summary, description })
      return {
        content: [{ type: 'text', text: `Session updated (id: ${session.id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// check_convention_compliance
server.tool(
  'check_convention_compliance',
  'Check whether a proposed action or implementation complies with all active team conventions. Returns COMPLIANT or NON-COMPLIANT with specific violations listed.',
  {
    action:  z.string().describe('A description of what the agent is about to do or implement'),
    project: z.string().optional().describe('Optional project slug to scope results to that project plus global (unscoped) items.'),
  },
  async ({ action, project }) => {
    try {
      const conventions = await listConventions(undefined, undefined, project)
      const active = conventions
        .filter((c: any) => !c.archived_at)
        .sort((a: any, b: any) => b.weight - a.weight)

      const CONVENTION_TEXT_CAP = 300
      const conventionText = active.map((c: any) => {
        const truncated = c.content.length > CONVENTION_TEXT_CAP
        const body = truncated
          ? `${c.content.slice(0, CONVENTION_TEXT_CAP)}… (truncated — use get_convention(${c.id}) for full text)`
          : c.content
        return `[${c.category?.toUpperCase() ?? 'GENERAL'} - weight:${c.weight ?? 0}] ${c.title ?? `Convention ${c.id}`}:\n${body}`
      }).join('\n\n---\n\n')

      const text = [
        'Convention Compliance Check',
        '',
        `Proposed action: "${action}"`,
        '',
        'Active conventions to check against:',
        '',
        conventionText,
        '',
        '---',
        'Please review the proposed action against each convention and identify any violations. Return COMPLIANT if no violations, or NON-COMPLIANT with specific conventions violated.',
      ].join('\n')

      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// list_sessions
server.tool(
  'list_sessions',
  'List recent work sessions. Sessions group related memories by time and context. Useful for understanding what was worked on recently.',
  {
    limit: z.number().int().min(1).max(100).optional().describe('Max sessions to return (default: 20)'),
  },
  async ({ limit }) => {
    try {
      const sessions = await listSessions({ limit: limit ?? 20 })
      if (sessions.length === 0) {
        return { content: [{ type: 'text', text: 'No sessions found.' }] }
      }
      const lines = sessions.map((s: Session, i: number) => {
        const summary = s.summary ? ` — ${s.summary}` : ''
        const count   = s.memory_count != null ? ` · ${s.memory_count} memories` : ''
        const updated = s.updated_at ? ` · updated: ${new Date(s.updated_at).toLocaleString()}` : ''
        return `[${i + 1}] ${s.id}${summary}${count}${updated}`
      })
      return {
        content: [{ type: 'text', text: `${sessions.length} session(s):\n\n${lines.join('\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// delete_session
server.tool(
  'delete_session',
  'Delete a session and optionally its memories. Sessions group related work; delete when the context is no longer relevant.',
  {
    id: z.string().describe('The session ID to delete'),
  },
  async ({ id }) => {
    try {
      await deleteSession(id)
      return {
        content: [{ type: 'text', text: `Session deleted (id: ${id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// create_session
server.tool(
  'create_session',
  'Create a new work session to group related memories. Returns the new session ID.',
  {
    summary:     z.string().optional().describe('Optional summary for the new session'),
    description: z.string().optional().describe('Optional description for the new session'),
  },
  async ({ summary, description }) => {
    try {
      const session = await createSession({ summary, description })
      return {
        content: [{ type: 'text', text: `Session created (id: ${session.id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_session_stats
server.tool(
  'get_session_stats',
  'Get session statistics: total sessions, total memories across all sessions, most active sessions.',
  {},
  async () => {
    try {
      const sessions = await listSessions({ limit: 100 })
      const all = sessions ?? []
      const totalMemories = all.reduce((sum: number, s: any) => sum + (s.memory_count ?? 0), 0)
      const topSessions = [...all]
        .sort((a: any, b: any) => (b.memory_count ?? 0) - (a.memory_count ?? 0))
        .slice(0, 5)
      const text = [
        '## Session Stats',
        `- Total sessions: ${all.length}`,
        `- Total memories across sessions: ${totalMemories}`,
        `- Avg memories per session: ${all.length ? Math.round(totalMemories / all.length) : 0}`,
        '',
        '## Most Active Sessions',
        ...topSessions.map((s: any) => `- **${s.summary || s.name || 'Untitled'}**: ${s.memory_count ?? 0} memories`),
      ].join('\n')
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// health_check — unified health tool. Absorbs memory_health_check and quick_health_check.
server.tool(
  'health_check',
  'Check memory corpus health: total count, duplicates, stale (>30d, based on updated_at falling back to created_at), too-short (<50 chars), and untagged memories. Uses the backend health aggregate when available; falls back to a bounded sample-based estimate (with up to 3 examples per issue) labeled as such.',
  {},
  async () => {
    try {
      // Prefer the cheap backend aggregate — avoids fetching full records just to count them.
      let health: MemoryHealth | null = null
      try {
        health = await getMemoryHealth()
      } catch {
        health = null
      }

      if (health && health.total_memories !== undefined) {
        const text = [
          '## Memory Health (authoritative)',
          `- Total memories: ${health.total_memories}`,
          `- Duplicates: ${health.duplicate_count ?? 0}`,
          `- Stale (>30d): ${health.stale_count ?? 0}`,
          `- Untagged: ${health.untagged_count ?? 0}`,
          '',
          (health.duplicate_count ?? 0) > 0 ? '⚠️ Run `find_duplicate_memories` for details.' : '✅ No duplicates.',
          (health.stale_count ?? 0) > 10  ? '⚠️ Many stale memories — consider archiving.' : '✅ Memory freshness good.',
          (health.untagged_count ?? 0) > 10 ? '⚠️ Many untagged — use `search_and_tag` to categorize.' : '✅ Tagging coverage good.',
        ].join('\n')
        return { content: [{ type: 'text', text }] }
      }

      // Degrade to a bounded sample instead of a large full-record fetch — labeled as an estimate.
      const [memories, duplicates] = await Promise.all([
        listMemories({ limit: 100 }),
        findDuplicateMemories().catch(() => []),
      ])
      const all = memories ?? []
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      // Stale is based on the last update, not creation — a memory edited last week isn't stale
      // even if it was first created a year ago.
      const stale = all.filter(m => new Date(m.updated_at ?? m.created_at) < thirtyDaysAgo)
      const untagged = all.filter(m => !m.tags || m.tags.length === 0)
      const tooShort = all.filter(m => m.content.length < 50)
      const dupeCount = duplicates?.length ?? 0

      const exampleLines = (label: string, items: Memory[]) => items.length === 0
        ? []
        : [`  Examples: ${items.slice(0, 3).map(m => `[${m.id}] ${m.content.slice(0, 60)}${m.content.length > 60 ? '…' : ''}`).join(' | ')}`]

      const text = [
        `## Memory Health (sample-based estimate, ${all.length} memories)`,
        `- Duplicates: ${dupeCount}`,
        `- Stale (>30d): ${stale.length}`,
        `- Too short (<50 chars): ${tooShort.length}`,
        ...exampleLines('too_short', tooShort),
        `- Untagged: ${untagged.length}`,
        '',
        dupeCount > 0 ? '⚠️ Run `find_duplicate_memories` for exact duplicates.' : '✅ No obvious duplicates.',
        stale.length > 10 ? '⚠️ Many stale memories — consider archiving old ones.' : '✅ Memory freshness looks good.',
        tooShort.length > 10 ? '⚠️ Many too-short memories — consider expanding or merging them.' : '✅ Content length looks good.',
        untagged.length > 10 ? '⚠️ Many untagged memories — use `search_and_tag` to categorize.' : '✅ Tagging coverage looks good.',
      ].join('\n')

      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// batch_archive_memories
server.tool(
  'batch_archive_memories',
  'Archive multiple memories at once by their IDs.',
  {
    ids: z.array(z.string()).min(1).describe('Array of memory IDs to archive'),
  },
  async ({ ids }) => {
    try {
      const results = await Promise.all(ids.map(id => archiveMemory(id)))
      return {
        content: [{ type: 'text', text: `Archived ${results.length} memories` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// batch_restore_memories
server.tool(
  'batch_restore_memories',
  'Restore multiple archived memories at once.',
  {
    ids: z.array(z.string()).min(1).describe('Array of memory IDs to restore'),
  },
  async ({ ids }) => {
    try {
      const results = await Promise.all(ids.map(id => restoreMemory(id)))
      return {
        content: [{ type: 'text', text: `Restored ${results.length} memories` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// search_and_tag
server.tool(
  'search_and_tag',
  'Search memories by query and bulk-update their tags. Useful for organizing memories after an audit.',
  {
    query:       z.string().describe('Search query to find memories to tag'),
    add_tags:    z.array(z.string()).min(1).describe('Tags to add to all matching memories'),
    remove_tags: z.array(z.string()).optional().describe('Tags to remove from all matching memories'),
  },
  async ({ query, add_tags, remove_tags }) => {
    try {
      const memories = await searchMemories({ query })
      const ids = memories.map(m => m.id)
      if (ids.length === 0) {
        return {
          content: [{ type: 'text', text: `No memories found for query: "${query}"` }],
        }
      }
      for (const tag of add_tags) {
        await bulkTagMemoriesSingle(ids, 'add', tag)
      }
      for (const tag of (remove_tags ?? [])) {
        await bulkTagMemoriesSingle(ids, 'remove', tag)
      }
      return {
        content: [{ type: 'text', text: `Tagged ${ids.length} memories with [${add_tags.join(', ')}]` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// find_related_memories
server.tool(
  'find_related_memories',
  'Find memories similar to a given memory. Fetches the memory content, then searches for semantically related ones.',
  {
    memory_id: z.string().describe('ID of the source memory to find related memories for'),
    limit:     z.number().int().min(1).max(20).optional().describe('Max related memories to return (default: 5)'),
  },
  async ({ memory_id, limit }) => {
    try {
      const mem = await getMemoryById(memory_id)
      const query = mem.content.slice(0, 100)
      const results = await searchMemories({ query, limit: (limit ?? 5) + 1 })
      const related = results.filter(r => r.id !== memory_id).slice(0, limit ?? 5)
      if (related.length === 0) {
        return { content: [{ type: 'text', text: `No related memories found for id: ${memory_id}.` }] }
      }
      return {
        content: [{
          type: 'text',
          text: `Found ${related.length} memory(ies) related to "${mem.title ?? mem.content.slice(0, 60)}":\n\n${formatList(related)}`,
        }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// pin_convention
server.tool(
  'pin_convention',
  'Pin a convention to the top by setting its weight to 999. Pinned conventions always appear first in context.',
  {
    id: z.string().describe('Convention ID to pin (returned by list_conventions or store_convention)'),
  },
  async ({ id }) => {
    try {
      const conv = await pinConvention(id)
      const label = formatConvention(conv, { contentChars: 0 })
      return {
        content: [{ type: 'text', text: `Convention pinned to weight 999 (${label})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// bulk_archive_conventions
server.tool(
  'bulk_archive_conventions',
  'Archive all conventions matching category and/or weight threshold. Useful for cleaning up outdated conventions.',
  {
    category:   z.string().optional().describe('Filter by category (e.g. "naming", "architecture"). Omit to match all categories.'),
    max_weight: z.number().optional().describe('Archive conventions with weight less than or equal to this value. Omit to ignore weight when filtering.'),
    project:    z.string().optional().describe('Optional project slug to scope results to that project plus global (unscoped) items.'),
  },
  async ({ category, max_weight, project }) => {
    try {
      const conventions = await listConventions(category, false, project)
      const targets = conventions.filter(c => {
        if (max_weight != null) {
          const w = (c as any).weight ?? 0
          if (w > max_weight) return false
        }
        return true
      })
      if (targets.length === 0) {
        return { content: [{ type: 'text', text: 'No conventions matched the given filters. Nothing archived.' }] }
      }
      await Promise.all(targets.map(c => archiveConvention(c.id)))
      const categoryNote = category ? ` in category "${category}"` : ''
      const weightNote   = max_weight != null ? ` with weight ≤ ${max_weight}` : ''
      return {
        content: [{ type: 'text', text: `Archived ${targets.length} convention(s)${categoryNote}${weightNote}.` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// bulk_update_convention_weight
server.tool(
  'bulk_update_convention_weight',
  'Set the weight for all conventions in a category. Use to boost or reduce an entire category\'s priority.',
  {
    category: z.string().describe('Category whose conventions will be updated (e.g. "naming", "architecture")'),
    weight:   z.number().int().describe('New weight to assign to all conventions in the category'),
    project:  z.string().optional().describe('Optional project slug to scope results to that project plus global (unscoped) items.'),
  },
  async ({ category, weight, project }) => {
    try {
      const conventions = await listConventions(category, false, project)
      if (conventions.length === 0) {
        return { content: [{ type: 'text', text: `No active conventions found for category "${category}".` }] }
      }
      await Promise.all(conventions.map(c => updateConvention(c.id, { weight })))
      return {
        content: [{ type: 'text', text: `Updated weight to ${weight} for ${conventions.length} convention(s) in category "${category}".` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Agent Orientation Tools ───────────────────────────────────────────────────

// onboard_agent — delegates to buildContext (the same builder get_context uses) for the
// conventions/memories/stats portion, then layers on its write side-effect and org/project info.
server.tool(
  'onboard_agent',
  'Complete onboarding for a new AI agent: saves an agent memory, then returns get_context plus projects and org settings.',
  {
    agent_name: z.string().describe('Name of the agent being onboarded (e.g. "cursor", "claude-code", "my-custom-agent")'),
    project:    z.string().optional().describe('Optional project the agent will work on'),
  },
  async ({ agent_name, project }) => {
    try {
      // 1. Store a memory marking this agent as onboarded
      await storeMemory({
        content: `Agent ${agent_name} onboarded to NexusMind${project ? ` for project ${project}` : ''}`,
        title: `Onboarded agent: ${agent_name}`,
        type: 'manual',
        tags: ['agent-onboarding', agent_name.toLowerCase().replace(/\s+/g, '-')],
        project,
      })

      // 2. Fetch context (conventions + memories + stats) plus onboarding-only extras in parallel
      const [contextText, projects, org] = await Promise.all([
        buildContext({ project, mode: 'full', include_stats: true }).catch(() => 'No team context found.'),
        listProjects({}).catch(() => []),
        getOrgSettings().catch(() => ({})),
      ])

      const projectLines = (projects ?? [])
        .filter((p: any) => !p.is_archived)
        .map((p: any) => `- **${p.name}**: ${p.description ?? 'No description'} (${p.memory_count ?? 0} memories)`)

      const output = [
        `# NexusMind Agent Bootstrap`,
        '',
        `Welcome, ${agent_name}!`,
        '',
        `## Organization: ${(org as any)?.name ?? 'Unknown'}`,
        (org as any)?.announcement ? `\n> **Announcement**: ${(org as any).announcement}\n` : '',
        '',
        contextText,
        '',
        '## Projects',
        projectLines.length ? projectLines.join('\n') : '- No projects yet',
        '',
        '## Quick Start',
        '- Use `store_memory` to save important decisions and discoveries',
        '- Use `search_memories` to find relevant past context',
        '- Use `get_context` for full project knowledge (grouped by type)',
        '- Use `check_convention_compliance` to verify your work follows team conventions',
        '- Use `list_conventions` to see all team conventions with weights',
      ].join('\n')

      return {
        content: [{ type: 'text', text: output }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// record_decision
server.tool(
  'record_decision',
  'Record an Architecture Decision Record (ADR) — a structured decision with context, options, rationale, and consequences.',
  {
    title:               z.string().describe('Short title for the decision'),
    context:             z.string().describe('Why this decision was needed'),
    options_considered:  z.array(z.string()).min(1).describe('Options that were evaluated'),
    decision:            z.string().describe('What was chosen'),
    rationale:           z.string().describe('Why this option won over the alternatives'),
    consequences:        z.string().optional().describe('Changes, risks, or follow-up work this entails'),
    project:             z.string().optional().describe('Project or repo name'),
    tags:                z.array(z.string()).optional().describe('Additional tags for filtering'),
  },
  async ({ title, context, options_considered, decision, rationale, consequences, project, tags }) => {
    try {
      const content = [
        `# Decision: ${title}`,
        '',
        `## Context`,
        context,
        '',
        `## Options Considered`,
        ...options_considered.map(o => `- ${o}`),
        '',
        `## Decision`,
        decision,
        '',
        `## Rationale`,
        rationale,
        ...(consequences ? ['', '## Consequences', consequences] : []),
      ].join('\n')

      const result = await storeMemory({
        content,
        title,
        type: 'decision',
        tags: ['adr', 'decision', ...(tags ?? [])],
        project,
      })
      return {
        content: [{ type: 'text', text: `Decision recorded: "${title}" (id: ${result?.id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Sprint / Standup Tools ───────────────────────────────────────────────────

server.tool(
  'create_sprint_retrospective',
  'Generate a sprint retrospective from recent memories grouped by type.',
  {
    sprint_name: z.string().optional().describe('Label for the sprint (e.g. "Sprint 42")'),
    since:       z.string().optional().describe('ISO date string — start of the period (default: 14 days ago)'),
    project:     z.string().optional().describe('Project to filter memories by'),
  },
  async (input) => {
    try {
      const memories = await listMemories({ project: input.project, limit: 50 })
      const since = input.since ? new Date(input.since) : new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
      const recent = (memories ?? []).filter((m: any) => new Date(m.created_at) >= since)
      const byType = {
        shipped:     recent.filter((m: any) => m.tags?.some((t: string) => ['feature','shipped','done'].includes(t))),
        decisions:   recent.filter((m: any) => m.tags?.some((t: string) => ['decision','adr'].includes(t))),
        bugs:        recent.filter((m: any) => m.tags?.some((t: string) => ['bugfix','fix','bug'].includes(t))),
        discoveries: recent.filter((m: any) => m.tags?.some((t: string) => ['discovery','learning'].includes(t))),
      }
      const sprintLabel = input.sprint_name ?? `Sprint ending ${new Date().toLocaleDateString()}`
      const fmt = (arr: any[]) => arr.length ? arr.slice(0, 10).map((m: any) => `- ${m.content.slice(0, 120)}`).join('\n') : '- (none recorded)'
      const text = [
        `# Sprint Retrospective: ${sprintLabel}`,
        `Period: ${since.toLocaleDateString()} → ${new Date().toLocaleDateString()}`,
        `Memories analyzed: ${recent.length}`,
        '',
        '## ✅ Shipped',
        fmt(byType.shipped),
        '',
        '## 🔧 Bugs',
        fmt(byType.bugs),
        '',
        '## 🧭 Decisions',
        fmt(byType.decisions),
        '',
        '## 💡 Discoveries',
        fmt(byType.discoveries),
        '',
        '## Summary',
        `Shipped:${byType.shipped.length} Bugs:${byType.bugs.length} Decisions:${byType.decisions.length} Learnings:${byType.discoveries.length}`,
      ].join('\n')
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true }
    }
  }
)

server.tool(
  'generate_daily_standup',
  "Generate a daily standup from yesterday's memories.",
  {
    project: z.string().optional().describe('Project to filter memories by'),
  },
  async (input) => {
    try {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const memories = await listMemories({ project: input.project, limit: 20 })
      const recent = (memories ?? []).filter((m: any) => new Date(m.created_at) >= yesterday)
      const text = [
        `# Daily Standup — ${new Date().toLocaleDateString()}`,
        '',
        '## Yesterday',
        ...(recent.length ? recent.map((m: any) => `- ${m.content.slice(0, 100)}`) : ['- (none recorded)']),
        '',
        '## Today\n- [Plan next steps]',
        '',
        '## Blockers\n- [Note blockers]',
      ].join('\n')
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true }
    }
  }
)

// analyze_memory_gaps
server.tool(
  'analyze_memory_gaps',
  'Find time gaps where no memories were stored. Helps identify periods of untracked work or team members not using NexusMind.',
  {
    days: z.number().int().min(1).max(365).optional().describe('Number of days to analyze (default: 30)'),
  },
  async (input) => {
    try {
      const trends = await getMemoryTrends()
      const days = input.days ?? 30
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      const recent = (trends ?? []).filter((t: any) => new Date(t.date) >= cutoff)

      const gaps: string[] = []
      let currentGap = 0
      let maxGap = 0

      for (const entry of recent) {
        if (entry.count === 0) {
          currentGap++
          maxGap = Math.max(maxGap, currentGap)
        } else {
          if (currentGap >= 2) gaps.push(`${currentGap}-day gap ending ${entry.date}`)
          currentGap = 0
        }
      }

      const total = recent.reduce((s: number, t: any) => s + t.count, 0)
      const activeDays = recent.filter((t: any) => t.count > 0).length
      const avgPerActiveDay = activeDays ? (total / activeDays).toFixed(1) : '0'

      const text = [
        `# Memory Gap Analysis (last ${days} days)`,
        '',
        `## Summary`,
        `- Total memories: ${total}`,
        `- Active days: ${activeDays}/${recent.length}`,
        `- Avg per active day: ${avgPerActiveDay}`,
        `- Longest gap: ${maxGap} days`,
        '',
        gaps.length ? `## Notable Gaps\n${gaps.map(g => `- ${g}`).join('\n')}` : '## No significant gaps found ✅',
      ].join('\n')

      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// assign_user_role
server.tool(
  'assign_user_role',
  "Change a user's role (e.g., 'admin', 'member', 'viewer'). Use list_users to find user IDs.",
  {
    user_id: z.string().describe('The user ID to update (returned by list_users)'),
    role:    z.string().describe("The role to assign (e.g. 'admin', 'member', 'viewer')"),
  },
  async ({ user_id, role }) => {
    try {
      await assignUserRole(user_id, role)
      return {
        content: [{ type: 'text', text: `User ${user_id} role updated to "${role}".` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_users_by_role
server.tool(
  'get_users_by_role',
  'List all users with a specific role.',
  {
    role: z.string().describe("The role to filter by (e.g. 'admin', 'member', 'viewer')"),
  },
  async ({ role }) => {
    try {
      const users = await getUsersByRole(role)
      if (users.length === 0) {
        return { content: [{ type: 'text', text: `No users found with role "${role}".` }] }
      }
      const lines = users.map((u, i) => {
        const name   = u.name  ? ` — ${u.name}`  : ''
        const email  = u.email ? ` <${u.email}>` : ''
        const status = u.status ? ` [${u.status}]` : ''
        return `[${i + 1}] ${u.id}${name}${email}${status}`
      })
      return {
        content: [{ type: 'text', text: `${users.length} user(s) with role "${role}":\n\n${lines.join('\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// export_all_data
server.tool(
  'export_all_data',
  'Export all org data (memories, conventions, projects) as a combined JSON object. Useful for backup or migration.',
  {
    include_memories:    z.boolean().optional().describe('Include memories in the export (default: true)'),
    include_conventions: z.boolean().optional().describe('Include conventions in the export (default: true)'),
    include_projects:    z.boolean().optional().describe('Include projects in the export (default: true)'),
  },
  async (input) => {
    try {
      const [memories, conventions, projects] = await Promise.all([
        input.include_memories    !== false ? listMemories({ limit: 10000 }) : Promise.resolve([]),
        input.include_conventions !== false ? listConventions(undefined, true) : Promise.resolve([]),
        input.include_projects    !== false ? listProjects({}) : Promise.resolve([]),
      ])

      const result = {
        exported_at:  new Date().toISOString(),
        memories:     memories     ?? [],
        conventions:  conventions  ?? [],
        projects:     projects     ?? [],
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Policies ─────────────────────────────────────────────────────────────────

// list_policies
server.tool(
  'list_policies',
  'List all access policies in the organization. Policies define what actions are allowed or denied on resources.',
  {
    project: z.string().optional().describe('Optional project slug to scope results to that project plus global (unscoped) items.'),
  },
  async ({ project }) => {
    try {
      const policies = await listPolicies(project)
      if (policies.length === 0) {
        return { content: [{ type: 'text', text: 'No policies found.' }] }
      }
      const lines = policies.map((p, i) => {
        const name = p.name ? ` — ${p.name}` : ''
        const desc = p.description ? `\n    ${p.description}` : ''
        return `[${i + 1}] id: ${p.id}${name}${desc}`
      })
      return {
        content: [{ type: 'text', text: `${policies.length} policy(ies):\n\n${lines.join('\n\n')}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// create_policy
server.tool(
  'create_policy',
  'Create a new access policy. Policies control what actions are allowed or denied on resources in the organization.',
  {
    name:        z.string().describe('Name for the policy (e.g. "Read-only memory access")'),
    description: z.string().optional().describe('Description of what this policy allows or denies'),
    rules:       z.record(z.unknown()).optional().describe('Policy rules as a JSON object (structure depends on backend policy engine)'),
  },
  async ({ name, description, rules }) => {
    try {
      const policy = await createPolicy({ name, description, rules })
      return {
        content: [{ type: 'text', text: `Policy created: "${policy.name ?? name}" (id: ${policy.id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// delete_policy
server.tool(
  'delete_policy',
  'Delete a policy permanently. Requires confirm: true. There is no undo.',
  {
    id:      z.string().describe('ID of the policy to delete (returned by list_policies)'),
    confirm: z.boolean().describe('Must be true to perform the deletion. Without this, the tool refuses.'),
  },
  async ({ id, confirm }) => {
    if (confirm !== true) {
      return {
        content: [{
          type: 'text',
          text: 'Refused: delete_policy requires confirm: true. No HTTP request was made.',
        }],
        isError: true,
      }
    }
    try {
      await deletePolicy(id)
      return {
        content: [{ type: 'text', text: `Policy deleted (id: ${id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// update_policy
server.tool(
  'update_policy',
  'Update an existing access policy: change its name, description, or rules.',
  {
    id:          z.string().describe('ID of the policy to update (returned by list_policies)'),
    name:        z.string().optional().describe('New name for the policy'),
    description: z.string().optional().describe('New description for the policy'),
    rules:       z.record(z.unknown()).optional().describe('New policy rules as a JSON object'),
  },
  async ({ id, name, description, rules }) => {
    try {
      const policy = await updatePolicy(id, { name, description, rules })
      return {
        content: [{ type: 'text', text: `Policy updated: "${policy.name ?? name ?? id}" (id: ${policy.id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Collections (create / delete) ─────────────────────────────────────────────

// create_collection
server.tool(
  'create_collection',
  'Create a new memory collection. Collections group related memories together for filtered search and context retrieval.',
  {
    name:        z.string().describe('Name for the collection (e.g. "Architecture decisions", "Onboarding materials")'),
    description: z.string().optional().describe('Optional description of what this collection contains'),
  },
  async ({ name, description }) => {
    try {
      const collection = await createCollection({ name, description })
      return {
        content: [{ type: 'text', text: `Collection created: "${collection.name}" (id: ${collection.id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// update_collection
server.tool(
  'update_collection',
  'Update a collection name or description. Use list_collections to find collection IDs.',
  {
    id:          z.string().describe('ID of the collection to update (returned by list_collections)'),
    name:        z.string().optional().describe('New name for the collection'),
    description: z.string().optional().describe('New description for the collection'),
  },
  async ({ id, name, description }) => {
    try {
      const collection = await updateCollection(id, { name, description })
      return {
        content: [{ type: 'text', text: `Collection updated: "${collection.name}" (id: ${collection.id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// delete_collection
server.tool(
  'delete_collection',
  'Delete a collection permanently. Requires confirm: true. Memories in the collection are NOT deleted — they are unlinked from the collection. There is no undo.',
  {
    id:      z.string().describe('ID of the collection to delete (returned by list_collections)'),
    confirm: z.boolean().describe('Must be true to perform the deletion. Without this, the tool refuses.'),
  },
  async ({ id, confirm }) => {
    if (confirm !== true) {
      return {
        content: [{
          type: 'text',
          text: 'Refused: delete_collection requires confirm: true. No HTTP request was made.',
        }],
        isError: true,
      }
    }
    try {
      await deleteCollection(id)
      return {
        content: [{ type: 'text', text: `Collection deleted (id: ${id})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Agent Sync ───────────────────────────────────────────────────────────────

// sync_agent_context
server.tool(
  'sync_agent_context',
  'Save the current agent session context to NexusMind as reusable memories — use at the end of a session or after important discoveries.',
  {
    discoveries: z.array(z.object({
      title: z.string().describe('Short title for this discovery/decision'),
      content: z.string().describe('Full content of what was learned'),
      tags: z.array(z.string()).optional().describe('Tags to categorize this memory'),
    })).describe('Discoveries, decisions, or insights to persist'),
    session_summary: z.string().optional().describe('High-level summary of the work session'),
    project_context: z.string().optional().describe('Project name or context identifier'),
  },
  async (input) => {
    const results: string[] = []

    for (const discovery of input.discoveries) {
      try {
        const memory = await storeMemory({
          content: discovery.content,
          title: discovery.title,
          tags: [...(discovery.tags ?? []), 'agent-sync'],
          tool: 'agent-sync',
          ...(input.project_context ? { project: input.project_context } : {}),
        })
        results.push(`✓ Saved: "${discovery.title}" (id: ${memory.id})`)
      } catch (e: any) {
        results.push(`✗ Failed: "${discovery.title}" — ${e.message}`)
      }
    }

    if (input.session_summary) {
      try {
        const memory = await storeMemory({
          content: input.session_summary,
          title: `Session summary${input.project_context ? ` — ${input.project_context}` : ''}`,
          tags: ['agent-sync', 'session-summary'],
          tool: 'agent-sync',
          ...(input.project_context ? { project: input.project_context } : {}),
        })
        results.push(`✓ Saved session summary (id: ${memory.id})`)
      } catch (e: any) {
        results.push(`✗ Failed to save session summary — ${e.message}`)
      }
    }

    const saved = results.filter(r => r.startsWith('✓')).length
    return {
      content: [{
        type: 'text',
        text: [
          `## Sync complete — ${saved}/${results.length} saved`,
          '',
          ...results,
        ].join('\n'),
      }],
    }
  }
)

// ── Admin Memory Schedule Delete ─────────────────────────────────────────────

// schedule_memory_delete
server.tool(
  'schedule_memory_delete',
  'Schedule a memory for future deletion. The memory will be soft-deleted at the specified date.',
  {
    memory_id: z.string().describe('Memory ID to schedule for deletion'),
    delete_at: z.string().describe('ISO 8601 date string for when to delete (e.g. 2025-12-31T00:00:00Z)'),
  },
  async (input) => {
    try {
      await scheduleMemoryDelete(input.memory_id, input.delete_at)
      return {
        content: [{ type: 'text', text: `Memory ${input.memory_id} scheduled for deletion at ${input.delete_at}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Code Project Reindex ──────────────────────────────────────────────────────

// reindex_project
server.tool(
  'reindex_project',
  'Trigger a manual reindex of a code project to update the search index with latest file changes.',
  {
    project_id: z.string().describe('Code project ID to reindex'),
  },
  async (input) => {
    try {
      await reindexProject(input.project_id)
      return {
        content: [{ type: 'text', text: `Reindex triggered for project ${input.project_id}` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Harnesses (read-only, Phase 1) ───────────────────────────────────────────
//
// Thin permissioned wrappers over already-shipped backend harness endpoints.
// `harness:read` is enforced backend-side on the Bearer token; these tools add
// no client-side authority and never fetch manifest content/downloads — only
// metadata and (for get_harness_version) a preview summary.

const harnessTargetEnum = z.enum(['claude', 'codex', 'cursor'])

function formatHarness(h: Harness): string {
  const targets = h.targets && h.targets.length > 0 ? ` [${h.targets.join(', ')}]` : ''
  const owner = h.owner_user_id ? ` (owner: ${h.owner_user_id})` : ''
  const version = h.latest_version ? ` v${h.latest_version}` : ''
  return `• ${h.slug}${version} — ${h.name}${targets}${owner} (id: ${h.id})`
}

function formatHarnessRecommendation(r: HarnessRecommendation): string {
  const approval = r.approval_required ? ' [requires approval]' : ''
  const warning = r.warning_metadata?.executable ? ' [executable]' : ''
  return `• ${r.harness_id} v${r.version} — ${r.name} [${r.format}] targets: ${r.targets.join(', ')}${approval}${warning}`
}

function formatHarnessVersion(v: HarnessVersion): string {
  const componentCount = v.components?.length ?? 0
  const lines = [
    `Harness ${v.harness_id} version ${v.version}`,
    `Format: ${v.format}`,
    `Targets: ${v.targets.join(', ')}`,
    `Manifest hash: ${v.manifest_hash}`,
    `Components: ${componentCount}`,
  ]
  if (v.security?.executable) lines.push('Warning: contains an executable component')
  if (v.security?.requires_approval) lines.push('Requires approval before install')
  return lines.join('\n')
}

function formatHarnessConfigReview(r: HarnessConfigReview): string {
  return `• ${r.id} — source: ${r.source_tool}, status: ${r.status}${r.created_at ? ` (${new Date(r.created_at).toLocaleDateString()})` : ''}`
}

// recommend_harnesses
server.tool(
  'recommend_harnesses',
  'List recommended harnesses for a given agent target (claude, codex, cursor). Returns metadata only (id, version, name, targets, format, approval/warning flags) — never downloads or returns manifest content.',
  {
    target: harnessTargetEnum.optional().describe('Filter recommendations to a specific tool target'),
  },
  async ({ target }) => {
    try {
      const recommendations = await recommendHarnesses({ target })
      if (recommendations.length === 0) {
        return { content: [{ type: 'text', text: 'No harness recommendations found.' }] }
      }
      const text = recommendations.map(formatHarnessRecommendation).join('\n')
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// list_harnesses
server.tool(
  'list_harnesses',
  'List harnesses visible to the caller, optionally filtered by target tool or owner. Returns catalog metadata only — no manifest content.',
  {
    target:        harnessTargetEnum.optional().describe('Filter by tool target'),
    owner_user_id: z.string().optional().describe('Filter by owner user ID'),
  },
  async ({ target, owner_user_id }) => {
    try {
      const harnesses = await listHarnesses({ target, owner_user_id })
      if (harnesses.length === 0) {
        return { content: [{ type: 'text', text: 'No harnesses found.' }] }
      }
      const text = harnesses.map(formatHarness).join('\n')
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_harness_version
server.tool(
  'get_harness_version',
  'Preview a specific harness version: format, targets, manifest hash, and component summary. Uses the preview endpoint — readable without a prior install approval. Does not write any local file and does not expose raw component content.',
  {
    harness_id: z.string().describe('Harness ID'),
    version:    z.string().describe('Version string, e.g. "1.0.0"'),
  },
  async ({ harness_id, version }) => {
    try {
      const harnessVersion = await getHarnessVersion(harness_id, version)
      return { content: [{ type: 'text', text: formatHarnessVersion(harnessVersion) }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// list_harness_config_reviews
server.tool(
  'list_harness_config_reviews',
  'List shared harness config reviews (redacted snapshots only), optionally filtered by status. Requires harness:read; denied calls return no config review data.',
  {
    status: z.string().optional().describe('Filter by review status (e.g. "pending", "approved")'),
  },
  async ({ status }) => {
    try {
      const reviews = await listHarnessConfigReviews({ status })
      if (reviews.length === 0) {
        return { content: [{ type: 'text', text: 'No harness config reviews found.' }] }
      }
      const text = reviews.map(formatHarnessConfigReview).join('\n')
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Harness install core (Phase 2) ───────────────────────────────────────────
//
// Two-phase installer (design.md §1): `plan_harness_install` computes a diff
// and writes NOTHING (it only ever imports `harness/plan.js`, which never
// imports the materializer). `apply_harness_install` is the single path that
// writes to disk, and only after: (1) a `manifest_hash` from a prior plan the
// user reviewed, (2) a fresh backend approval keyed on that hash, and (3) a
// hash-drift check that re-refuses if the manifest changed between plan and
// apply. Neither tool grants authority beyond the backend's `harness:*`
// permissions — every write still requires the backend-persisted approval.

const harnessScopeEnum = z.enum(['user', 'project'])

// apply_harness_install tool output shapes (design.md §1 "apply_harness_install" Output).
interface AppliedWritten { destination: string; action: 'create' | 'overwrite'; size_bytes: number }
interface AppliedSkipped { destination: string; reason: 'unchanged' }
interface AppliedError { destination: string; message: string }

// plan_harness_install
server.tool(
  'plan_harness_install',
  'Plan installing a harness version for a given agent tool (claude, codex, cursor) and scope (user, project). Downloads the manifest preview, resolves per-tool destinations, and returns a full diff (create/overwrite/skip per file) plus executable warnings. Writes NOTHING to disk — this is a read-only preview for the user to review before apply_harness_install.',
  {
    harness_id:   z.string().describe('Harness ID'),
    version:      z.string().describe('Version string, e.g. "1.0.0"'),
    target_tool:  harnessTargetEnum.describe('Agent tool to plan the install for'),
    target_scope: harnessScopeEnum.default('project').describe('Install scope: "user" (tool home dir) or "project" (repo-local dir under cwd)'),
  },
  async ({ harness_id, version, target_tool, target_scope }) => {
    try {
      const preview = await getHarnessVersion(harness_id, version)
      const manifest = (preview as any).manifest ?? preview
      const manifestHash = preview.manifest_hash

      const planResult = await planInstall(manifest, target_tool, target_scope, { projectRoot: process.cwd() })

      const output = {
        harness_id,
        version,
        target_tool,
        target_scope,
        manifest_hash: manifestHash,
        format: planResult.format,
        requires_acknowledgement: planResult.requires_acknowledgement,
        warnings: planResult.warnings,
        diff: planResult.diff.map(d => ({
          destination: d.destination,
          relative_path: d.relative_path,
          action: d.action,
          sha256: d.sha256,
          existing_sha256: d.existing_sha256,
          size_bytes: d.size_bytes,
          executable: d.executable,
          warning: d.warning,
        })),
      }

      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// apply_harness_install
server.tool(
  'apply_harness_install',
  'Apply a previously planned harness install. Requires the manifest_hash returned by plan_harness_install as explicit confirmation of a reviewed diff. Records approve_install (refusing executable hook/plugin manifests without warning_acknowledged), re-downloads the manifest and aborts with hash_mismatch if it drifted since planning, materializes files to their resolved destinations, and calls record_install_result. Never writes without a prior plan_harness_install manifest_hash.',
  {
    harness_id:            z.string().describe('Harness ID'),
    version:               z.string().describe('Version string, e.g. "1.0.0"'),
    target_tool:           harnessTargetEnum.describe('Agent tool to install for'),
    target_scope:          harnessScopeEnum.default('project').describe('Install scope: "user" or "project"'),
    manifest_hash:         z.string().describe('manifest_hash from a prior plan_harness_install call — required confirmation that the user reviewed that diff'),
    warning_acknowledged:  z.boolean().optional().describe('Required when the plan reported requires_acknowledgement: true (hook / claude_code_plugin formats)'),
    overwrite_confirmed:   z.boolean().optional().describe('Required when any diff entry action is "overwrite"'),
  },
  async ({ harness_id, version, target_tool, target_scope, manifest_hash, warning_acknowledged, overwrite_confirmed }) => {
    try {
      // Step 1: record approve_install with the manifest hash from plan (+ ack metadata).
      // The backend rejects executable formats without warning_acknowledged=true.
      const approval = await approveHarnessInstall(harness_id, version, {
        target_tool,
        target_scope,
        manifest_hash,
        metadata: { warning_acknowledged: warning_acknowledged === true, overwrite_confirmed: overwrite_confirmed === true },
      })

      // Step 2: the approval-gated download now succeeds; it returns the manifest + a
      // freshly computed manifest_hash.
      const download = await downloadHarnessVersion(harness_id, version)

      // Step 3: hash-mismatch / re-approval gate — if the manifest drifted between plan
      // and apply, abort the write entirely and instruct the caller to re-plan.
      if (download.manifest_hash !== manifest_hash) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              approval_id: approval.approval_id,
              manifest_hash: download.manifest_hash,
              result_status: 'hash_mismatch',
              written: [],
              skipped: [],
              errors: [{
                destination: '',
                message: `manifest_hash drifted since plan (planned "${manifest_hash}", now "${download.manifest_hash}") — re-run plan_harness_install and re-confirm before retrying`,
              }],
            }, null, 2),
          }],
        }
      }

      // Step 4: materialize files via the ONLY write module in this feature.
      const projectRoot = process.cwd()
      const planResult = await planInstall(download.manifest, target_tool, target_scope, { projectRoot })

      // Step 4a: overwrite gate — refuse the WHOLE apply (no writes at all,
      // not even co-occurring "create" entries) when any diff entry would
      // overwrite an existing file and the caller has not passed
      // overwrite_confirmed: true. This is additional to (does not replace)
      // the warning_acknowledged gate above and the hash-mismatch gate.
      const hasOverwrite = planResult.diff.some(d => d.action === 'overwrite')
      if (hasOverwrite && overwrite_confirmed !== true) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              approval_id: approval.approval_id,
              manifest_hash: download.manifest_hash,
              result_status: 'overwrite_not_confirmed',
              written: [],
              skipped: [],
              errors: [{
                destination: '',
                message: 'this install would overwrite one or more existing files — re-run apply_harness_install with overwrite_confirmed: true to proceed',
              }],
            }, null, 2),
          }],
        }
      }

      const root = resolveDestinationRoot(target_tool, target_scope, projectRoot)
      const applyResult = await applyPlan(planResult.diff, { root })

      const resultStatus: 'installed' | 'failed' = applyResult.errors.length > 0 ? 'failed' : 'installed'

      // Step 5: record the outcome — never raw file contents, only status + metadata.
      await recordHarnessInstallResult(harness_id, version, {
        approval_id: approval.approval_id,
        manifest_hash: download.manifest_hash,
        status: resultStatus,
        metadata: { changed_files_count: applyResult.written.length },
      })

      const written: AppliedWritten[] = applyResult.written
      const skipped: AppliedSkipped[] = applyResult.skipped
      const errors: AppliedError[] = applyResult.errors

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            approval_id: approval.approval_id,
            manifest_hash: download.manifest_hash,
            result_status: resultStatus,
            written,
            skipped,
            errors: errors.length > 0 ? errors : undefined,
          }, null, 2),
        }],
        isError: resultStatus === 'failed',
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Harness create/upload (Phase 3) ──────────────────────────────────────────
//
// build_harness_manifest_from_path reads local files, sha256-hashes and
// inlines content (<=64KiB per component), runs the local secret scanner,
// and REFUSES on any hit — no manifest is returned, and the refusal message
// never contains a matched secret value (design.md §6). create_harness and
// publish_harness_version are thin wrappers over the corresponding
// harness:write-gated backend endpoints; they add no client-side authority.

const harnessFormatEnum = z.enum([
  'agent', 'skill', 'command', 'hook', 'output_style', 'claude_code_plugin', 'theme',
])

// build_harness_manifest_from_path
server.tool(
  'build_harness_manifest_from_path',
  'Build a schema-1.1 harness manifest from local files at the given path. Computes sha256 + size per component, inlines content up to 64KiB per component (refuses larger files, never truncates), and runs a local secret scan that REFUSES the entire build on any hit (never inlines or hashes offending content). Does not upload anything — pass the returned manifest to publish_harness_version.',
  {
    path:    z.string().describe('Local file or directory path to package'),
    format:  harnessFormatEnum.describe('Harness format template to assemble the manifest against'),
    targets: z.array(harnessTargetEnum).min(1).describe('Agent tools this harness targets (claude, codex, cursor)'),
    source:  z.string().describe('Provenance source label recorded in manifest.provenance.source'),
  },
  async ({ path, format, targets, source }) => {
    try {
      const result = await buildManifestFromPath(path, format as HarnessFormat, targets as HarnessTarget[], source)
      if (result.refused) {
        return {
          content: [{ type: 'text', text: `Refused: ${result.reason}` }],
          isError: true,
        }
      }
      const manifest = result.manifest!
      const output = {
        manifest,
        secret_scan_status: 'passed' as const,
        component_count: manifest.components.length,
      }
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// create_harness
server.tool(
  'create_harness',
  'Create a new harness. Thin wrapper over the harness:write-gated backend endpoint — adds no authority beyond that permission.',
  {
    slug:          z.string().describe('Unique harness slug'),
    name:          z.string().describe('Display name'),
    description:   z.string().optional().describe('Optional description'),
    project_id:    z.string().optional().describe('Optional project ID to associate the harness with'),
    visibility:    z.string().optional().describe('Optional visibility setting (e.g. "org", "private")'),
    owner_user_id: z.string().optional().describe('Optional owner user ID'),
  },
  async ({ slug, name, description, project_id, visibility, owner_user_id }) => {
    try {
      const harness = await createHarness({ slug, name, description, project_id, visibility, owner_user_id })
      return { content: [{ type: 'text', text: JSON.stringify(harness, null, 2) }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// publish_harness_version
server.tool(
  'publish_harness_version',
  'Publish an immutable harness version from a manifest (typically produced by build_harness_manifest_from_path). Thin wrapper over the harness:write-gated backend endpoint — adds no authority beyond that permission.',
  {
    harness_id:    z.string().describe('Harness ID to publish a version under'),
    version:       z.string().describe('Version string, e.g. "1.0.0"'),
    manifest:      z.record(z.any()).describe('Schema-1.1 manifest object, e.g. from build_harness_manifest_from_path'),
    manifest_hash: z.string().optional().describe('Optional pre-computed manifest hash'),
  },
  async ({ harness_id, version, manifest, manifest_hash }) => {
    try {
      const published = await publishHarnessVersion(harness_id, { version, manifest, manifest_hash })
      return { content: [{ type: 'text', text: JSON.stringify(published, null, 2) }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Harness config review (Phase 4, optional) ────────────────────────────────
//
// create_harness_config_review performs LOCAL redaction of the config at
// config_path (reusing harness/secret-scan.ts categories) BEFORE uploading —
// the redaction and preview MUST happen locally, per the harness-config-review
// spec ("Agent-session config review requires local preview before upload").
// The backend still enforces raw-content rejection independently as a second
// gate; this tool does not bypass that.

server.tool(
  'create_harness_config_review',
  'Create a harness config review from a local config file: redacts secret-shaped values locally (never uploads raw content), then submits the redacted snapshot, redaction report, and content hash for review. Requires harness:write; the backend independently re-enforces raw-content rejection.',
  {
    source_tool: harnessTargetEnum.describe('The tool the config snapshot originates from'),
    config_path: z.string().describe('Local path to the config file to redact and preview'),
  },
  async ({ source_tool, config_path }) => {
    try {
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(config_path, 'utf8')
      let parsedConfig: unknown
      try {
        parsedConfig = JSON.parse(raw)
      } catch {
        parsedConfig = raw
      }

      const { redacted_config, redaction_report, content_hash } = redactConfigForReview(parsedConfig, config_path)

      const review = await createHarnessConfigReview({
        source_tool,
        redacted_config,
        redaction_report,
        content_hash,
        status: 'pending',
      })

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ review, redacted_config, redaction_report, content_hash }, null, 2),
        }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
