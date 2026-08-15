# Compatibility

## Profiles

The default `dist/index.js` entrypoint is the legacy MCP profile and registers 136 tools.
Current Claude Code, Cursor, and Codex integrations continue to use this profile. It is
selected when `NEXUSMIND_MCP_TOOL_PROFILE` is unset or set to `legacy`.

`reduced_readonly` is an opt-in profile for hosts that support progressive disclosure:

```bash
NEXUSMIND_MCP_TOOL_PROFILE=reduced_readonly npx @smart-coder-labs/nexusmind-mcp@latest
# or
npx @smart-coder-labs/nexusmind-mcp@latest --tool-profile reduced_readonly
```

It exposes only `find_tools`, `load_tool`, `execute_tool`, and `fetch`. The current reduced
registry contains only explicitly mapped read operations. Unmapped tools are omitted rather
than executed through a generic dispatcher; use the legacy profile for them.

## Host Matrix

| Host | Default profile | Reduced profile | Verification status |
|---|---|---|---|
| Claude Code | Supported | Not run against a real host | MCP process verified with SDK client |
| Cursor | Supported | Not run against a real host | MCP process verified with SDK client |
| Codex CLI | Supported | Not run against a real host | MCP process verified with SDK client |

This implementation is the client-side compatibility layer for Context Fabric backend PR
#248. NX-Gold Tool Search is intentionally pending until real hosts exercise discovery and
progressive disclosure end to end.

## Security Limits

Tool and result handles are random, process-local, permission-bound, and TTL-expiring. They
are lost on restart because no persistence is used yet. Schemas are returned only after an
authorized `load_tool`; discovery never includes them. Metrics exclude arguments and result
content. Writes and deletes are rejected in the reduced profile.
