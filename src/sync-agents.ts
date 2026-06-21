#!/usr/bin/env node
/**
 * nexusmind-mcp sync-agents
 * Fetches all agents registered in the org and writes .nexusmind-agents.json
 * in the current working directory. Optionally updates CLAUDE.md.
 *
 * Usage:
 *   npx @smart-coder-labs/nexusmind-mcp sync-agents
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const AGENTS_FILE = '.nexusmind-agents.json'
const CLAUDE_MD   = 'CLAUDE.md'

// ── Colors ────────────────────────────────────────────────────────────────────

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  blue:   '\x1b[34m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
}

const success = (msg: string) => console.log(`${c.green}✓${c.reset} ${msg}`)
const info    = (msg: string) => console.log(`${c.blue}›${c.reset} ${msg}`)
const warn    = (msg: string) => console.log(`${c.yellow}⚠${c.reset}  ${msg}`)

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentEntry {
  id: number | string
  name: string
  key_prefix: string
  role: string
}

interface AgentsConfig {
  nexusmind_url: string
  synced_at: string
  agents: AgentEntry[]
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function syncAgents(): Promise<void> {
  const apiUrl = process.env.NEXUSMIND_BASE_URL ?? process.env.NEXUSMIND_API_URL ?? 'http://localhost:8080'
  const apiKey = process.env.NEXUSMIND_API_KEY

  if (!apiKey) {
    console.error(`${c.red}✗${c.reset} Error: NEXUSMIND_API_KEY environment variable is required.`)
    console.error(`  Run: npx @smart-coder-labs/nexusmind-mcp setup`)
    process.exit(1)
  }

  info('Fetching agents from NexusMind...')

  let raw: unknown[]
  try {
    const res = await fetch(`${apiUrl}/v1/admin/keys`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    })

    if (res.status === 401) {
      console.error(`${c.red}✗${c.reset} Invalid API key. Check NEXUSMIND_API_KEY.`)
      process.exit(1)
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
      console.error(`${c.red}✗${c.reset} API error ${res.status}: ${body.error ?? res.statusText}`)
      process.exit(1)
    }

    raw = await res.json() as unknown[]
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // fetch throws TypeError for network errors
    if (msg.includes('fetch') || msg.includes('ECONNREFUSED') || msg.includes('network')) {
      console.error(`${c.red}✗${c.reset} NexusMind backend not reachable at ${apiUrl}. Is it running?`)
    } else {
      console.error(`${c.red}✗${c.reset} Failed to fetch agents: ${msg}`)
    }
    process.exit(1)
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    warn('No agents found in your NexusMind org.')
    console.log(`  Create agents at: ${apiUrl}/agents`)
    return
  }

  // Normalise keys from API shape
  const agents: AgentEntry[] = (raw as Record<string, unknown>[]).map(k => ({
    id:         k['id'] as number | string,
    name:       (k['name'] ?? k['key_prefix'] ?? `Agent ${k['id']}`) as string,
    key_prefix: (k['key_prefix'] ?? String(k['id']).slice(0, 6)) as string,
    role:       (k['role'] ?? 'agent') as string,
  }))

  // Build config
  const config: AgentsConfig = {
    nexusmind_url: apiUrl,
    synced_at: new Date().toISOString(),
    agents,
  }

  // Write .nexusmind-agents.json
  const agentsPath = resolve(process.cwd(), AGENTS_FILE)
  writeFileSync(agentsPath, JSON.stringify(config, null, 2) + '\n')

  success(`Wrote ${AGENTS_FILE} with ${agents.length} agent(s):`)
  for (const a of agents) {
    console.log(`  ${c.dim}•${c.reset} ${c.bold}${a.name}${c.reset} (${a.key_prefix}***) — ${a.role}`)
  }
  console.log('')

  // Update CLAUDE.md if present
  const claudeMdPath = resolve(process.cwd(), CLAUDE_MD)
  if (existsSync(claudeMdPath)) {
    let content = readFileSync(claudeMdPath, 'utf-8')

    const agentLines = agents.map(
      a => `- **${a.name}** (\`${a.key_prefix}***\`) — role: ${a.role}`
    )

    const agentSection = [
      '## NexusMind Agents',
      '',
      'The following AI agents are configured for this project via NexusMind:',
      '',
      ...agentLines,
      '',
      `_Synced from ${apiUrl} on ${new Date().toLocaleDateString()}_`,
    ].join('\n')

    // Replace existing section or append
    // Matches ## NexusMind Agents ... up to the next ## heading or end of file
    const sectionRegex = /^## NexusMind Agents[\s\S]*?(?=^## |\s*$)/m
    if (sectionRegex.test(content)) {
      content = content.replace(sectionRegex, agentSection + '\n\n')
    } else {
      content = content.trimEnd() + '\n\n' + agentSection + '\n'
    }

    writeFileSync(claudeMdPath, content)
    success(`Updated ${CLAUDE_MD} with agent list`)
  } else {
    info(`No ${CLAUDE_MD} found in ${process.cwd()} — skipping Claude MD update.`)
    info(`To enable: create a ${CLAUDE_MD} file and re-run sync-agents.`)
  }

  console.log(`${c.bold}${c.green}Done!${c.reset} Agents are configured for this project.`)
  console.log(`  Edit ${c.bold}${AGENTS_FILE}${c.reset} to customise which agents are active.\n`)
}
