import { test } from 'node:test'
import assert from 'node:assert/strict'
import { definitions } from './reduced.js'
import { FACTORY_OPERATOR_TOOL_NAMES, selectFactoryOperator } from './factory-operator.js'

test('factory_operator selects every listed tool from the curated registry', () => {
  assert.deepEqual(
    selectFactoryOperator(definitions).map(def => def.name).sort(),
    [...FACTORY_OPERATOR_TOOL_NAMES].sort(),
  )
})

test('factory_operator exposes no memory-editing, SDD or harness tool', () => {
  const offLimits = /memory|sdd|harness|convention/
  for (const def of selectFactoryOperator(definitions)) {
    assert.ok(!offLimits.test(def.name), `${def.name} is not an operator tool`)
  }
})

test('factory_operator write tools are marked as writes', () => {
  const writes = selectFactoryOperator(definitions).filter(def => def.effects.includes('write')).map(def => def.name).sort()
  assert.deepEqual(writes, ['approve_factory_action', 'submit_factory_task'])
})

test('factory_operator fails loudly when a listed tool disappears', () => {
  const without = definitions.filter(def => def.name !== 'get_human_digest')
  assert.throws(() => selectFactoryOperator(without), /FACTORY_OPERATOR_UNKNOWN_TOOL: get_human_digest/)
})

test('approve_factory_action only accepts an exact head subject', () => {
  const approve = definitions.find(def => def.name === 'approve_factory_action')!
  const sha = '0123456789abcdef0123456789abcdef01234567'
  assert.ok(approve.input.safeParse({ subject: `acme/app#7@${sha}`, approve: true }).success)
  assert.ok(!approve.input.safeParse({ subject: 'acme/app#7@abc', approve: true }).success)
  assert.ok(!approve.input.safeParse({ subject: `acme/app#0@${sha}`, approve: true }).success)
})
