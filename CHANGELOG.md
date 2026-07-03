# Changelog

## 0.6.0

### Added

- Codex CLI `PreCompact` hook (`dist/hooks/pre-compact.js`): saves a session snapshot
  (last ~15 assistant messages, 2000-char truncation, skipped below 100 chars) before
  compaction destroys context. Codex's `PreCompact` runs synchronously and blocking
  before compaction proceeds, so the save is guaranteed to complete first. Ported from
  the Claude plugin's `pre-compact.sh`; upserts into the same `session-snapshot/{session_id}`
  topic key a same-session `PreCompact` snapshot would already use, avoiding duplicates.
  Wired into `installCodexHooks`'s event mapping and the copied hook runtime.

### Changed

- Codex CLI `Stop` hook (`dist/hooks/stop.js`) is no longer passive capture — it is
  now an **enforcement gate**, matching the Claude plugin's `session-stop.sh`. If the
  turn since the last real user message looks decision-like (matches the same keyword
  regex used elsewhere) and no `store_memory` tool call happened in that span, it emits
  `{"decision":"block","reason":"..."}` so Codex continues the turn instead of ending
  it — once per session, tracked via a state file under
  `${XDG_CACHE_HOME:-$HOME/.cache}/nexusmind/stop-gate-{session_id}` (written before the
  block decision is emitted, so an unwritable cache dir fails open instead of blocking
  every turn). Guards against re-triggering itself via the `stop_hook_active` flag, and
  is disabled entirely with `NEXUSMIND_STOP_GATE=off`.
- `SubagentStop` keeps the previous quality-gated passive-capture behavior unchanged —
  `stop.js` now branches on `hook_event_name` to run genuinely different logic for
  `Stop` vs. `SubagentStop`, where before both shared the same passive-capture code path.

### Notes

- Codex has no `SessionEnd` event — `Stop` is its final per-turn lifecycle hook (see
  https://developers.openai.com/codex/hooks). The Claude plugin's `session-end.sh`
  fallback-summary behavior therefore has no direct Codex port; the `Stop` gate above
  is the closest analog, and it enforces a save rather than silently performing one.
- `PostCompact` (`dist/hooks/post-compact.js`) was already emitting the required
  `hookSpecificOutput` envelope — verified, no change needed.

## 0.5.2

### Fixed

- Codex hooks were written in a shape Codex silently ignores — flat event arrays at
  the top level of `hooks.json` (`{ "SessionStart": [entry] }`). Codex expects
  matcher groups nested under a top-level `hooks` key:
  `{ "hooks": { "SessionStart": [{ "hooks": [entry] }] } }`
  (see https://developers.openai.com/codex/hooks). This is why `/hooks` inside
  Codex showed nothing to trust and the memory protocol never fired. Setup now
  writes the correct schema, migrates away the old flat keys, preserves hook
  groups registered by other tools, and stays idempotent across re-runs.
- `hooks.json` is never overwritten when it exists but cannot be parsed — setup
  reports the problem and leaves the file untouched.

## 0.5.1

### Fixed

- `setup` now works out of the box on Windows and macOS when the NexusMind Claude
  plugin is not installed. Previously it only printed `/plugin marketplace add` /
  `/plugin install` instructions and configured nothing. It now falls back to
  registering the MCP server directly in `~/.claude.json`, embedding the real
  `NEXUSMIND_API_KEY` / `NEXUSMIND_BASE_URL` values instead of `${VAR}` shell
  placeholders — shell rc files (`~/.zshrc`, `~/.bashrc`) don't exist on Windows,
  so the placeholder approach never worked there. Installing the plugin later
  remains the recommended upgrade path; setup prints the instructions and the
  `claude mcp remove nexusmind` cleanup command.
- Setup never overwrites a `~/.claude.json` it cannot parse: on invalid JSON it
  leaves the file untouched and prints a manual `claude mcp add` command instead.
  (Previously a parse error was treated as an empty file, which would have wiped
  the user's config on write-back.)
- When the plugin **is** installed and a direct `mcpServers.nexusmind` entry also
  exists, setup warns about the duplicate registration with the removal command.
- Final Claude Code instructions now say "Restart Claude Code" instead of
  `source ~/.zshrc`, which is meaningless on Windows and no longer required.

## 0.5.0

Breaking: tool count reduced from 116 to 103 by consolidating overlapping read/write
tools into single, parameterized tools. All removed tools have a direct replacement
below — no functionality was dropped, only merged.

### Added

- Codex CLI support. `npx @smart-coder-labs/nexusmind-mcp setup` now offers Codex as
  a configure-for target: it runs `codex mcp add` when the `codex` binary is on
  `PATH` (falling back to a `config.toml` snippet otherwise), and writes
  memory-protocol hooks to `~/.codex/hooks.json` (`SessionStart`, `UserPromptSubmit`,
  `PostCompact`, `Stop`, `SubagentStop`) — merged into any existing file, never
  overwritten. Hook logic lives under `src/hooks/` as plain Node (no shell scripts),
  so it runs unmodified on macOS, Linux, and Windows. See the README's Codex CLI
  section for env vars, the `/hooks` trust-approval step, and coexistence notes with
  Codex's native Memories feature.

### Setup

- Claude Code registration is now handled exclusively by the NexusMind Claude plugin.
  `npx @smart-coder-labs/nexusmind-mcp setup` no longer writes an MCP server entry to
  `~/.claude.json` or auto-enables the plugin in `~/.claude/settings.json`; it detects
  whether the plugin is installed and prints `/plugin marketplace add` /
  `/plugin install` instructions when it isn't. Cursor's registration flow is unchanged.
- Setup now also detects a **legacy** `mcpServers.nexusmind` entry left behind in
  `~/.claude.json` by older versions of this tool (which used to write it directly).
  Since setup no longer touches that file, the entry was previously never cleaned up,
  silently causing duplicate MCP registration once the plugin was also installed.
  Setup prints a warning with the exact removal command (`claude mcp remove nexusmind`)
  but does not edit `~/.claude.json` automatically.

### Removed tools → replacement

| Removed tool | Replacement | Param mapping |
|---|---|---|
| `search_memory` | `search_memories` | `query`, `limit`, `collection_id`, `pinned`, `archived` → `include_archived` — all preserved (filtered client-side when `query` is set) |
| `search_memories_advanced` | `search_memories` | `query`, `tags`, `tag_mode`, `project`, `since`, `until`, `pinned`, `limit`, `include_archived` — all preserved |
| `list_memories` | `search_memories` (omit `query`) | `project`, `type`, `scope`, `tool`, `limit` — unchanged; `collection_id`/`include_archived` also forwarded server-side |
| `get_memory_timeline` | `search_memories` (omit `query`, set `sort: 'created_at'`) | `since`, `until` — unchanged; `limit` max (200) unchanged, but the default is now 20 instead of 50 |
| `get_session_memories` | `search_memories` (omit `query`) | `session_id` — unchanged; `limit` max (200) unchanged, but the default is now 20 instead of 50 |
| `get_project_context` | `get_context` | `project` — unchanged; use `mode: 'full'` (default) |
| `summarize_project` | `get_context` | `project`, `include_conventions`, `include_stats` — unchanged |
| `get_agent_dashboard` | `get_context` | no params → call with `include_stats: true, include_activity: true` |
| `get_agent_context` | `get_context` | no params → call with `include_stats: true` |
| `search_conventions` | `list_conventions` | `query`, `category`, `include_archived`, `project` — unchanged |
| `get_conventions_summary` | `list_conventions` | `category`, `project` → add `compact: true` |
| `memory_health_check` | `health_check` | no params — unchanged; `too_short` metric + up to 3 examples per issue restored in the fallback path |
| `quick_health_check` | `health_check` | no params — unchanged; fallback stale check restored to `updated_at ?? created_at` (was incorrectly `created_at`-only) |
| `merge_tags` | `rename_tag` | `source` → `old_tag`, `target` → `new_tag` (renaming to an existing tag merges the old one into it) |
| `smart_store_memory` | `store_memory` | `content`, `project`, `session_id` unchanged; `extra_tags` → `tags`; add `auto_tag: true` to get the same auto-detected tags |

### New/changed tool signatures

- **`search_memories`** (new, unified): `query?`, `project?`, `type?`, `scope?`,
  `session_id?`, `collection_id?`, `tool?`, `since?`, `until?`, `tags?`, `tag_mode?`
  (`'any' | 'all'`), `pinned?`, `include_archived?`, `sort?` (`'created_at'`, applies
  only when `query` is omitted), `limit` (default 20, max **200**, raised from 100 to
  match the max previously allowed by the absorbed `get_memory_timeline` /
  `get_session_memories` tools). Semantic search when `query` is present (filtered
  client-side over the top 100 ranked backend matches — narrow filters can under-return
  beyond that window), filtered list/browse when it's omitted (filters forwarded
  server-side where the backend supports them). `collection_id` and `tool` are new
  filters, both previously dropped by an earlier draft of this consolidation despite
  being listed as preserved — they are now implemented end-to-end.
- **`get_context`**: added `mode?` (`'compact' | 'full'`, default `'full'`),
  `include_stats?`, `include_activity?`. `'compact'` returns titles/one-liners with ids;
  `'full'` is the previous complete grouped-by-type detail.
- **`list_conventions`**: added `query?` (client-side title/content filter) and
  `compact?` (weight + title + 200-char snippet shape).
- **`store_memory`**: added `auto_tag?` boolean — runs the same regex-based content
  classification `smart_store_memory` used and merges the result into `tags`.
- **`onboard_agent`**: unchanged signature; internally now delegates to the same
  context builder `get_context` uses for its conventions/memories/stats section. This
  incidentally fixed a stats field-name bug in the old implementation, which read
  `active_projects`/`active_users` (fields that don't exist on the stats response) —
  `buildContext` correctly reads `total_code_projects`/`total_users`.
- **`check_policy`**: response fields beyond `allowed`/`reason`/`violations` (e.g. any
  extra metadata the backend returns) are now surfaced as a compact single-line JSON
  `Extra:` line instead of being silently dropped.

### Fixed

- `search_memories` in query mode (`query` present) no longer silently under-returns
  when only `project`/`type`/`scope`/`session_id`/`tool`/`collection_id`/`pinned`/
  `include_archived` filters are set without `since`/`until`/`tags` — any active filter
  now triggers fetching the backend max (100) before filtering client-side, matching
  the behavior already applied to date/tag filters.
- `search_memories` in list mode (no `query`) no longer filters archived memories
  client-side after already truncating the page to the requested limit; `include_archived`
  is now forwarded as a server-side query param, avoiding shrunken pages.
