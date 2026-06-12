#!/usr/bin/env bash
# user-prompt-submit.sh — NexusMind Claude Code plugin: UserPromptSubmit hook
# Emits a 5-part system message on EVERY prompt with session + project memories
# and a behavioral mandate. No first-call / periodic gating.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_helpers.sh
source "${SCRIPT_DIR}/_helpers.sh"

# Parse stdin
INPUT="$(cat)"
cwd="$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null || true)"

# Guard
if [[ -z "${NEXUSMIND_API_KEY:-}" ]]; then
  exit 0
fi

NEXUSMIND_BASE_URL="${NEXUSMIND_BASE_URL:-https://nexusmind-backend.fly.dev}"

# Project detection
if [[ -n "$cwd" ]]; then
  pushd "$cwd" &>/dev/null || true
fi
PROJECT="$(detect_project)"
if [[ -n "$cwd" ]]; then
  popd &>/dev/null || true
fi

# Section 1: last 5 recent memories
RECENT_BLOCK="(none)"
RECENT_JSON="$(curl -sf --max-time 5 \
  -H "Authorization: Bearer ${NEXUSMIND_API_KEY}" \
  "${NEXUSMIND_BASE_URL}/v1/memory?limit=5" 2>/dev/null || true)"
if [[ -n "$RECENT_JSON" ]]; then
  PARSED="$(echo "$RECENT_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    items = data if isinstance(data, list) else data.get('memories', data.get('items', data.get('data', [])))
    lines = []
    for m in items[:5]:
        t = m.get('type') or 'general'
        title = m.get('title') or (m.get('content','').split('\n')[0][:120])
        lines.append(f'- [{t}] {title}')
    print('\n'.join(lines))
except Exception:
    pass
" 2>/dev/null || true)"
  if [[ -n "$PARSED" ]]; then RECENT_BLOCK="$PARSED"; fi
fi

# Section 2: last 5 project-specific memories (via search)
PROJECT_BLOCK="(none)"
PROJECT_JSON="$(curl -sf --max-time 5 \
  -X POST \
  -H "Authorization: Bearer ${NEXUSMIND_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"${PROJECT}\", \"limit\": 5}" \
  "${NEXUSMIND_BASE_URL}/v1/memory/search" 2>/dev/null || true)"
if [[ -n "$PROJECT_JSON" ]]; then
  PARSED="$(echo "$PROJECT_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    items = data if isinstance(data, list) else data.get('memories', data.get('items', data.get('data', [])))
    lines = []
    for m in items[:5]:
        t = m.get('type') or 'general'
        title = m.get('title') or (m.get('content','').split('\n')[0][:120])
        lines.append(f'- [{t}] {title}')
    print('\n'.join(lines))
except Exception:
    pass
" 2>/dev/null || true)"
  if [[ -n "$PARSED" ]]; then PROJECT_BLOCK="$PARSED"; fi
fi

# Build the 5-part message
MESSAGE="$(cat <<EOF
## NexusMind — Per-Prompt Protocol (project: ${PROJECT})

### 1) Recent session memories
\`\`\`nexusmind-recent
${RECENT_BLOCK}
\`\`\`

### 2) Project-specific memories — ${PROJECT}
\`\`\`nexusmind-project
${PROJECT_BLOCK}
\`\`\`

### 3) MANDATORY behavioral rule
MANDATORY: call \`search_memory\` with keywords from this message before responding if the message references existing work. Save any decision you make to NexusMind. Do not skip this.

### 4) Save reminder
After completing any decision, bug fix, or non-obvious discovery, call \`store_memory\` BEFORE moving on.

### 5) Format hint
When you call \`store_memory\`, always set \`type\`, always set \`title\`, always set \`project\`.
EOF
)"

# Emit as a single JSON object via stdout
python3 -c "
import json, sys
print(json.dumps({'systemMessage': sys.argv[1]}))
" "$MESSAGE"
