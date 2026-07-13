import type { Harness, HarnessVersion } from './client.js'

// Extracted from index.ts so they can be tested: index.ts is the MCP bin entry and
// starts the stdio server on import, so nothing there is importable from a test.
// Both of these carried a shape bug that a test would have caught the day it landed.

export function formatHarness(h: Harness): string {
  const targets = h.targets && h.targets.length > 0 ? ` [${h.targets.join(', ')}]` : ''
  const owner = h.owner_user_id ? ` (owner: ${h.owner_user_id})` : ''
  // `latest_version` is an OBJECT on the wire. Interpolating it directly printed
  // "v[object Object]" — the version was invisible in every listing, which is most
  // of what a catalog is for.
  const version = h.latest_version?.version ? ` v${h.latest_version.version}` : ''
  return `• ${h.slug}${version} — ${h.name}${targets}${owner} (id: ${h.id})`
}

export function formatHarnessVersion(v: HarnessVersion): string {
  // Components live under `manifest`, not at the top level. Reading `v.components`
  // silently yielded 0 for every version — which read as "this version is an empty
  // stub" and led a bulk-publish run to misclassify real versions as broken.
  const componentCount = v.manifest?.components?.length ?? 0
  const lines = [
    `Harness ${v.harness_id} version ${v.version}`,
    `Format: ${v.format}`,
    `Targets: ${v.targets.join(', ')}`,
    `Manifest hash: ${v.manifest_hash}`,
    `Components: ${componentCount}`,
  ]
  if (v.security?.executable) lines.push('Warning: contains an executable component')
  if (v.security?.requires_approval) lines.push('Requires approval before install')
  return lines.join('\n')
}
