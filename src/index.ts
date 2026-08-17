#!/usr/bin/env node

// Legacy remains the default entrypoint. The reduced profile is opt-in so hosts
// that only implement tools/list/tools/call keep the existing 136-tool catalog.
const profileArg = process.argv.indexOf('--tool-profile')
const cliProfile = profileArg >= 0 ? process.argv[profileArg + 1] : undefined
const profile = process.env.NEXUSMIND_MCP_TOOL_PROFILE ?? cliProfile
if (profile === 'essential') {
  const { startEssential } = await import('./essential.js')
  await startEssential()
} else if (profile === 'reduced_readonly') {
  const { startReducedReadonly } = await import('./reduced.js')
  await startReducedReadonly()
} else {
  await import('./legacy.js')
}
