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
  3) Both (recommended)

Choice [1-3]: 3

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
