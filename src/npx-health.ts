// Shared npx launch-health probe + self-heal, used by both `setup` and `doctor`.
// The failure it guards against: a corrupted npx cache makes `npx -y <pkg>@latest`
// fail with "'nexusmind-mcp' is not recognized", which clients surface only as an
// opaque MCP "connection closed: initialize response" with zero hint of the cause.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export const PACKAGE_SPEC = '@smart-coder-labs/nexusmind-mcp@latest'

export type ProbeResult =
  | 'ok'            // launched and emitted our marker (new-enough published version)
  | 'unresolved'    // npx could not resolve/run the bin — corrupted cache
  | 'inconclusive'  // bin launched but no marker (older published version, or timeout)

// Matches the shell's "not recognized / no reconoce / not found" family across
// locales, plus Node spawn ENOENT — the signatures of a cache that can't resolve
// the bin, as opposed to a bin that launched fine but didn't print our marker.
const UNRESOLVED = /not recognized|no se reconoce|não é reconhecido|command not found|ENOENT|cannot find/i

// `smoke` is an instant, side-effect-free subcommand (see index.ts) that prints
// the marker below. A short timeout is fine: a resolvable bin prints it in well
// under a second; anything slower means the bin launched but is an older version
// that treats `smoke` as a server start (blocks) — inconclusive, not corrupt.
export function probeNpxLaunch(timeoutMs = 25_000): ProbeResult {
  const res = spawnSync('npx', ['-y', PACKAGE_SPEC, 'smoke'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: timeoutMs,
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  if (out.includes('nexusmind-smoke-ok')) return 'ok'
  // A timeout (res.error with no exit) means the process launched and kept
  // running — the bin resolved, so the cache is fine.
  if (res.status !== 0 && UNRESOLVED.test(out + (res.error?.message ?? ''))) return 'unresolved'
  return 'inconclusive'
}

// Deletes the npx package cache (`<npm cache>/_npx`). npx re-downloads on next
// use, so this only costs one re-fetch and never touches global/local installs.
export function clearNpxCache(): boolean {
  const res = spawnSync('npm', ['config', 'get', 'cache'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const cacheDir = (res.stdout ?? '').trim()
  if (!cacheDir || res.status !== 0) return false
  try {
    rmSync(join(cacheDir, '_npx'), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}
