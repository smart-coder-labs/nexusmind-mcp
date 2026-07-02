# Changelog

## 0.5.0

Breaking: tool count reduced from 116 to 103 by consolidating overlapping read/write
tools into single, parameterized tools. All removed tools have a direct replacement
below — no functionality was dropped, only merged.

### Setup

- Claude Code registration is now handled exclusively by the NexusMind Claude plugin.
  `npx @smart-coder-labs/nexusmind-mcp setup` no longer writes an MCP server entry to
  `~/.claude.json` or auto-enables the plugin in `~/.claude/settings.json`; it detects
  whether the plugin is installed and prints `/plugin marketplace add` /
  `/plugin install` instructions when it isn't. Cursor's registration flow is unchanged.

### Removed tools → replacement

| Removed tool | Replacement | Param mapping |
|---|---|---|
| `search_memory` | `search_memories` | `query`, `limit`, `collection_id`, `pinned`, `archived` → `include_archived` |
| `search_memories_advanced` | `search_memories` | `query`, `tags`, `tag_mode`, `project`, `since`, `until`, `pinned`, `limit`, `include_archived` — all unchanged |
| `list_memories` | `search_memories` (omit `query`) | `project`, `type`, `scope`, `tool`, `limit` — unchanged |
| `get_memory_timeline` | `search_memories` (omit `query`, set `sort: 'created_at'`) | `since`, `until`, `limit` — unchanged |
| `get_session_memories` | `search_memories` (omit `query`) | `session_id`, `limit` — unchanged |
| `get_project_context` | `get_context` | `project` — unchanged; use `mode: 'full'` (default) |
| `summarize_project` | `get_context` | `project`, `include_conventions`, `include_stats` — unchanged |
| `get_agent_dashboard` | `get_context` | no params → call with `include_stats: true, include_activity: true` |
| `get_agent_context` | `get_context` | no params → call with `include_stats: true` |
| `search_conventions` | `list_conventions` | `query`, `category`, `include_archived`, `project` — unchanged |
| `get_conventions_summary` | `list_conventions` | `category`, `project` → add `compact: true` |
| `memory_health_check` | `health_check` | no params — unchanged |
| `quick_health_check` | `health_check` | no params — unchanged |
| `merge_tags` | `rename_tag` | `source` → `old_tag`, `target` → `new_tag` (renaming to an existing tag merges the old one into it) |
| `smart_store_memory` | `store_memory` | `content`, `project`, `session_id` unchanged; `extra_tags` → `tags`; add `auto_tag: true` to get the same auto-detected tags |

### New/changed tool signatures

- **`search_memories`** (new, unified): `query?`, `project?`, `type?`, `scope?`,
  `session_id?`, `since?`, `until?`, `tags?`, `tag_mode?` (`'any' | 'all'`), `pinned?`,
  `include_archived?`, `sort?` (`'created_at'`), `limit` (default 20, max 100). Semantic
  search when `query` is present, filtered list/browse when it's omitted.
- **`get_context`**: added `mode?` (`'compact' | 'full'`, default `'full'`),
  `include_stats?`, `include_activity?`. `'compact'` returns titles/one-liners with ids;
  `'full'` is the previous complete grouped-by-type detail.
- **`list_conventions`**: added `query?` (client-side title/content filter) and
  `compact?` (weight + title + 200-char snippet shape).
- **`store_memory`**: added `auto_tag?` boolean — runs the same regex-based content
  classification `smart_store_memory` used and merges the result into `tags`.
- **`onboard_agent`**: unchanged signature; internally now delegates to the same
  context builder `get_context` uses for its conventions/memories/stats section.
