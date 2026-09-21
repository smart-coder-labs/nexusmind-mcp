import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

test('legacy catalog keeps the 148 registered tools', () => {
  const source = readFileSync(fileURLToPath(new URL('./legacy.ts', import.meta.url)), 'utf8')
  assert.equal((source.match(/server\.tool\(/g) ?? []).length, 148)
})

const ENTRY = resolve(process.cwd(), 'dist', 'index.js')

async function listToolsWithProfile(profile?: string): Promise<string[]> {
  const { NEXUSMIND_MCP_TOOL_PROFILE: _ignored, ...base } = process.env
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      ...base,
      ...(profile ? { NEXUSMIND_MCP_TOOL_PROFILE: profile } : {}),
      NEXUSMIND_API_KEY: 'nm_test_key',
      NEXUSMIND_BASE_URL: 'http://127.0.0.1:1',
    },
  })
  const client = new Client({ name: 'default-profile-test', version: '1.0.0' })
  await client.connect(transport)
  try {
    return (await client.listTools()).tools.map(tool => tool.name)
  } finally {
    await client.close()
  }
}

// The default profile is what every host pays for on connect: legacy publishes
// 148 tool definitions (~24k tokens of schemas) into the model's context.
test('the default profile is essential, not the 148-tool legacy catalog', {
  skip: existsSync(ENTRY) ? false : 'dist not built — run `npm run build` first',
}, async () => {
  const [defaultTools, legacyTools] = [await listToolsWithProfile(), await listToolsWithProfile('legacy')]
  assert.ok(defaultTools.length < 60, `default profile published ${defaultTools.length} tools`)
  assert.equal(legacyTools.length, 148)
  for (const required of ['search_memories', 'store_memory', 'get_context']) {
    assert.ok(defaultTools.includes(required), `${required} missing from the default profile`)
  }
})
