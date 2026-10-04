import type { ToolDefinition } from './reduced.js'

// The `factory_operator` profile (software factory plan D4): the tools a person
// or an agent uses to run the factory — hand it tasks, see what waits on a
// person, decide one action, read what it costs — plus the context pack the
// factory's agents start from. Nothing else: an operator agent that sees
// memory-editing or SDD tools reaches for them.
//
// Explicit allow-list, like only_context: a tool added to the curated registry
// later does not enter this profile until someone decides it belongs, and the
// startup check fails if a listed name stops existing.
export const FACTORY_OPERATOR_TOOL_NAMES = [
  'submit_factory_task',
  'list_factory_tasks',
  'get_factory_task',
  'get_human_digest',
  'approve_factory_action',
  'get_factory_economics',
  'get_context_pack',
] as const

export function selectFactoryOperator(definitions: readonly ToolDefinition[]): ToolDefinition[] {
  const wanted = new Set<string>(FACTORY_OPERATOR_TOOL_NAMES)
  const selected = definitions.filter(def => wanted.has(def.name))
  const present = new Set(selected.map(def => def.name))
  const missing = FACTORY_OPERATOR_TOOL_NAMES.filter(name => !present.has(name))
  if (missing.length > 0) throw new Error(`FACTORY_OPERATOR_UNKNOWN_TOOL: ${missing.join(', ')}`)
  return selected
}
