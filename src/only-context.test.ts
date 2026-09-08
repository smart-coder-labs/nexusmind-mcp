import { test } from 'node:test'
import assert from 'node:assert/strict'
import { definitions } from './reduced.js'
import { ONLY_CONTEXT_TOOL_NAMES, selectOnlyContext } from './only-context.js'

test('only_context selects every listed tool from the curated registry', () => {
  const selected = selectOnlyContext(definitions)
  assert.deepEqual(
    selected.map(def => def.name).sort(),
    [...ONLY_CONTEXT_TOOL_NAMES].sort(),
  )
})

test('only_context exposes no task, sdd, usage or harness tool', () => {
  const names = selectOnlyContext(definitions).map(def => def.name)
  const offLimits = /task|sdd|usage|harness/
  for (const name of names) assert.ok(!offLimits.test(name), `${name} is not context`)
  for (const def of selectOnlyContext(definitions)) {
    for (const cap of def.capabilities) assert.ok(!offLimits.test(cap), `${def.name} carries ${cap}`)
    for (const perm of def.permissions) assert.ok(!offLimits.test(perm), `${def.name} requires ${perm}`)
  }
})

test('only_context still covers the memory read/write path an agent needs', () => {
  const names = new Set(selectOnlyContext(definitions).map(def => def.name))
  for (const required of ['search_memories', 'get_memory', 'get_context', 'store_memory', 'record_decision', 'locate_code']) {
    assert.ok(names.has(required), `${required} missing`)
  }
})

test('only_context fails loudly when a listed tool disappears from the registry', () => {
  const withoutContext = definitions.filter(def => def.name !== 'get_context')
  assert.throws(() => selectOnlyContext(withoutContext), /ONLY_CONTEXT_UNKNOWN_TOOL: get_context/)
})

test('only_context keeps registry order so the host lists tools consistently', () => {
  const registryOrder = definitions.map(def => def.name).filter(name => (ONLY_CONTEXT_TOOL_NAMES as readonly string[]).includes(name))
  assert.deepEqual(selectOnlyContext(definitions).map(def => def.name), registryOrder)
})

test('an unknown tool profile fails at startup instead of falling through to legacy', async () => {
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, ['dist/index.js'], {
    env: { ...process.env, NEXUSMIND_MCP_TOOL_PROFILE: 'only-context', NEXUSMIND_API_KEY: 'x', NEXUSMIND_BASE_URL: 'http://127.0.0.1:1' },
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Unknown NEXUSMIND_MCP_TOOL_PROFILE "only-context"/)
})
