import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { FABRIC_VERSION, ToolDefinition, ToolFabric } from './tool-fabric.js'

function fixture(effect: 'read' | 'write' | 'delete' = 'read'): ToolDefinition {
  return {
    name: `${effect}_tool`, namespace: 'test', summary: `${effect} fixture`, capabilities: ['fixture'],
    io: { input: 'object', output: 'json' }, effects: [effect], permissions: ['fixture:read'],
    cost: 'low', latency: 'low', failures: [], schema_handle: `tool://test/${effect}_tool@${FABRIC_VERSION}`,
    version: FABRIC_VERSION, schema: { type: 'object' }, examples: [], input: z.object({ value: z.string() }),
    run: async ({ value }) => Array.from({ length: 120 }, (_, index) => `${value}-${index}`),
  }
}

test('findTools returns compact descriptors and filters permissions/effects', () => {
  const fabric = new ToolFabric([fixture(), fixture('write')], 1000, 'owner')
  const results = fabric.findTools('fixture', 'read', ['fixture:read'])
  assert.equal(results.length, 1)
  assert.equal('schema' in results[0], false)
  assert.equal('examples' in results[0], false)
})

test('empty caller permissions do not pre-filter — the reduced profile is usable without a permission-aware host', () => {
  // The reported failure: an agent calls find_tools without a `permissions`
  // arg (it cannot enumerate its key's grants), the arg defaults to [], and the
  // old `.every()` check matched only zero-permission tools — so EVERY query
  // returned [] and the whole reduced profile looked empty. Empty must mean
  // "do not pre-filter"; the backend still gates each call.
  const fabric = new ToolFabric([fixture(), fixture('write')], 1000, 'owner')
  assert.equal(fabric.findTools('fixture', undefined, []).length, 2, 'empty permissions must surface all tools, not none')
  assert.equal(fabric.findTools('fixture').length, 2, 'omitted permissions default to unfiltered too')
  // load/execute must likewise defer to the backend when unspecified.
  assert.ok(fabric.loadTool(`tool://test/read_tool@${FABRIC_VERSION}`, []), 'a tool loads without the caller declaring permissions')
  // A permission-aware host that DOES pass a set still gets pre-filtering.
  assert.equal(fabric.findTools('fixture', undefined, ['other:read']).length, 0, 'a non-empty, non-matching set still filters everything out')
})

test('fabric allows writes but denies destructive deletes before execution', () => {
  const fabric = new ToolFabric([fixture('write'), fixture('delete')], 1000, 'owner')
  assert.ok(fabric.loadTool(`tool://test/write_tool@${FABRIC_VERSION}`, ['fixture:read']))
  assert.throws(() => fabric.loadTool(`tool://test/delete_tool@${FABRIC_VERSION}`, ['fixture:read']), /FABRIC_DESTRUCTIVE_EFFECT_DENIED/)
})

test('load and result handles expire, versions are checked, and pages are bounded', async () => {
  const fabric = new ToolFabric([fixture()], 20, 'owner')
  const handle = `tool://test/read_tool@${FABRIC_VERSION}`
  fabric.loadTool(handle, ['fixture:read'])
  await assert.rejects(() => fabric.executeTool(handle, { value: 'x' }, '0.0.0', ['fixture:read']), /FABRIC_VERSION_MISMATCH/)
  const result = await fabric.executeTool(handle, { value: 'x' }, FABRIC_VERSION, ['fixture:read'])
  const first = fabric.fetchResult(result, undefined, undefined, ['fixture:read'])
  assert.equal(first.items.length, 50)
  assert.ok(first.next_cursor)
  const second = fabric.fetchResult(result, undefined, first.next_cursor, ['fixture:read'])
  assert.equal(second.items[0], 'x-50')
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.throws(() => fabric.fetchResult(result, undefined, undefined, ['fixture:read']), /FABRIC_HANDLE_EXPIRED/)
})

test('invalid result handles never expose stored values', () => {
  const fabric = new ToolFabric([fixture()], 1000, 'owner')
  assert.throws(() => fabric.fetchResult('result://unknown', undefined, undefined, ['fixture:read']), /FABRIC_HANDLE_EXPIRED|FABRIC_INVALID_HANDLE/)
})
