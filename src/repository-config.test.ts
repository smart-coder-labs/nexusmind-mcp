import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveCapabilities, filterDefinitions, loadRepositoryConfig, resolveProject, type RepositoryConfig } from './repository-config.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// A directory holding several independent clones is not a repository, so
// `git rev-parse` has nothing to say about it. Requiring git here meant the one
// case this config exists to describe — routing a workspace to its projects —
// was the one case it could not load.
test('a config is found outside any git repository', () => {
  const ws = mkdtempSync(join(tmpdir(), 'nm-ws-'))
  mkdirSync(join(ws, 'repoA', 'src'), { recursive: true })
  writeFileSync(join(ws, '.nexusmind.yaml'), [
    'version: 1',
    'repository:',
    '  id: ws',
    'defaults:',
    '  project: alpha',
    'projects:',
    '  alpha:',
    '    project_id: alpha',
    '    paths:',
    '      - repoA/**',
    '',
  ].join('\n'))

  const loaded = loadRepositoryConfig(undefined, join(ws, 'repoA', 'src'))
  assert.ok(loaded, 'the config must load with no git repository anywhere above')
  assert.equal(loaded!.config.repository.id, 'ws')
  assert.equal(loaded!.root, ws, "the config's own directory becomes the root")
})

test('no config anywhere still returns undefined rather than throwing', () => {
  const bare = mkdtempSync(join(tmpdir(), 'nm-bare-'))
  assert.equal(loadRepositoryConfig(undefined, bare), undefined)
})
