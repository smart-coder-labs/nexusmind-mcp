#!/usr/bin/env node
if (process.argv[2] === 'setup') {
  await import('./setup.js')
  process.exit(0)
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { storeMemory, searchMemories, listMemories, getMemoryById, deleteMemory } from './client.js'
import type { Memory } from './client.js'

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
    content:   z.string().describe('Full memory content (decision rationale, bug root cause, discovery, etc.)'),
    title:     z.string().optional().describe('Short searchable title (e.g. "Fixed N+1 query in UserList")'),
    type:      typeEnum,
    topic_key: z.string().optional().describe('Stable key for upsertable topics — same key updates the existing memory (e.g. "architecture/auth-model")'),
    scope:     z.enum(['project', 'personal']).optional().describe('project (team-shared, default) or personal (cross-project)'),
    project:   z.string().optional().describe('Project or repo name (e.g. "nexusmind", "payments-api")'),
    tool:      z.string().optional().describe('Tool name — defaults to "claude-code"'),
    tags:      z.array(z.string()).optional().describe('Tags for filtering (e.g. ["auth", "convention"])'),
    session_id: z.string().optional().describe('Session ID to link this memory to a session'),
  },
  async ({ content, title, type, topic_key, scope, project, tool, tags, session_id }) => {
    try {
      const res = await storeMemory({ content, title, type, topic_key, scope, project, tool, tags, session_id })
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

// search_memory
server.tool(
  'search_memory',
  "Call BEFORE starting any work that might have been done before. This is your FIRST action when a user's message references a project, feature, bug, or module you don't already have context on. If unsure whether to search — search. Pass keywords from the user's message as query.",
  {
    query: z.string().describe('What to search for (e.g. "authentication", "database connection pool")'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default: 10)'),
  },
  async ({ query, limit }) => {
    try {
      const memories = await searchMemories(query, limit ?? 10)
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

// get_context — returns team memories formatted as a context block for Cursor
// rules, notepads, or any tool that injects context at session start.
server.tool(
  'get_context',
  'Call at the START of every session that involves significant work. Returns all team knowledge grouped by type — architecture, decisions, patterns, bugs fixed, discoveries. This is the canonical bootstrap for nexus-mind work; do not skip it on substantial sessions.',
  {
    project: z.string().optional().describe('Project to fetch context for. Omit for all projects.'),
    limit:   z.number().int().min(1).max(100).optional().describe('Max memories to include (default: 40)'),
  },
  async ({ project, limit }) => {
    try {
      const memories = await listMemories({ project, limit: limit ?? 40 })

      if (memories.length === 0) {
        return { content: [{ type: 'text', text: 'No team context found.' }] }
      }

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

      const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      const projectLabel = project ? ` — ${project}` : ''

      const lines: string[] = [
        `## NexusMind Team Context${projectLabel}`,
        `> Last updated: ${date} · ${memories.length} memories`,
        '',
      ]

      for (const key of sortedKeys) {
        const label = TYPE_LABELS[key] ?? key
        lines.push(`### ${label}`)
        for (const m of groups[key]) {
          const entry = m.title ?? m.content.split('\n')[0].slice(0, 120)
          lines.push(`- ${entry}`)
        }
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

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
