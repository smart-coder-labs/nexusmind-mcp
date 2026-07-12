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

## Harness tools

Harnesses are shareable agent artifacts — agents, skills, commands, hooks, output styles,
Claude Code plugins, and themes — that can be recommended, installed, or published through
these 10 tools. All of them are permission-gated backend-side (`harness:read` /
`harness:write`); the MCP server adds no client-side authority.

### Read / recommend

| Tool | Description |
|------|-------------|
| `recommend_harnesses` | List recommended harnesses for a target tool (`claude`, `codex`, `cursor`). Metadata only. |
| `list_harnesses` | List harnesses visible to the caller, optionally filtered by `target` or `owner_user_id`. Metadata only. |
| `get_harness_version` | Preview a specific harness version — format, targets, manifest hash, component summary. Read-only, no approval required. |
| `list_harness_config_reviews` | List shared harness config reviews (redacted snapshots only), optionally filtered by `status`. |

None of these fetch manifest content or component downloads — only catalog metadata and,
for `get_harness_version`, a preview summary.

### Install — two-phase, approval-first

Installing a harness is split into a **plan** step (read-only, writes nothing) and an
**apply** step (writes to disk only after explicit confirmation):

1. **`plan_harness_install`** — downloads the manifest preview, resolves the per-tool
   destinations, and returns a full diff (`create` / `overwrite` / `skip` per file) plus any
   executable warnings. Nothing is written to disk.
2. You review the diff.
3. **`apply_harness_install`** — requires the `manifest_hash` from step 1 as proof the diff
   was reviewed. It records a backend approval, re-downloads the manifest to check for hash
   drift, materializes the files, and records the install result.

Two confirmation flags on `apply_harness_install`:

- **`warning_acknowledged`** — required when the plan reported
  `requires_acknowledgement: true`. This happens for executable formats (`hook`,
  `claude_code_plugin`); apply refuses to write without it.
- **`overwrite_confirmed`** — required when any diff entry's `action` is `overwrite` (an
  existing local file would be replaced). If any entry would overwrite and this flag isn't
  set, apply refuses the **entire** install with zero writes — not even the non-overwriting
  entries are written.

`apply_harness_install` returns a `result_status` of one of:

| Status | Meaning |
|--------|---------|
| `installed` | Files materialized successfully. |
| `failed` | One or more components failed to write (see `errors`). |
| `hash_mismatch` | The manifest changed between plan and apply — nothing was written; re-run `plan_harness_install`. |
| `overwrite_not_confirmed` | An overwrite would occur and `overwrite_confirmed` wasn't set — nothing was written. |

### Create / upload

| Tool | Description |
|------|-------------|
| `build_harness_manifest_from_path` | Reads local files at a path, computes sha256 + size per component, inlines content up to 64KiB per component (refuses larger files, never truncates), and runs a local secret scan that refuses the entire build on any hit — never inlines or hashes offending content. Produces a schema 1.1 manifest. Uploads nothing. |
| `create_harness` | Create a new harness. Thin wrapper over the `harness:write`-gated backend endpoint. |
| `publish_harness_version` | Publish an immutable harness version from a manifest (typically from `build_harness_manifest_from_path`). Thin wrapper over the `harness:write`-gated backend endpoint. |

### Config review

| Tool | Description |
|------|-------------|
| `create_harness_config_review` | Redacts a local config file's secret-shaped values **locally** first, then submits the redacted snapshot, redaction report, and content hash for review. The backend independently re-enforces raw-content rejection as a second gate. |

### Destinations per tool

| Tool | Default destination |
|------|----------------------|
| Claude Code | `~/.claude/` (user scope) or `.claude/` (project scope) |
| Cursor | `~/.cursor/` (user scope) or `.cursor/` (project scope) |
| Codex | `~/.codex/` (user scope) or `.codex/` (project scope) — conservative default; Codex only supports markdown-only formats (`agent`, `command`) |

`cursor` is a first-class install/manifest target (it replaced `opencode`). `skill`,
`output_style`, and `theme` are Claude Code-only formats — installs targeting `codex` or
`cursor` for those formats are refused with no destination guessed.

---

## Task tools

Team task management — create, assign, and track tasks, link them to OpenSpec changes,
and manage sprints. All permission-gated backend-side (`task:read` / `task:write` /
`task:assign` / `task:delete` / `task:manage`); the MCP server adds no client-side authority.

| Tool | Description |
|------|-------------|
| `list_my_tasks` | List the calling user's own pending tasks (assignee = the API key's user), optionally filtered by `project` and `status`. |
| `list_tasks` | List tasks in a project, filterable by `status`, `assignee`, `sprint`, or `label`. |
| `get_task` | Fetch one task with its assignees, labels, comments, subtasks, and spec links. |
| `create_task` | Create a task (`title`, optional `description` / `priority` / `due_date` / `project` / `parent_id`). |
| `update_task` | Patch a task's fields or status (status changes are validated against the transition matrix). |
| `delete_task` | Soft-delete a task. Requires `confirm: true` — refuses with no HTTP call otherwise. |
| `assign_task` | Assign or unassign a user to a task. `task:assign`-gated; the assignee must belong to the org. |
| `add_task_comment` | Add a comment to a task. |
| `add_task_label` | Add a label/tag to a task. |
| `link_task_spec` | Link a task to an OpenSpec change by its folder name (many-to-many). |
| `resolve_tasks_for_spec` | Transition every task linked to a given OpenSpec change to `done` — invoked by the sdd-verify / sdd-archive flow. |
| `list_sprints` | List sprints for a project. |
| `create_sprint` | Create a sprint. |
| `create_sprint_retrospective` | Record a persisted retrospective for a sprint (real backend record — replaces the former client-side memory-aggregation stub). |

---

## SDD artifact tools

The spec-driven-development artifact store — the proposal, spec, design, tasks, and report
documents of an OpenSpec change, kept in NexusMind rather than only in a git checkout, so a
sub-agent on any machine can read the **full** document of a previous phase. Exactly seven
tools, all permission-gated backend-side (`sdd:read` / `sdd:write`); the MCP server adds no
client-side authority.

| Tool | Description |
|------|-------------|
| `save_sdd_artifact` | Persist an SDD document (creating the change if unknown). **Idempotent by content hash** — re-saving byte-identical content creates no revision, so every `sdd-*` skill can call it unconditionally. `sdd:write`. |
| `get_sdd_artifact` | Fetch a document by artifact id or by `(project, change_name, kind, capability?)` and return its **FULL content — never a preview**. Defaults to the latest revision; accepts an explicit `revision`. A missing artifact reports not-found, never an empty document. `sdd:read`. |
| `list_sdd_changes` | List changes with phase and status, filterable by `project` / `status` / `phase` / `sprint_id`. Metadata only — never artifact content. Powers `/sdd-status`. `sdd:read`. |
| `get_sdd_change` | One change plus its artifact inventory, linked tasks, and linked memories. The inventory **is** the recoverable DAG state — powers `/sdd-continue` with no checkout. `sdd:read`. |
| `update_sdd_change` | Patch a change's `phase` / `status` / `title` / `sprint_id`. An invalid phase is rejected atomically; an unknown change reports not-found and is never created as a side effect. `sdd:write`. |
| `search_sdd_artifacts` | Full-text search across every change in the org; returns snippets plus the natural key to pass to `get_sdd_artifact`. `sdd:read`. |
| `link_sdd_change_memory` | Tie a memory (decision, bugfix, discovery) back to the change that produced it — called by `sdd-apply` / `sdd-verify`. Idempotent per `(change, memory)` pair. `sdd:write`. |

There is deliberately no `create_sdd_change` (the save **is** the create) and no
`delete_sdd_change` (archival is admin/API-only).

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
| Anything broken on Windows | Run `npx @smart-coder-labs/nexusmind-mcp doctor` — it diagnoses stale env vars, a corrupted npx cache, and an invalid/mismatched key, and self-heals the npx cache |
| Codex: `connection closed: initialize response` | Corrupted npx cache. `doctor` (or re-running `setup`) clears it automatically; otherwise `npm cache clean --force`. Then restart Codex |
| Codex hooks show "Failed" / no approve option (Windows) | Upgrade to ≥0.8.2 and re-run `setup`, then run `/hooks` in Codex and approve the NexusMind hooks (the fix changes their hash, so re-approval is required once) |
| `Invalid API key` right after changing the key (Windows) | `setx` doesn't update already-running programs. Fully quit and reopen the client from the Start menu — not from an existing terminal |
