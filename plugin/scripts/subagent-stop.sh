#!/usr/bin/env bash
# subagent-stop.sh — NexusMind Claude Code plugin: SubagentStop hook (async)
# Quality-gated passive capture: only stores outputs that contain decision-like
# keywords. Both Claude plugin repos ship this file byte-identical.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_helpers.sh
source "${SCRIPT_DIR}/_helpers.sh"

if [[ -z "${NEXUSMIND_API_KEY:-}" ]]; then
  exit 0
fi

INPUT="$(cat)"
subagent_output="$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('stdout', ''))
except Exception:
    pass
" 2>/dev/null || true)"

# Skip very short outputs
if [[ -z "$subagent_output" || "${#subagent_output}" -lt 100 ]]; then
  exit 0
fi

# Quality gate: must contain at least one decision-like keyword
KEYWORD_RE='decided|decision|fixed|error|warning|convention|architecture|discovered|discovery|issue|solution|implemented|changed|added|removed|refactored|pattern|config|gotcha|caveat|note|important'
if ! echo "$subagent_output" | grep -iEq "$KEYWORD_RE"; then
  exit 0
fi

NEXUSMIND_BASE_URL="${NEXUSMIND_BASE_URL:-https://nexusmind-backend.fly.dev}"
PROJECT="$(detect_project)"

PAYLOAD="$(python3 -c "
import json, sys
content = sys.argv[1]
project = sys.argv[2]
if len(content) > 2000:
    content = content[:2000] + '... [truncated]'
print(json.dumps({
    'title': 'Subagent: ' + project,
    'content': content,
    'type': 'discovery',
    'tool': 'claude-code-subagent',
    'project': project,
}))
" "$subagent_output" "$PROJECT" 2>/dev/null || true)"

if [[ -n "$PAYLOAD" ]]; then
  curl -sf --max-time 10 \
    -X POST \
    -H "Authorization: Bearer ${NEXUSMIND_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "${NEXUSMIND_BASE_URL}/v1/memory/store" &>/dev/null || true
fi

exit 0
