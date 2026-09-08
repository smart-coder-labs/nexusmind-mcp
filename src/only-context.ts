import type { ToolDefinition } from './reduced.js'

// The `only_context` profile: the curated registry cut down to what feeds an
// agent's CONTEXT — memories, conventions, the project/client catalog and code
// search. Nothing that drives work (tasks, SDD artifacts, usage reporting).
//
// It exists for deployments that bought NexusMind as a company brain and
// nothing else. Exposing task or SDD tools there is not harmless: the agent
// reads their descriptions, reaches for them, and the backend answers with a
// permission error or, worse, a record nobody will ever look at. The tool set
// is the product surface; it has to match what the panel shows.
//
// This is an explicit allow-list, on purpose. A tool added to the curated
// registry later does NOT enter this profile until someone decides it is
// context. The test in only-context.test.ts fails if a listed name stops
// existing, so the list cannot drift silently either.
export const ONLY_CONTEXT_TOOL_NAMES = [
  // memories
  'search_memories',
  'list_memories',
  'get_memory',
  'get_context',
  'store_memory',
  'update_memory',
  'record_decision',
  'promote_memory',
  // conventions
  'list_conventions',
  'store_convention',
  // catalog
  'list_projects',
  'list_clients',
  // code
  'locate_code',
  'search_code',
  'get_symbol_context',
] as const

export type OnlyContextToolName = (typeof ONLY_CONTEXT_TOOL_NAMES)[number]

/** Selects the only-context tools out of the curated registry, in registry
 *  order. Throws when a listed name is missing, so a rename in reduced.ts is
 *  caught at startup (and by the tests) rather than by an agent at runtime. */
export function selectOnlyContext(definitions: readonly ToolDefinition[]): ToolDefinition[] {
  const wanted = new Set<string>(ONLY_CONTEXT_TOOL_NAMES)
  const selected = definitions.filter(def => wanted.has(def.name))
  const present = new Set(selected.map(def => def.name))
  const missing = ONLY_CONTEXT_TOOL_NAMES.filter(name => !present.has(name))
  if (missing.length > 0) throw new Error(`ONLY_CONTEXT_UNKNOWN_TOOL: ${missing.join(', ')}`)
  return selected
}
