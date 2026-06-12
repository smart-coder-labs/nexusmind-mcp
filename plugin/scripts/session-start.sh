#!/usr/bin/env bash
# session-start.sh — NexusMind Claude Code plugin: SessionStart hook
# Emits additionalContext with project search + recency + full protocol body.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_helpers.sh
source "${SCRIPT_DIR}/_helpers.sh"

INPUT="$(cat)"
cwd="$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null || true)"

NEXUSMIND_BASE_URL="${NEXUSMIND_BASE_URL:-https://nexusmind-backend.fly.dev}"

# Guard: API key
if [[ -z "${NEXUSMIND_API_KEY:-}" ]]; then
  cat <<'EOF'
<!-- NexusMind NOT CONNECTED: NEXUSMIND_API_KEY is not set. Memory tools will not be available.
     Run: export NEXUSMIND_API_KEY=<your-key>
     Then restart Claude Code. -->
EOF
  exit 0
fi

# Guard: backend health
if ! curl -sf --max-time 5 "${NEXUSMIND_BASE_URL}/v1/health" &>/dev/null; then
  cat <<'EOF'
<!-- NexusMind NOT CONNECTED: backend is unreachable. Memory tools will not be available.
     Check NEXUSMIND_BASE_URL or your network connection. -->
EOF
  exit 0
fi

# Project detection
if [[ -n "$cwd" ]]; then
  pushd "$cwd" &>/dev/null || true
fi
PROJECT="$(detect_project)"
if [[ -n "$cwd" ]]; then
  popd &>/dev/null || true
fi

format_memories() {
  python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    items = data if isinstance(data, list) else data.get('memories', data.get('items', data.get('data', [])))
    lines = []
    for m in items[:int(sys.argv[1])]:
        t = (m.get('type') or 'general')
        title = m.get('title') or (m.get('content','').split('\n')[0][:120].replace('\n',' '))
        lines.append(f'- [{t}] {title}')
    print('\n'.join(lines))
except Exception:
    pass
" "$1"
}

# Project-specific search
PROJECT_BLOCK=""
PROJECT_JSON="$(curl -sf --max-time 8 \
  -X POST \
  -H "Authorization: Bearer ${NEXUSMIND_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"${PROJECT}\", \"limit\": 15}" \
  "${NEXUSMIND_BASE_URL}/v1/memory/search" 2>/dev/null || true)"
if [[ -n "$PROJECT_JSON" ]]; then
  PROJECT_BLOCK="$(echo "$PROJECT_JSON" | format_memories 15)"
fi

# Recency list
RECENT_BLOCK=""
RECENT_JSON="$(curl -sf --max-time 8 \
  -H "Authorization: Bearer ${NEXUSMIND_API_KEY}" \
  "${NEXUSMIND_BASE_URL}/v1/memory?limit=15" 2>/dev/null || true)"
if [[ -n "$RECENT_JSON" ]]; then
  RECENT_BLOCK="$(echo "$RECENT_JSON" | format_memories 10)"
fi

# Full protocol body
cat <<PROTOCOL
## NexusMind — ACTIVE PROTOCOL (project: ${PROJECT})

NexusMind is the single source of truth for this codebase. Before guessing, check it. Before finishing, save to it.

### Tools available
store_memory — save decisions, bugs, discoveries, conventions PROACTIVELY (do not wait to be asked)
search_memory — first action on any prompt that references prior work
list_memories — utility browse
get_context — bootstrap a significant session
get_memory — full untruncated content by id (previews are not enough)
delete_memory — only when the user explicitly asks; requires confirm: true

### PROACTIVE SAVE RULE
Call store_memory IMMEDIATELY after ANY decision, bug fix, discovery, or convention — not just when asked.
Always pass tool="claude-code" and project="${PROJECT}".

ALWAYS set \`type\` — pick the closest match:
- architecture — design decisions, patterns, system structure
- bugfix — bug fixes (include root cause)
- decision — explicit choices made (library, approach, tradeoff)
- discovery — non-obvious findings, gotchas, edge cases
- config — environment, tooling, infrastructure changes
- pattern — naming conventions, code patterns, team standards
- feedback — user corrections or confirmations of your approach
- preference — user style or workflow preferences
- session_summary — end-of-session summary
- feature — completed feature implementations
- refactoring — structural code changes without behavior change

ALWAYS provide \`title\` — short (5-10 word) searchable title.
Use \`topic_key\` for evolving topics — same key updates existing memory instead of creating a duplicate.

### WHEN TO SEARCH
- User's FIRST message references a feature or problem → search_memory with keywords BEFORE responding
- Starting work on something that might have been done before → search_memory
- User asks to recall anything → search_memory
- About to make a non-trivial decision → search_memory first

### SESSION CLOSE (MANDATORY)
Before saying "done", call store_memory with type="session_summary":
- What was accomplished
- Key decisions and why
- Files changed
- Next steps

This is NOT optional. If you skip this, the next session starts blind.

### AFTER COMPACTION
1. IMMEDIATELY call store_memory with type="session_summary" and the compacted content.
2. Call search_memory(query: "${PROJECT}") to recover broader context.
3. Only THEN continue working.
PROTOCOL

if [[ -n "$PROJECT_BLOCK" ]]; then
  cat <<EOF

### Project Memories — ${PROJECT}
${PROJECT_BLOCK}
EOF
fi

if [[ -n "$RECENT_BLOCK" ]]; then
  cat <<EOF

### Recent Team Memories (last 10)
${RECENT_BLOCK}
EOF
fi
