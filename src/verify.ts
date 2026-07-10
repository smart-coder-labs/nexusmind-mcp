// Lightweight, self-contained credential check used by `setup` and `doctor`.
// It deliberately does NOT read the module-level API_KEY/BASE_URL from client.ts
// (those are frozen at import time from process.env) — callers pass the exact
// key/url they just configured so we validate *those*, not whatever stale value
// happens to be in the current process environment.

export type VerifyResult =
  | { ok: true; status: 200 }
  | { ok: false; reason: 'missing-key' | 'missing-url' | 'unauthorized' | 'unreachable' | 'http-error'; status: number; message: string }

// POST /v1/memory/search is read-only (returns at most one memory) and is the
// same endpoint the MCP tools hit, so a 200 here means the key will work for
// real calls too. 401 = bad key; a network failure = backend unreachable.
export async function verifyCredentials(apiKey: string, baseUrl: string): Promise<VerifyResult> {
  if (!apiKey)  return { ok: false, reason: 'missing-key', status: 0, message: 'NEXUSMIND_API_KEY is empty' }
  if (!baseUrl) return { ok: false, reason: 'missing-url', status: 0, message: 'NEXUSMIND_BASE_URL is empty' }

  const url = `${baseUrl.replace(/\/+$/, '')}/v1/memory/search`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query: 'connectivity-check', limit: 1 }),
    })
  } catch {
    return { ok: false, reason: 'unreachable', status: 0, message: `Backend not reachable at ${baseUrl}` }
  }

  if (res.status === 200) return { ok: true, status: 200 }
  if (res.status === 401) return { ok: false, reason: 'unauthorized', status: 401, message: 'Backend rejected the API key (HTTP 401)' }
  return { ok: false, reason: 'http-error', status: res.status, message: `Backend returned HTTP ${res.status}` }
}

// Shared key-masking so setup, doctor, and logs render keys identically.
export function maskKey(key: string): string {
  if (!key) return '(unset)'
  return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : '***'
}
