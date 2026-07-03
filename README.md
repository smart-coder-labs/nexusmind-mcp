# @smart-coder-labs/nexusmind-mcp

MCP server for [NexusMind](https://nexusmind.io) — team memory for AI coding agents.

Store decisions, bug fixes, and conventions once. Recall them in Claude Code, Cursor, or any MCP-compatible tool — no duplicate setup, same backend.

---

## Quick start

```bash
npx @smart-coder-labs/nexusmind-mcp setup
```

The setup wizard asks for your API key, backend URL, and which tools to configure:

```
NexusMind — Setup
──────────────────────────────────

NexusMind API key (nm_…): nm_your_key_here
Backend URL [http://localhost:8080]: https://your-nexusmind.com

Configure for:
  1) Claude Code
  2) Cursor
  3) Codex CLI
  4) All (recommended)

Choice [1-4]: 4

Cursor — where to write the config?
  1) Global (all projects)  →  ~/.cursor/mcp.json
  2) This project only      →  ./cursor/mcp.json

Choice [1-2]: 1
```

Done. Restart Claude Code or Cursor and the tools are available immediately.

---

## Requirements

- Node.js 18+
- A NexusMind API key — get one from your admin panel → Users
- NexusMind backend running (self-hosted or cloud)

---

## Tools

| Tool | Description |
|------|-------------|
| `store_memory` | Save a decision, bug fix, convention, or discovery |
| `search_memories` | Search or browse team memories — pass `query` to search, omit it to list/filter |
| `get_context` | Fetch team knowledge as a formatted block — designed for Cursor rules and notepads |

See [CHANGELOG.md](./CHANGELOG.md) for the full tool list and the 0.5.0 migration table.

---

## Manual configuration

### Claude Code

Claude Code registration is handled by the NexusMind plugin, not by a manual
`~/.claude.json` entry. Install it from inside Claude Code:

```
/plugin marketplace add smart-coder-labs/nexusmind-claude-plugin
/plugin install nexusmind@nexusmind
```

Then set `NEXUSMIND_API_KEY` and `NEXUSMIND_BASE_URL` (the setup wizard writes these
to your shell rc file, or set them yourself).

### Cursor (global)

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "nexusmind": {
      "command": "npx",
      "args": ["-y", "@smart-coder-labs/nexusmind-mcp"],
      "env": {
        "NEXUSMIND_API_KEY": "nm_your_key_here",
        "NEXUSMIND_BASE_URL": "https://your-nexusmind.com"
      }
    }
  }
}
```

### Cursor (per project)

Create `.cursor/mcp.json` in your project root with the same content.
Add `.cursor/mcp.json` to `.gitignore` if the file contains your API key.

### Codex CLI

The setup wizard prefers the official registration command:

```bash
codex mcp add nexusmind --env NEXUSMIND_API_KEY=nm_your_key_here --env NEXUSMIND_BASE_URL=https://your-nexusmind.com -- npx -y @smart-coder-labs/nexusmind-mcp@latest
```

If the `codex` binary isn't on your `PATH`, the wizard prints a `[mcp_servers.nexusmind]`
snippet to paste into `~/.codex/config.toml` yourself (setup never hand-edits
`config.toml` — TOML edits are your call). `CODEX_HOME` is respected if you've set it.

**Hooks.** Setup also writes memory-protocol hooks to `~/.codex/hooks.json`
(merged in, not overwritten — existing hooks from other tools are left alone):

| Codex event | Handler |
|---|---|
| `SessionStart` | `dist/hooks/session-start.js` — protocol reminder + project/recent memories |
| `UserPromptSubmit` | `dist/hooks/user-prompt-submit.js` — recall-keyword-gated by default |
| `PreCompact` | `dist/hooks/pre-compact.js` — session snapshot saved before compaction destroys context |
| `PostCompact` | `dist/hooks/post-compact.js` — recovery instructions + recent memories |
| `SubagentStop` | `dist/hooks/stop.js` — quality-gated passive capture of decision-like subagent output |
| `Stop` | `dist/hooks/stop.js` — enforcement gate: blocks the turn from ending (once per session) if it looks decision-like and nothing was saved via `store_memory` |

Codex has no `SessionEnd` event (Stop is its final per-turn lifecycle hook), so the
Claude plugin's session-end fallback save has no Codex equivalent — the Stop gate
above is the closest analog, and it enforces rather than silently saves.

**Codex does not auto-trust hooks.** After setup, open Codex and run `/hooks` to
review and approve the NexusMind entries — they will not fire until you do.

**Coexistence with Codex Memories.** Codex ships a native "Memories" feature
(off by default). It's unrelated to NexusMind and safe to use alongside these
hooks — just be aware that running both means memory-style context may show up
twice (once from Codex Memories, once from NexusMind) if you enable Codex's
native feature too.

**Env vars** (same ones the hooks read):

| Var | Default | Purpose |
|---|---|---|
| `NEXUSMIND_API_KEY` | — | required; hooks no-op silently without it |
| `NEXUSMIND_BASE_URL` | `https://nexusmind-backend.fly.dev` | backend URL |
| `NEXUSMIND_PROMPT_INJECT` | `minimal` | `off` \| `minimal` \| `full` — controls `UserPromptSubmit` verbosity |
| `NEXUSMIND_STOP_GATE` | `on` | `on` \| `off` — set to `off` to disable the `Stop` enforcement gate |
| `NEXUSMIND_PROMPT_MEMORY_LIMIT` | `3` | memories shown per prompt in `full` mode |
| `NEXUSMIND_SESSION_PROJECT_LIMIT` | `8` | project memories shown on `SessionStart` |
| `NEXUSMIND_SESSION_RECENT_LIMIT` | `5` | recent memories shown on `SessionStart`/`PostCompact` |

**Uninstall:**

```bash
codex mcp remove nexusmind
```

Then remove the NexusMind entries from `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`) —
delete the file, or manually remove array entries whose `command` contains `dist/hooks/`.

---

## `get_context` — Cursor rules injection

The `get_context` tool returns team memories grouped by type as a markdown block ready to paste into a Cursor rule or notepad.

**As a Cursor Rule:**
1. Open Cursor → Settings → Rules (or create `.cursor/rules/nexusmind.mdc`)
2. Ask Cursor: *"Call get_context for project nexusmind and paste the result here"*

**As a Notepad:**
1. Open Cursor → Notepads → New notepad → name it `Team Context`
2. Ask Cursor: *"Call get_context for project nexusmind and add the result to this notepad"*
3. Reference it in any chat with `@Team Context`

Example output:

```markdown
## NexusMind Team Context — nexusmind
> Last updated: May 23, 2026 · 12 memories

### Architecture & Design
- SqliteStore wraps Arc<Mutex<Connection>>, exposes conn() for non-memory handlers
- Auth model uses API keys validated per-request via SHA-256 hash

### Decisions
- Use anyhow::Result throughout handlers for consistent error propagation

### Bugs & Fixes
- Double slash in reset URLs — fixed by trimming trailing slash from APP_BASE_URL
```

---

## Self-hosted

Set `NEXUSMIND_BASE_URL` to your server:

```bash
NEXUSMIND_API_KEY=nm_your_key NEXUSMIND_BASE_URL=http://localhost:8080 npx @smart-coder-labs/nexusmind-mcp
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Tools not appearing in Claude Code | Run `npx @smart-coder-labs/nexusmind-mcp setup`; if it reports the plugin isn't installed, run the printed `/plugin marketplace add` / `/plugin install` commands and restart |
| Tools not appearing in Cursor | Restart Cursor after adding mcp.json. Requires Cursor v0.45+ |
| `NEXUSMIND_BASE_URL is not set` | Re-run setup or add the env var to your mcp.json manually |
| `NexusMind backend not reachable` | Check that your NexusMind backend is running |
| `Invalid API key` | Verify the key in your admin panel → Users → rotate if needed |
