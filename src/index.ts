#!/usr/bin/env node
if (process.argv[2] === 'setup') {
  await import('./setup.js')
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
import { storeMemory, searchMemories, listMemories, getMemoryById, deleteMemory, updateMemory, archiveMemory, restoreMemory, pinMemory, unpinMemory, indexProject, searchCode, getSymbolContext, globalSearch, listCodeProjects, getCodeProjectFiles, deleteCodeProject, bulkDeleteMemories, mergeMemoryPair, bulkTagMemoriesSingle, listCollections, assignMemoryToCollection, listConventions, getConvention, storeConvention, updateConvention, archiveConvention, restoreConvention, deleteConvention, getProjectContext, checkPolicy, listProjects, createProject, updateProject, getProjectMembers, addProjectMember, listUsers, inviteUser, disableUser, enableUser, listRoles, assignUserRole, getUsersByRole, listWebhooks, createWebhook, deleteWebhook, testWebhook, listOrgKeys, revokeApiKey, getAuditLog, getOrgSettings, updateOrgSettings, getStats, getAgentActivity, getTagStats, importMemories, findDuplicateMemories, getMemoryTrends, updateOrg, renameTag, setAnnouncement, exportMemories, getMemoryFacets, getUsageStats, updateSession, listSessions, deleteSession, getSessionMemories, createSession, getMemoryTimeline, pinConvention } from './client.js'
import type { Memory, CodeSearchResult, CodeChunk, Session } from './client.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatMemory(m: Memory): string {
  const date = new Date(m.created_at).toLocaleDateString()
  const type = m.type ? `${m.type} ` : ''
  const tags = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : ''
  const rev  = m.revision_count > 1 ? ` (rev ${m.revision_count})` : ''
  return `• [${type}${m.tool}] ${m.project || '(no project)'} — ${m.title ?? m.content}${tags}${rev} (${date})`
}

function formatList(memories: Memory[]): string {
  if (memories.length === 0) return 'No memories found.'
  return memories.map(formatMemory).join('\n')
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

const typeEnum = z.enum(MEMORY_TYPES).optional().describe(
  'Memory type — architecture | bugfix | decision | discovery | config | pattern | feedback | preference | project | session_summary | feature | refactoring | manual'
)

// store_memory
server.tool(
  'store_memory',
  'ALWAYS call immediately after ANY decision, bug fix, convention, or non-obvious discovery — do NOT wait to be asked. Mandatory in practice: title (verb + what), type (architecture | bugfix | decision | discovery | config | pattern | feedback | preference | project | session_summary | feature | refactoring | manual), and project. Call this BEFORE moving to the next task.',
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
  },
  async ({ content, title, type, topic_key, scope, project, tool, tags, session_id, collection_id }) => {
    try {
      const res = await storeMemory({ content, title, type, topic_key, scope, project, tool, tags, session_id, collection_id })
      const label = title ? `"${title}"` : `id: ${res.id}`
      return {
        content: [{ type: 'text', text: `Memory stored (${label})` }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// smart_store_memory
server.tool(
  'smart_store_memory',
  'Store a memory with automatic type detection and tagging. Analyzes the content to suggest tags (bugfix, decision, feature, discovery, etc.) before storing.',
  {
    content:    z.string().describe('Full memory content to classify and store'),
    project:    z.string().optional().describe('Project or repo name (e.g. "nexusmind", "payments-api")'),
    session_id: z.string().optional().describe('Session ID to link this memory to a session'),
    extra_tags: z.array(z.string()).optional().describe('Additional tags to include alongside auto-detected ones'),
  },
  async ({ content, project, session_id, extra_tags }) => {
    try {
      const lower = content.toLowerCase()
      const autoTags: string[] = []

      if (/fix(ed|ing)?|bug|error|crash|broken|resolv/i.test(lower)) autoTags.push('bugfix')
      if (/decid(ed|ing)?|chose|option|alternative|tradeoff|because/i.test(lower)) autoTags.push('decision')
      if (/add(ed|ing)?|implement(ed|ing)?|built|creat(ed|ing)?|new feature/i.test(lower)) autoTags.push('feature')
      if (/found|discover(ed|y)?|learn(ed|ing)?|realized|turns out|gotcha|note:/i.test(lower)) autoTags.push('discovery')
      if (/refactor(ed|ing)?|moved|reorganiz(ed|ing)?|renamed|extract(ed|ing)?/i.test(lower)) autoTags.push('refactor')
      if (/test(ed|ing)?|spec|coverage|unit|integration/i.test(lower)) autoTags.push('testing')

      const allTags = [...new Set([...autoTags, ...(extra_tags ?? [])])]

      const result = await storeMemory({
        content,
        tags: allTags,
        ...(project    ? { project }    : {}),
        ...(session_id ? { session_id } : {}),
      })

      return {
        content: [{
          type: 'text',
          text: `Memory stored (id: ${result?.id})\nAuto-detected tags: [${autoTags.join(', ') || 'none'}]\nAll tags: [${allTags.join(', ')}]`,
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

// search_memory
server.tool(
  'search_memory',
  "Call BEFORE starting any work that might have been done before. This is your FIRST action when a user's message references a project, feature, bug, or module you don't already have context on. If unsure whether to search — search. Pass keywords from the user's message as query.",
  {
    query:         z.string().describe('What to search for (e.g. "authentication", "database connection pool")'),
    limit:         z.number().int().min(1).max(50).optional().describe('Max results to return (default: 10)'),
    collection_id: z.string().optional().describe('Filter results to a specific collection ID'),
    pinned:        z.boolean().optional().describe('When true, return only pinned memories'),
    archived:      z.boolean().optional().describe('When true, include archived memories in results (default: false)'),
  },
  async ({ query, limit, collection_id, pinned, archived }) => {
    try {
      const memories = await searchMemories({ query, limit: limit ?? 10, collection_id, pinned, archived })
      const text = memories.length === 0
        ? `No memories found for query: "${query}"`
        : `Found ${memories.length} result(s) for "${query}":\n\n${formatList(memories)}`
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// search_memories_advanced
server.tool(
  'search_memories_advanced',
  'Advanced memory search with date range, tag matching mode (any/all), project filter, and pinned filter. More powerful than search_memory.',
  {
    query:            z.string().optional().describe('Search query (e.g. "authentication", "database pool")'),
    tags:             z.array(z.string()).optional().describe('Filter by tags'),
    tag_mode:         z.enum(['any', 'all']).optional().describe('Tag matching mode — "any" (default) or "all" (all tags must be present)'),
    project:          z.string().optional().describe('Filter by project name'),
    since:            z.string().optional().describe('ISO date — only memories created on or after this date (e.g. "2025-01-01")'),
    until:            z.string().optional().describe('ISO date — only memories created on or before this date (e.g. "2025-12-31")'),
    pinned:           z.boolean().optional().describe('When true, return only pinned memories'),
    limit:            z.number().int().min(1).max(100).optional().describe('Max results to return (default: 20)'),
    include_archived: z.boolean().optional().describe('When true, include archived memories in results (default: false)'),
  },
  async (input) => {
    try {
      const results = await searchMemories({
        query: input.query ?? '',
        limit: input.limit ?? 20,
        pinned: input.pinned,
        archived: input.include_archived,
      })

      let filtered = results ?? []

      // Date filter
      if (input.since) filtered = filtered.filter((m: any) => m.created_at >= input.since!)
      if (input.until) filtered = filtered.filter((m: any) => m.created_at <= input.until! + 'T23:59:59')

      // Project filter
      if (input.project) filtered = filtered.filter((m: any) => m.project === input.project)

      // Tag mode 'all' — ALL specified tags must be present
      if (input.tags?.length && input.tag_mode === 'all') {
        filtered = filtered.filter((m: any) =>
          input.tags!.every(t => m.tags?.includes(t))
        )
      }

      const text = filtered.map((m: any) =>
        `[${m.id}] ${m.content.slice(0, 150)}… (tags: ${m.tags?.join(', ') || 'none'}, created: ${m.created_at?.slice(0, 10)})`
      ).join('\n') || 'No memories found'

      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// list_memories
server.tool(
  'list_memories',
  'Utility browse for recent memories, optionally filtered by project, type, or scope. Prefer search_memory when you have keywords. Use list_memories only when exploring the project or auditing recent activity.',
  {
    project: z.string().optional().describe('Filter by project name'),
    type:    typeEnum,
    scope:   z.enum(['project', 'personal']).optional().describe('Filter by scope'),
    tool:    z.string().optional().describe('Filter by tool (e.g. "claude-code", "cursor")'),
    limit:   z.number().int().min(1).max(100).optional().describe('Max results (default: 20)'),
  },
  async ({ project, type, scope, tool, limit }) => {
    try {
      const memories = await listMemories({ project, type, scope, tool, limit: limit ?? 20 })
      const text = memories.length === 0
        ? 'No memories found.'
        : `${memories.length} recent memory(ies):\n\n${formatList(memories)}`
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_context — returns team conventions + memories formatted as a context block for Cursor
// rules, notepads, or any tool that injects context at session start.
server.tool(
  'get_context',
  'Call at the START of every session that involves significant work. Returns all team knowledge grouped by type — architecture, decisions, patterns, bugs fixed, discoveries. Also returns conventions from GET /v1/conventions — these are team-wide rules with higher authority than memories. This is the canonical bootstrap for nexus-mind work; do not skip it on substantial sessions.',
  {
    project:              z.string().optional().describe('Project to fetch context for. Omit for all projects.'),
    limit:                z.number().int().min(1).max(100).optional().describe('Max memories to include (default: 40)'),
    include_conventions:  z.boolean().optional().describe('Include team conventions in the output (default: true)'),
    include_memories:     z.boolean().optional().describe('Include memories in the output (default: true)'),
  },
  async ({ project, limit, include_conventions, include_memories }) => {
    try {
      const wantConventions = include_conventions !== false
      const wantMemories    = include_memories    !== false

      const [memories, conventions] = await Promise.all([
        wantMemories    ? listMemories({ project, limit: limit ?? 40 }) : Promise.resolve([]),
        wantConventions ? listConventions() : Promise.resolve([]),
      ])

      if (memories.length === 0 && conventions.length === 0) {
        return { content: [{ type: 'text', text: 'No team context found.' }] }
      }

      const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      const projectLabel = project ? ` — ${project}` : ''

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

      return { content: [{ type: 'text', text: lines.join('\n') }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// get_conventions_summary
server.tool(
  'get_conventions_summary',
  'Get a compact summary of all active conventions, optionally filtered by category. Use before any coding task to ensure compliance.',
  {
    category: z.string().optional().describe('Filter by category (e.g. "naming", "architecture", "testing")'),
  },
  async ({ category }) => {
    try {
      const conventions = await listConventions(category)
      if (conventions.length === 0) {
        const filter = category ? ` for category "${category}"` : ''
        return { content: [{ type: 'text', text: `No conventions found${filter}.` }] }
      }
      const lines = conventions.map(c => {
        const weight = (c as any).weight ?? 0
        const title  = c.title ?? `Convention ${c.id}`
        return `[${weight}] ${title}: ${c.content.slice(0, 200)}`
      })
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

// get_memory — full untruncated content by id
server.tool(
  'get_memory',
  'Fetch FULL untruncated content for a single memory by id. search_memory and list_memories return previews (often 120-300 chars); when you need to act on or quote the full record, call get_memory(id). Use the id returned by search_memory.',
  {
    id: z.string().describe('The memory id (returned by search_memory or list_memories)'),
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
  'Call BEFORE any semantic code search on a project that has not been indexed yet, or when code has changed significantly. Walks the project root, chunks source files by symbol, embeds them, and persists to the code index. Takes the absolute path to the project root.',
  {
    project:    z.string().describe('Logical project name used as the search scope key (e.g. "nexusmind-backend")'),
    root_path:  z.string().describe('Absolute path to the project root directory to index'),
    extensions: z.array(z.string()).optional().describe('File extensions to include (e.g. [".ts", ".rs"]). Defaults to common code extensions.'),
  },
  async ({ project, root_path, extensions }) => {
    try {
      const res = await indexProject({ project, root_path, extensions })
      return {
        content: [{
          type: 'text',
          text: `Project "${res.project}" indexed successfully.\nStatus: ${res.status}\nFiles indexed: ${res.file_count}\nChunks created: ${res.chunk_count}`,
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

// search_code
server.tool(
  'search_code',
  'Primary tool for understanding a codebase semantically. Call to find where something is defined, how a pattern is implemented, or what code handles a specific concern — WITHOUT reading files manually. Requires the project to be indexed first via index_project.',
  {
    query:   z.string().describe('Natural language or code description of what to find (e.g. "user authentication logic", "database connection pool setup")'),
    project: z.string().describe('Project key to search within — must match the key used in index_project'),
    limit:   z.number().int().min(1).max(20).optional().describe('Max results to return (default: 10, max: 20)'),
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
  'Search across memories, code, and users simultaneously. Returns grouped results by type. Use when you need a broad cross-resource search rather than targeted memory or code lookup.',
  {
    query: z.string().describe('Search query (e.g. "authentication", "user onboarding")'),
    types: z.array(z.enum(['memories', 'code', 'users'])).optional()
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
    id:       z.string().describe('The memory ID to update (returned by search_memory or list_memories)'),
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

// list_conventions
server.tool(
  'list_conventions',
  'List team conventions stored in NexusMind, optionally filtered by category. Use to discover established patterns, coding standards, or naming rules before starting work.',
  {
    category: z.string().optional().describe('Filter by category (e.g. "naming", "architecture", "testing")'),
    include_archived: z.boolean().optional().describe('Include archived conventions in results (default: false)'),
  },
  async ({ category, include_archived }) => {
    try {
      const conventions = await listConventions(category, include_archived)
      if (conventions.length === 0) {
        const filter = category ? ` for category "${category}"` : ''
        return { content: [{ type: 'text', text: `No conventions found${filter}.` }] }
      }
      const lines = conventions.map((c, i) => {
        const title = c.title ?? `Convention ${c.id}`
        const cat   = c.category ? ` [${c.category}]` : ''
        return `[${i + 1}] ${title}${cat} (id: ${c.id})\n    ${c.content.split('\n')[0].slice(0, 120)}`
      })
      return {
        content: [{ type: 'text', text: `${conventions.length} convention(s):\n\n${lines.join('\n\n')}` }],
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

// get_project_context
server.tool(
  'get_project_context',
  'Get the full context for a project: conventions (team rules with highest priority), recent memories, project settings, and agent activity. Call this at the start of any session to ground yourself in the project\'s rules and history.',
  {
    project: z.string().describe('Project name to fetch context for (e.g. "nexusmind", "payments-api")'),
  },
  async ({ project }) => {
    try {
      const ctx = await getProjectContext(project)
      return {
        content: [{ type: 'text', text: JSON.stringify(ctx, null, 2) }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
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
      return {
        content: [{ type: 'text', text: `Policy check: ${status}\nAction: ${action}\nResource: ${resource}${reasonLine}\n\nFull response:\n${JSON.stringify(result, null, 2)}` }],
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
    id:                  z.string().describe('The project ID to update (returned by list_projects)'),
    description:         z.string().optional().describe('New description for the project'),
    custom_instructions: z.string().optional().describe('Custom AI instructions injected into agent context for this project'),
    retention_days:      z.number().int().min(0).optional().describe('Number of days to retain memories for this project (0 = retain forever)'),
    archived:            z.boolean().optional().describe('Set to true to archive the project, false to restore it'),
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
  'Get memory creation trends over time. Returns daily counts for charting activity.',
  {
    period: z.enum(['7d', '30d', '90d']).optional().describe('Time window: "7d", "30d", or "90d" (default: 30d)'),
  },
  async ({ period }) => {
    try {
      const trends = await getMemoryTrends(period)
      if (trends.length === 0) {
        return { content: [{ type: 'text', text: 'No trend data available.' }] }
      }
      const lines = trends.map(t => `  ${t.date}: ${t.count}`)
      return {
        content: [{ type: 'text', text: `Memory creation trends${period ? ` (${period})` : ''}:\n\n${lines.join('\n')}` }],
      }
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

// rename_tag
server.tool(
  'rename_tag',
  'Rename a tag across all memories in the organization. All memories with old_tag will have it replaced with new_tag.',
  {
    old_tag: z.string().describe('The existing tag name to rename'),
    new_tag: z.string().describe('The new tag name to replace it with'),
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

// merge_tags
server.tool(
  'merge_tags',
  'Merge tag "source" into "target" — all memories tagged with source get retagged to target, and source is removed. Use get_tag_stats to see available tags before merging.',
  {
    source: z.string().describe('The tag to absorb and remove (e.g. "auth")'),
    target: z.string().describe('The tag to merge into — memories from source will carry this tag (e.g. "authentication")'),
  },
  async ({ source, target }) => {
    try {
      // The rename endpoint absorbs source into target (retags all memories and removes source)
      const result = await renameTag(source, target)
      const count = result.updated ?? 0
      return {
        content: [{ type: 'text', text: `Tags merged: "${source}" → "${target}". ${count} memory(ies) retagged. Tag "${source}" has been removed.` }],
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

// search_conventions
server.tool(
  'search_conventions',
  'Search team conventions by content or title, optionally filtered by category. Returns conventions ordered by weight (highest authority first). Use this to find relevant rules before performing any action.',
  {
    query:            z.string().optional().describe('Text to search in convention titles and content'),
    category:         z.string().optional().describe('Filter by category (e.g. "naming", "architecture", "testing")'),
    include_archived: z.boolean().optional().describe('Include archived conventions in results (default: false)'),
  },
  async ({ query, category, include_archived }) => {
    try {
      const conventions = await listConventions(category, include_archived)
      const filtered = query
        ? conventions.filter(c => {
            const q = query.toLowerCase()
            return (
              (c.title ?? '').toLowerCase().includes(q) ||
              c.content.toLowerCase().includes(q)
            )
          })
        : conventions
      if (filtered.length === 0) {
        const parts: string[] = []
        if (query) parts.push(`matching "${query}"`)
        if (category) parts.push(`in category "${category}"`)
        return { content: [{ type: 'text', text: `No conventions found${parts.length ? ' ' + parts.join(' ') : ''}.` }] }
      }
      const lines = filtered.map((c, i) => {
        const title = c.title ?? `Convention ${c.id}`
        const cat   = c.category ? ` [${c.category}]` : ''
        return `[${i + 1}] ${title}${cat} (id: ${c.id})\n    ${c.content.split('\n')[0].slice(0, 120)}`
      })
      return {
        content: [{ type: 'text', text: `${filtered.length} convention(s):\n\n${lines.join('\n\n')}` }],
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
    action: z.string().describe('A description of what the agent is about to do or implement'),
  },
  async ({ action }) => {
    try {
      const conventions = await listConventions()
      const active = conventions
        .filter((c: any) => !c.archived_at)
        .sort((a: any, b: any) => b.weight - a.weight)

      const conventionText = active.map((c: any) =>
        `[${c.category?.toUpperCase() ?? 'GENERAL'} - weight:${c.weight ?? 0}] ${c.title ?? `Convention ${c.id}`}:\n${c.content}`
      ).join('\n\n---\n\n')

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

// get_session_memories
server.tool(
  'get_session_memories',
  'Get all memories that belong to a specific session. Use this to review what was captured during a work session.',
  {
    session_id: z.string().describe('The session ID to retrieve memories for'),
    limit:      z.number().int().min(1).max(200).optional().describe('Max memories to return (default: 50)'),
  },
  async ({ session_id, limit }) => {
    try {
      const memories = await getSessionMemories({ session_id, limit: limit ?? 50 })
      if (memories.length === 0) {
        return { content: [{ type: 'text', text: `No memories found for session ${session_id}.` }] }
      }
      return {
        content: [{ type: 'text', text: `${memories.length} memory(ies) in session ${session_id}:\n\n${formatList(memories)}` }],
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

// memory_health_check
server.tool(
  'memory_health_check',
  'Audit the memory corpus for quality issues: finds duplicates, very short memories (< 50 chars), very old memories (> 90 days), and memories with no tags. Returns a structured report with counts and examples.',
  {},
  async () => {
    try {
      const [memories, duplicates] = await Promise.all([
        listMemories({ limit: 200 }),
        findDuplicateMemories(),
      ])
      const now = Date.now()
      const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000
      const report = {
        total: memories.length,
        issues: {
          duplicates: duplicates?.length ?? 0,
          too_short: memories.filter(m => m.content.length < 50).length,
          no_tags: memories.filter(m => !m.tags || m.tags.length === 0).length,
          stale: memories.filter(m => new Date(m.created_at).getTime() < ninetyDaysAgo).length,
        },
        examples: {
          too_short: memories.filter(m => m.content.length < 50).slice(0, 3).map(m => ({ id: m.id, content: m.content })),
          no_tags: memories.filter(m => !m.tags || m.tags.length === 0).slice(0, 3).map(m => ({ id: m.id, content: m.content.slice(0, 80) })),
        },
      }
      return {
        content: [{ type: 'text', text: `Memory Health Report:\n${JSON.stringify(report, null, 2)}` }],
      }
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

// get_memory_timeline
server.tool(
  'get_memory_timeline',
  'Get memories in chronological order, optionally filtered by date range. Useful for reviewing what was captured during a time period.',
  {
    since: z.string().optional().describe('Start of the date range as an ISO 8601 string (e.g. "2025-01-01T00:00:00Z")'),
    until: z.string().optional().describe('End of the date range as an ISO 8601 string (e.g. "2025-12-31T23:59:59Z")'),
    limit: z.number().int().min(1).max(200).optional().describe('Max memories to return (default: 50)'),
  },
  async ({ since, until, limit }) => {
    try {
      const memories = await getMemoryTimeline({ since, until, limit: limit ?? 50 })
      if (memories.length === 0) {
        const rangeDesc = since || until ? ` in the given date range` : ''
        return { content: [{ type: 'text', text: `No memories found${rangeDesc}.` }] }
      }
      return {
        content: [{ type: 'text', text: `${memories.length} memory(ies) in timeline:\n\n${formatList(memories)}` }],
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
      const label = conv.title ? `"${conv.title}"` : `id: ${conv.id}`
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
  },
  async ({ category, max_weight }) => {
    try {
      const conventions = await listConventions(category, false)
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
  },
  async ({ category, weight }) => {
    try {
      const conventions = await listConventions(category, false)
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

// summarize_project
server.tool(
  'summarize_project',
  'Generate a comprehensive project brief combining conventions, recent memories, and stats. Use at the start of a work session to orient yourself.',
  {
    project:              z.string().describe('Project name to summarize (e.g. "nexusmind", "payments-api")'),
    include_conventions:  z.boolean().optional().describe('Include team conventions in the summary (default: true)'),
    include_stats:        z.boolean().optional().describe('Include organization stats in the summary (default: false)'),
  },
  async ({ project, include_conventions, include_stats }) => {
    try {
      const [context, stats] = await Promise.all([
        getProjectContext(project),
        include_stats ? getStats() : null,
      ])

      const sections: string[] = []

      sections.push(`# Project: ${project}`)
      sections.push(`Generated: ${new Date().toISOString()}`)

      if (include_conventions !== false && context.conventions?.length) {
        sections.push(`\n## Conventions (${context.conventions.length})`)
        context.conventions.forEach((c: any) => {
          sections.push(`### [${c.weight}] ${c.title} (${c.category})`)
          sections.push(c.content)
        })
      }

      if (context.memories?.length) {
        sections.push(`\n## Recent Memories (${context.memories.length})`)
        context.memories.slice(0, 20).forEach((m: any) => {
          sections.push(`- [${m.tags?.join(', ') || 'no tags'}] ${m.content.slice(0, 150)}`)
        })
      }

      if (stats) {
        sections.push(`\n## Stats`)
        sections.push(JSON.stringify(stats, null, 2))
      }

      return {
        content: [{ type: 'text', text: sections.join('\n') }],
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

// Helper: builds the dashboard text (shared between get_agent_dashboard and onboard_agent)
async function buildAgentDashboard(): Promise<string> {
  const [stats, agentActivity, conventions] = await Promise.all([
    getStats(),
    getAgentActivity(),
    listConventions(),
  ])

  const activeConventions = (conventions || [])
    .filter((c: any) => !c.archived_at)
    .sort((a: any, b: any) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, 5)

  const lines = [
    '# Agent Dashboard',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Org Stats',
    `- Total memories: ${stats?.total_memories ?? 'N/A'}`,
    `- Active projects: ${(stats as any)?.active_projects ?? 'N/A'}`,
    `- Active users: ${(stats as any)?.active_users ?? 'N/A'}`,
    '',
    '## Top Active Agents',
    ...(agentActivity?.slice(0, 5) ?? []).map((a: any) =>
      `- ${a.name || a.key_prefix || a.agent || '(unknown)'}: ${a.request_count ?? a.action ?? 'N/A'}`
    ),
    '',
    '## Top Conventions (follow these)',
    ...activeConventions.map((c: any) =>
      `- [${c.category ?? 'general'}/${c.weight ?? 0}] **${c.title ?? `Convention ${c.id}`}**: ${c.content.slice(0, 120)}…`
    ),
  ]
  return lines.join('\n')
}

// get_agent_dashboard
server.tool(
  'get_agent_dashboard',
  'Get a comprehensive orientation summary for an AI agent: org stats, top active agents, recent memories, and active conventions. Call this at the start of a session to orient yourself.',
  {},
  async () => {
    try {
      const text = await buildAgentDashboard()
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
)

// onboard_agent
server.tool(
  'onboard_agent',
  'Complete onboarding for a new AI agent: saves an agent memory, fetches conventions, and returns an orientation brief.',
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

      // 2. Get the agent dashboard
      const dashboard = await buildAgentDashboard()

      return {
        content: [{ type: 'text', text: `Welcome, ${agent_name}!\n\n${dashboard}` }],
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
  'Record an Architecture Decision Record (ADR). Stores a structured decision with context, options, rationale, and consequences. Ideal for capturing important technical choices.',
  {
    title:               z.string().describe('Short title for the decision (e.g. "Use PostgreSQL instead of SQLite")'),
    context:             z.string().describe('Why this decision was needed — the problem or situation that prompted it'),
    options_considered:  z.array(z.string()).min(1).describe('List of options that were evaluated (e.g. ["PostgreSQL", "SQLite", "MongoDB"])'),
    decision:            z.string().describe('What was chosen'),
    rationale:           z.string().describe('Why this option was chosen over the alternatives'),
    consequences:        z.string().optional().describe('What changes, risks, or follow-up work this decision entails'),
    project:             z.string().optional().describe('Project or repo name (e.g. "nexusmind", "payments-api")'),
    tags:                z.array(z.string()).optional().describe('Additional tags for filtering (e.g. ["database", "infrastructure"])'),
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
      const memories = await searchMemories({ query: input.project ?? '', limit: 50 })
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
      const memories = await searchMemories({ query: input.project ?? '', limit: 20 })
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

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
