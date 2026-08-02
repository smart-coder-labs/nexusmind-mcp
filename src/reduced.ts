import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { getMemoryById, listMemories, listProjects, listSddChanges, listSddSpecs, searchMemories, searchSddArtifacts } from './client.js'
import { descriptorSchema, FABRIC_VERSION, REGISTRY_VERSION, ToolDefinition, ToolFabric } from './tool-fabric.js'

const string = (description: string) => z.string().describe(description)
const optionalString = (description: string) => z.string().optional().describe(description)
const integer = (description: string) => z.number().int().min(1).max(200).optional().describe(description)

const definitions: ToolDefinition[] = [
  tool('search_memories', 'Search team memories without returning schemas by default.', ['memory.search'], ['memory:read'], { query: string('Semantic query'), limit: integer('Maximum results') }, z.object({ query: z.string(), limit: z.number().int().min(1).max(200).optional() }), args => searchMemories(args as { query: string; limit?: number })),
  tool('list_memories', 'Browse team memories with bounded filters.', ['memory.list'], ['memory:read'], { project: optionalString('Project'), limit: integer('Maximum results') }, z.object({ project: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }), args => listMemories(args)),
  tool('get_memory', 'Fetch one authorized memory by id.', ['memory.read'], ['memory:read'], { id: string('Memory id') }, z.object({ id: z.string() }), args => getMemoryById(args.id as string)),
  tool('list_projects', 'List projects visible to the caller.', ['project.list'], ['project:read'], { include_archived: z.boolean().optional() }, z.object({ include_archived: z.boolean().optional() }), args => listProjects(args)),
  tool('list_sdd_changes', 'List SDD change metadata, never document content.', ['sdd.list'], ['sdd:read'], { project: optionalString('Project'), include_archived: z.boolean().optional() }, z.object({ project: z.string().optional(), include_archived: z.boolean().optional() }), args => listSddChanges(args)),
  tool('list_sdd_specs', 'List living specification metadata.', ['sdd.specs.list'], ['sdd:read'], { project: optionalString('Project'), include_archived: z.boolean().optional() }, z.object({ project: z.string().optional(), include_archived: z.boolean().optional() }), args => listSddSpecs(args)),
  tool('search_sdd_artifacts', 'Search SDD snippets without returning full documents.', ['sdd.search'], ['sdd:read'], { query: string('Search query'), limit: integer('Maximum hits') }, z.object({ query: z.string(), limit: z.number().int().min(1).max(200).optional() }), args => searchSddArtifacts(args.query as string, args.limit as number | undefined)),
]

function tool(name: string, summary: string, capabilities: string[], permissions: string[], shape: Record<string, unknown>, input: z.ZodType<Record<string, unknown>>, run: (args: Record<string, unknown>) => Promise<unknown>): ToolDefinition {
  const handle = `tool://nexusmind/${name}@${FABRIC_VERSION}`
  const properties = Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, zodJsonSchema(value)]))
  const required = Object.entries(shape).filter(([, value]) => !isOptional(value)).map(([key]) => key)
  return { name, namespace: 'nexusmind', summary, capabilities, io: { input: 'object', output: 'json' }, effects: ['read'], permissions, cost: 'low', latency: 'medium', failures: ['backend_error', 'permission_denied', 'invalid_args'], schema_handle: handle, version: FABRIC_VERSION, schema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false }, examples: [{ args: {}, description: 'Use only fields documented by load_tool.' }], input, run }
}

function isOptional(value: unknown): boolean {
  return (value as { _def?: { typeName?: string } })?._def?.typeName === 'ZodOptional'
}

function zodJsonSchema(value: unknown): Record<string, unknown> {
  const definition = (value as { _def?: { typeName?: string; innerType?: unknown; valueType?: unknown } })._def
  if (!definition) return { type: 'object' }
  if (definition.typeName === 'ZodOptional') return zodJsonSchema(definition.innerType)
  if (definition.typeName === 'ZodString') return { type: 'string' }
  if (definition.typeName === 'ZodNumber') return { type: 'number' }
  if (definition.typeName === 'ZodBoolean') return { type: 'boolean' }
  if (definition.typeName === 'ZodArray') return { type: 'array' }
  if (definition.typeName === 'ZodRecord') return { type: 'object' }
  return { type: 'object' }
}

export async function startReducedReadonly(): Promise<void> {
  const server = new McpServer({ name: 'nexusmind-reduced-readonly', version: REGISTRY_VERSION })
  const fabric = new ToolFabric(definitions)

  server.tool('find_tools', 'Discover compact authorized tool descriptors. Schemas are not included.', { query: z.string().optional(), effect_class: z.enum(['read', 'write', 'delete']).optional(), permissions: z.array(z.string()).default([]) }, async ({ query, effect_class, permissions }) => ({ content: [{ type: 'text', text: JSON.stringify({ profile: 'reduced_readonly', registry_version: REGISTRY_VERSION, tools: fabric.findTools(query, effect_class, permissions) }) }] }))
  server.tool('load_tool', 'Load the schema for one authorized tool handle.', { handle: z.string(), permissions: z.array(z.string()).default([]) }, async ({ handle, permissions }) => { const loaded = fabric.loadTool(handle, permissions); return { content: [{ type: 'text', text: JSON.stringify({ schema: descriptorSchema(loaded), examples: loaded.examples, version: loaded.version, registry_version: REGISTRY_VERSION, expires_in_ms: 300000 }) }] } })
  server.tool('execute_tool', 'Execute one loaded, versioned, authorized read-only tool.', { handle: z.string(), version: z.string(), args: z.record(z.unknown()), permissions: z.array(z.string()).default([]) }, async ({ handle, version, args, permissions }) => { try { const result_handle = await fabric.executeTool(handle, args, version, permissions); return { content: [{ type: 'text', text: JSON.stringify({ result_handle, version, expires_in_ms: 300000 }) }] } } catch (error) { return { content: [{ type: 'text', text: (error as Error).message }], isError: true } } })
  server.tool('fetch', 'Fetch only a bounded page of a result handle.', { handle: z.string(), cursor: z.string().optional(), range: z.object({ start: z.number().int().min(0).optional(), end: z.number().int().min(0).optional() }).optional(), permissions: z.array(z.string()).default([]) }, async ({ handle, cursor, range, permissions }) => { try { return { content: [{ type: 'text', text: JSON.stringify(fabric.fetchResult(handle, range, cursor, permissions)) }] } } catch (error) { return { content: [{ type: 'text', text: (error as Error).message }], isError: true } } })

  await server.connect(new StdioServerTransport())
}

export { definitions }
