#!/usr/bin/env node
if (process.argv[2] === 'setup') {
  await import('./setup.js')
  process.exit(0)
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { storeMemory, searchMemories, listMemories } from './client.js'
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
  'Store a memory, decision, or piece of context for later retrieval by the team.',
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
  'Search past memories and decisions stored by the team using full-text search.',
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
  'List recent memories stored by the team, optionally filtered by project, type, or scope.',
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
  'Get team context as a formatted block for Cursor rules or notepads. Fetches recent memories grouped by type — ready to paste into .cursor/rules/ or a Cursor notepad.',
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

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
