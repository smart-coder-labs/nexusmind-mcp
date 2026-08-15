import { test } from 'node:test'
import assert from 'node:assert/strict'

// Both of these are shape bugs: the TS type described a wire shape the backend
// never sends, and TypeScript happily compiled the lie. The fixtures below are
// copied from a real GET response, so they cannot drift back.

test('a harness listing prints the version number, not "[object Object]"', async () => {
  const { formatHarness } = await import('./format-harness.js')
  const line = formatHarness({
    id: 'h1', slug: 'sdd-design', name: 'SDD Design',
    // The wire sends an OBJECT here. Typing it as `string` printed "v[object Object]"
    // and the version — most of what a catalog is for — was invisible.
    latest_version: {
      id: 'v1', version: '2.0.0', manifest_hash: 'sha256:abc',
      targets: ['claude'], format: 'skill', status: 'published',
      published_at: '2026-07-13T00:00:00Z',
    },
  } as never)
  assert.match(line, /v2\.0\.0/)
  assert.doesNotMatch(line, /object Object/)
})

test('a version reports its real component count, not 0', async () => {
  const { formatHarnessVersion } = await import('./format-harness.js')
  const out = formatHarnessVersion({
    harness_id: 'h1', version: '2.0.0', format: 'skill', targets: ['claude'],
    manifest_hash: 'sha256:abc',
    // Components live under `manifest`. Reading `v.components` yielded 0 for every
    // version, which reads as "empty stub" — and made a bulk publish misclassify
    // real versions as broken.
    manifest: { components: [{ kind: 'folder', path: '_shared' }] },
  } as never)
  assert.match(out, /Components: 1/)
  assert.doesNotMatch(out, /Components: 0/)
})
