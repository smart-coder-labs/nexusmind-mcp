import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

test('legacy catalog keeps the 136 registered tools', () => {
  const source = readFileSync(fileURLToPath(new URL('./legacy.ts', import.meta.url)), 'utf8')
  assert.equal((source.match(/server\.tool\(/g) ?? []).length, 136)
})
