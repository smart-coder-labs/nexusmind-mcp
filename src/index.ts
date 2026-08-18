#!/usr/bin/env node

// Legacy remains the default entrypoint. The reduced profile is opt-in so hosts
// that only implement tools/list/tools/call keep the existing 136-tool catalog.
const profileArg = process.argv.indexOf('--tool-profile')
const cliProfile = profileArg >= 0 ? process.argv[profileArg + 1] : undefined
const profile = process.env.NEXUSMIND_MCP_TOOL_PROFILE ?? cliProfile
const valueAfter = (flag: string): string | undefined => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined }
let activeDefinitions
if (profile === 'essential' || profile === 'reduced_readonly') {
  const { definitions } = await import('./reduced.js')
  const { loadRepositoryConfig, effectiveCapabilities, filterDefinitions, resolveProject, repositoryRelativePath } = await import('./repository-config.js')
  const loaded = loadRepositoryConfig(valueAfter('--config'))
  const explicitProject = valueAfter('--project')
  if (explicitProject && loaded && !loaded.config.projects[explicitProject]) throw new Error(`CONFIG_INVALID_REFERENCE: ${explicitProject}`)
  const selected = loaded && (explicitProject ? { alias: explicitProject, project: loaded.config.projects[explicitProject] } : resolveProject(loaded.config, repositoryRelativePath(loaded.root, valueAfter('--working-path') ?? process.cwd())))
  const agentProfile = valueAfter('--agent-profile') ?? selected?.project?.agent_profile ?? loaded?.config.defaults?.agent_profile
  activeDefinitions = agentProfile && loaded ? filterDefinitions(definitions, effectiveCapabilities(loaded.config, agentProfile)) : definitions
}
if (profile === 'essential') {
  const { startEssential } = await import('./essential.js')
  await startEssential(activeDefinitions)
} else if (profile === 'reduced_readonly') {
  const { startReducedReadonly } = await import('./reduced.js')
  await startReducedReadonly(activeDefinitions)
} else {
  await import('./legacy.js')
}
