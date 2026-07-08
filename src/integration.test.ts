import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { copyHookRuntime } from './setup.js'

// The compiled hook runtime is ES-module code copied outside this package into
// a bare directory. These tests run the ACTUAL built hooks the same way Codex
// does — node <hook>.js with a JSON payload on stdin — on whatever OS the CI
// matrix is on, guarding the 0.6.1 regression where a missing package.json made
// Node load the hooks as CommonJS and crash with
// "SyntaxError: Cannot use import statement outside a module" (exit 1).
const DIST = resolve(process.cwd(), 'dist')
const distBuilt = existsSync(join(DIST, 'client.js'))
const skip = distBuilt ? false : 'dist not built — run `npm run build` first'

// Every hook that Codex invokes. Each must load as ESM and exit 0 on a minimal
// payload with no API key (the no-key fast path — deterministic and offline).
const HOOKS = ['session-start.js', 'user-prompt-submit.js', 'pre-compact.js', 'post-compact.js', 'stop.js']

function runHook(hookPath: string, event: string) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ hook_event_name: event, prompt: 'hello', cwd: process.cwd() }),
    encoding: 'utf8',
    timeout: 20000,
    // Scrub the API key so the hooks take their no-key path: fast, offline, and
    // exit 0 regardless of the CI runner's network egress policy.
    env: { ...process.env, NEXUSMIND_API_KEY: '', NEXUSMIND_BASE_URL: '' },
  })
}

test('compiled hook runtime loads as ESM on this OS (guards the 0.6.1 SyntaxError regression)', { skip }, () => {
  const dest = mkdtempSync(join(tmpdir(), 'nexusmind-esm-'))
  try {
    assert.equal(copyHookRuntime(DIST, dest), true)
    assert.equal(existsSync(join(dest, 'package.json')), true, 'runtime dir missing package.json — hooks would load as CJS')

    for (const hook of HOOKS) {
      const event = hook.replace(/\.js$/, '').replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase())
      const res = runHook(join(dest, 'hooks', hook), event)
      assert.doesNotMatch(
        res.stderr || '',
        /Cannot use import statement outside a module/,
        `${hook} crashed with the ESM SyntaxError`,
      )
      assert.equal(res.status, 0, `${hook} exited ${res.status}; stderr: ${res.stderr}`)
    }
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})
