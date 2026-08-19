# Changelog

## 0.15.0

### Added

- **Code-search tools in the curated registry** — `search_code` (semantic code chunks) and
  `get_symbol_context` (a symbol's chunk without opening the file), joining the existing
  `locate_code`. Exposed directly by `essential` (39 tools) and via `reduced_readonly`. Lets an
  agent read indexed code from NexusMind instead of grepping/opening files; measured a repeatable
  small win (-7% cost, fewer exploration turns) over tool-less Claude on a mature service. Requires
  the backend to have embeddings enabled (`NEXUSMIND_EMBED_ENABLED=true`) and the project indexed.

## 0.14.0

### Added

- **Repository-aware project and capability configuration.** The `essential` and
  `reduced_readonly` profiles can load `.nexusmind.yaml`, resolve the active NexusMind project from
  the working path, inherit agent profiles, and remove capabilities with `disable_capabilities`.
  Config parsing rejects unknown fields, invalid references, unsupported routing patterns, profile
  cycles, and secret-shaped keys. The legacy profile remains unchanged for compatibility.

## 0.13.0

### Added

- **`essential` profile is now daily-complete (37 direct tools).** Added the SDD and task
  tools the `sdd-*` and tasks skills invoke every phase — `save_sdd_artifact`, `get_sdd_artifact`,
  `get_sdd_artifact_by_key`, `get_sdd_change`, `update_sdd_change`, `link_sdd_change_memory`,
  `save_sdd_spec`, `get_sdd_spec`, `get_sdd_spec_by_capability`, plus `get_task`, `assign_task`,
  `add_task_comment`, `add_task_label`, `link_task_spec`, `resolve_tasks_for_spec` — to the curated
  registry (so both `essential` and `reduced_readonly` gain them). 0.12.0's `essential` was
  memory-centric and would have failed SDD/task skills with "tool not found". Still lean (37 vs the
  legacy 149) and direct (no fabric handshake), so the token profile is unchanged.

## 0.12.0

### Added

- **`essential` tool profile** (`NEXUSMIND_MCP_TOOL_PROFILE=essential` or `--tool-profile essential`).
  Exposes the ~22 curated tools (memory, conventions, tasks, SDD, projects/clients, usage, code)
  **directly** as MCP tools — one call per action. Unlike `reduced_readonly`, there is no
  `find_tools -> load_tool -> execute_tool` handshake, which measured as the dominant source of
  extra turns (and therefore tokens). In an A/B over three complex tasks, `essential` + a minimal
  usage protocol brought per-task consumption from +170% to **parity with tool-less Claude**
  (-63% vs `reduced_readonly`), with no quality loss. `reduced_readonly` and `legacy` are unchanged.

### Fixed

- **`reduced_readonly` returned zero tools to unassisted agents.** `find_tools`/`load_tool`/
  `execute_tool` filtered by a caller-supplied `permissions` list that defaults to `[]`, so every
  tool (all require >= `memory:read`) was filtered out and the whole profile looked empty. Empty
  now means "unspecified -> do not pre-filter, defer to the backend" (the real permission boundary);
  a non-empty list still pre-filters for a permission-aware host.

## 0.9.0

### Added

- **Seven SDD artifact tools** (`sdd-artifacts` change, PR-6) — the spec-driven-development
  document store as MCP tools. Additive; no existing tool changed.

  | Tool | Permission | Notes |
  |------|-----------|-------|
  | `save_sdd_artifact` | `sdd:write` | The write path. **Idempotent by content hash**: re-saving byte-identical content creates **no** revision, so every `sdd-*` skill may call it unconditionally on each phase run; edited content appends one. Creates the change when it does not exist — the save *is* the create. Content over 1 MB fails the call and writes nothing. |
  | `get_sdd_artifact` | `sdd:read` | The cross-phase read. Returns the **FULL document, never a preview** — `sdd-design` reads the proposal, `sdd-tasks` reads the spec + design. Addressable by artifact id or by `(project, change_name, kind, capability?)`; defaults to the latest revision and accepts an explicit one. A missing artifact reports not-found, never an empty string a caller could mistake for an empty design. |
  | `list_sdd_changes` | `sdd:read` | Metadata only, never content. Powers `/sdd-status`. |
  | `get_sdd_change` | `sdd:read` | The artifact inventory *is* the recoverable DAG state — resume a change with no checkout. Powers `/sdd-continue`. |
  | `update_sdd_change` | `sdd:write` | Phase/status transitions. An invalid phase is rejected atomically; an unknown change reports not-found and is never created as a side effect. |
  | `search_sdd_artifacts` | `sdd:read` | FTS across every change in the org; hits carry the natural key to feed straight to `get_sdd_artifact`. |
  | `link_sdd_change_memory` | `sdd:write` | Ties the decisions `sdd-apply` / `sdd-verify` record back to the change. Idempotent per `(change, memory)` pair. |

  All seven are thin wrappers over `/v1/sdd/*` and add **no authority** beyond the calling
  API key's existing `sdd:*` grants — the backend enforces, the tools only surface a denial
  as a tool failure. There is no `create_sdd_change` (the save is the create) and no
  `delete_sdd_change` (archival is admin/API-only).

## 0.8.3

### Fixed

- **`setup` now actually installs the Claude Code plugin instead of only
  printing the commands.** Since commit `e785bd1` (2026-07-01), `installClaudeCode`
  only logged `/plugin marketplace add …` / `/plugin install …` as text for the
  user to run by hand — it never spawned them. Because every Claude Code
  lifecycle hook (`SessionStart`, `UserPromptSubmit`, `PreCompact`,
  `PostCompact`, `Stop`, `SubagentStop`) ships exclusively inside that plugin,
  this meant **no Claude Code user ever got hooks, on any platform** (confirmed
  on both macOS and Linux — `installed_plugins.json` never gained a
  `nexusmind@nexusmind` entry from setup). Codex was unaffected; its
  `registerCodexMcp` path already used a real `spawnSync` call. `setup` now
  runs `claude plugin marketplace add smart-coder-labs/nexusmind-claude-plugin
  --scope user` followed by `claude plugin install nexusmind@nexusmind --scope
  user` when the `claude` CLI is available, falling back to the previous
  direct-`~/.claude.json`-registration + printed-instructions behavior only if
  the CLI is missing or either step fails.
- **Credentials are now written to `~/.claude/settings.json`'s `env` block.**
  The plugin's `.mcp.json` refers to `${NEXUSMIND_API_KEY}` /
  `${NEXUSMIND_BASE_URL}`, and until now setup only exported those from shell rc
  files — which are unreliable: `~/.zshrc` / `~/.bashrc` frequently do not exist
  at all (setup's `writeShellEnv` silently writes nothing in that case), and a
  GUI-launched Claude Code does not inherit them even when they do. With no
  value and no default, Claude Code fails to parse the MCP config outright. This
  is the same class of bug already documented for Windows — the macOS/Linux
  flavor of it. Setup now also merges both variables into the `env` block of
  `~/.claude/settings.json`, documented as *"Environment variables applied to
  every session and to subprocesses Claude Code spawns from it"* — MCP servers
  are exactly such subprocesses. It is plain JSON read by the Claude Code binary,
  with no shell involved, so it works the same on macOS, Linux and Windows. The
  existing shell-rc export is kept for Cursor and plain-CLI usage.
- **Legacy duplicate `~/.claude.json` entry is now removed automatically** — but
  only when the plugin was installed successfully in that same run **and** the
  `env` block above was written successfully. Both conditions are required: on a
  machine with no shell rc file, that entry's literal credential values are the
  *only* working registration, so removing it before a working env source exists
  would leave the plugin's `${...}` placeholders unresolvable and break the MCP
  server entirely. If the `env` write fails, setup keeps the entry — or writes a
  literal-valued one when none exists — so the MCP server keeps working, and it
  no longer suggests `claude mcp remove nexusmind` in that state. When the plugin
  is merely *detected* as already installed, setup only warns about the duplicate
  and never deletes it: that detection reads `installed_plugins.json`, which
  records what was installed rather than that it still works. The invariant is
  that setup never returns leaving the user with zero working MCP registrations. When setup installs the plugin itself, it now
  deletes the leftover direct `mcpServers.nexusmind` entry (written by an old
  setup version, or by setup's own fallback path), which would otherwise
  duplicate the plugin's MCP registration and load every tool twice. This
  removal happens **only** when the plugin was installed successfully in that
  same run. When the plugin is merely *detected* as already installed, setup
  still only warns and prints `claude mcp remove nexusmind` — that detection
  reads `installed_plugins.json`, which records what was installed rather than
  that it still works, and deleting a working direct registration on the
  strength of a possibly-stale record could leave the user with no MCP
  registration at all.

## 0.8.2

### Fixed

- **Codex hooks now spawn on Windows.** The generated `hooks.json` wrote the
  Windows command override as `command_windows` (snake_case); Codex's schema is
  camelCase (`commandWindows`), so it was ignored and Codex fell back to
  `command`, which it spawns directly (no shell) and could not parse because the
  node path contains a space (`C:\Program Files\nodejs\node.exe`). The hook
  process never started and Codex reported every hook as "Failed" with no way to
  approve it. `hookCommand` now emits `commandWindows` using 8.3 short paths
  (`C:\PROGRA~1\…`) for both the node binary and the hook-runtime dir, so the
  command tokenizes with no spaces or quotes. Upgrading changes each hook's
  hash, so Codex requires re-approval via `/hooks` once.

## 0.8.1

### Added

- **`doctor` command** — `npx @smart-coder-labs/nexusmind-mcp doctor` diagnoses
  the common Windows failures: it prints the API key the current process sees
  vs. the Windows user registry vs. the Codex `config.toml`, flags stale or
  mismatched values, verifies the server can be launched via npx, and
  live-validates the key against the backend.
- **npx cache self-heal.** A corrupted npx cache made `npx -y <pkg>@latest` fail
  to resolve the server bin (`'nexusmind-mcp' is not recognized`), which clients
  surfaced only as an opaque MCP "connection closed: initialize response".
  `setup` and `doctor` now probe the launch (via a new instant `smoke`
  subcommand) and clear the npx cache automatically when it is broken.

### Fixed

- **Live credential + env checks in `setup`.** Setup now validates the entered
  key against the backend and warns when a different `NEXUSMIND_API_KEY` is
  already active in the environment (a stale value that `setx` cannot update in
  already-running clients — restart required).

## 0.8.0

### Added

- **Team Tasks — agent pull tools.** 13 new MCP tools as thin permissioned
  wrappers over the backend task API: `list_my_tasks`, `list_tasks`,
  `get_task`, `create_task`, `update_task`, `delete_task` (confirm-guarded,
  same pattern as `delete_memory`), `assign_task`, `add_task_comment`,
  `add_task_label`, `link_task_spec`, `resolve_tasks_for_spec`,
  `list_sprints`, `create_sprint`. Every tool inherits the caller's existing
  `task:*` permission grants server-side — no client-side authority is added.
  `list_my_tasks` resolves "me" from the caller's `NEXUSMIND_API_KEY`
  server-side; it never accepts a user id argument.
- **`create_sprint_retrospective` repurposed** to persist a real
  `SprintRetrospective` via `POST /v1/sprints/:id/retrospectives` instead of
  its previous behavior (aggregating recent memories client-side into a
  formatted markdown summary, persisting nothing). The tool name and general
  purpose are unchanged; the input/output shape changed to `sprint_id` +
  retro fields. `generate_daily_standup` is untouched.
- **SessionStart hook — pending-task reminder.** The existing SessionStart
  hook now also fetches the caller's pending tasks (any status other than
  `done`/`cancelled`) for the active project and injects a short reminder
  block (up to 5 tasks, then "…and N more"). Silent when there are zero
  pending tasks or the backend call fails — never blocks session start.

## 0.6.2

### Fixed

- Setup never set the NexusMind environment variables on Windows. `writeShellEnv`
  only appended `export` lines to `~/.zshrc` / `~/.bashrc`, which don't exist on
  Windows — so `NEXUSMIND_BASE_URL` (and often `NEXUSMIND_API_KEY`) stayed unset,
  and every client that expands the `${NEXUSMIND_BASE_URL}` placeholder in its MCP
  config (the Claude plugin's `.mcp.json`, Cursor's `mcp.json`) failed with
  "Invalid MCP server config … Missing environment variables: NEXUSMIND_BASE_URL".
  Env writing is now platform-dispatched: on Windows setup persists both vars to
  the per-user environment via `setx` (falling back to a printed manual command if
  that fails); POSIX behavior is unchanged. Re-run
  `npx @smart-coder-labs/nexusmind-mcp setup` and restart your client.

### CI / tests

- Added a GitHub Actions matrix (`.github/workflows/ci.yml`) running the full
  suite on Ubuntu, macOS, and Windows across Node 20 and 22.
- `npm test` previously ran **zero** tests — Node's test runner does not discover
  `.ts` files, so `tsx --test` matched nothing and passed vacuously. The `test`
  script now names the test files explicitly and a `pretest` step builds first.
- The hook subprocess tests spawned the `node_modules/.bin/tsx` shim directly,
  which is not spawnable on Windows (`spawn ENOENT`); they now run the hook via
  `node --import tsx <script>`, which is OS-portable.
- New integration test executes every compiled hook as a real subprocess and
  asserts it loads as ESM and exits 0 — guarding the 0.6.1 `SyntaxError` regression
  on each OS in the matrix.

## 0.6.1

### Fixed

- Codex CLI hooks crashed on every event with `SyntaxError: Cannot use import
  statement outside a module` (exit 1), so the memory protocol never fired. The
  compiled hook runtime (`hooks/*.js` + `client.js`) is ES-module code, but
  `copyHookRuntime()` copied it into `~/.nexusmind/hook-runtime/` without a
  `package.json` — so Node defaulted those bare `.js` files to CommonJS and threw
  at load before any handler ran. Setup now writes a `package.json` with
  `{ "type": "module" }` into the runtime dir alongside the copied files, so Node
  loads them as ESM. Re-run `npx @smart-coder-labs/nexusmind-mcp setup` (or just
  the Codex target) to refresh the runtime dir.

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
