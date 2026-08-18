import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveCapabilities, filterDefinitions, resolveProject, type RepositoryConfig } from './repository-config.js'
import { definitions } from './reduced.js'

const config: RepositoryConfig = {
  version: 1, repository: { id: 'sample' }, defaults: { project: 'platform' },
  projects: {
    platform: { project_id: 'p0', paths: ['**'] },
    payments: { project_id: 'p1', paths: ['services/payments/**'], agent_profile: 'readonly' },
  },
  agents: { profiles: {
    essential: { capabilities: ['context.read','memory.read','memory.write','task.read','task.write'] },
    readonly: { extends: 'essential', capabilities: [], disable_capabilities: ['memory.write','task.write'] },
  } },
}

test('more specific project wins and readonly inheritance removes writes', () => {
  assert.equal(resolveProject(config, 'services/payments/a.ts')?.alias, 'payments')
  const caps = effectiveCapabilities(config, 'readonly')
  assert.equal(caps.has('memory.read'), true)
  assert.equal(caps.has('memory.write'), false)
})

test('filtered registry does not contain write descriptors', () => {
  const filtered = filterDefinitions(definitions, effectiveCapabilities(config, 'readonly'))
  assert.equal(filtered.some(d => d.effects.includes('write')), false)
  assert.equal(filtered.some(d => d.name === 'get_context'), true)
})
