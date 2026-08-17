import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { ZodRawShape } from 'zod'
import { definitions } from './reduced.js'
import { REGISTRY_VERSION } from './tool-fabric.js'

// The essential profile: the curated set of tools an agent actually reaches for,
// registered DIRECTLY as MCP tools.
//
// Why this exists beside `reduced_readonly`: the reduced profile hides every
// tool behind a find_tools -> load_tool -> execute_tool handshake, so a single
// `store_memory` costs three round-trips. That indirection earns its keep only
// when the catalog is too large to expose at once. For the tools an agent uses
// on almost every task it is pure overhead — it multiplied turns (and therefore
// tokens) with no capability gain.
//
// This profile exposes the SAME curated registry the reduced profile hides
// behind its fabric — memory, conventions, tasks, SDD, projects/clients, usage
// and code — directly, one call per action. That keeps it usable as a
// day-to-day driver (tasks and SDD included), not a memory-only subset. The
// token measurement that justified this profile showed the cost driver is
// injected-context size and turn count, not the number of tool schemas, so the
// direct catalog (~22 tools vs the legacy 149) is effectively free. The backend
// still enforces permissions on every call.
export async function startEssential(): Promise<void> {
  const server = new McpServer({ name: 'nexusmind-essential', version: REGISTRY_VERSION })

  for (const def of definitions) {
    // `input` is always a z.object(...) for these definitions, so its `.shape`
    // is the raw shape McpServer.tool expects.
    const shape = (def.input as unknown as { shape: ZodRawShape }).shape
    server.tool(def.name, def.summary, shape, async (args: Record<string, unknown>) => {
      try {
        const value = await def.run(args)
        return { content: [{ type: 'text', text: JSON.stringify(value) }] }
      } catch (error) {
        return { content: [{ type: 'text', text: (error as Error).message }], isError: true }
      }
    })
  }

  await server.connect(new StdioServerTransport())
}
