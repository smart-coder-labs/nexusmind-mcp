#!/usr/bin/env node

// `essential` is the default entrypoint: the legacy catalog publishes 148 tool
// definitions (~24k tokens) into every client session, while the essential cut
// covers the same workflows in ~4k. Legacy stays available as an explicit opt-in.
const profileArg = process.argv.indexOf('--tool-profile')
const cliProfile = profileArg >= 0 ? process.argv[profileArg + 1] : undefined
const requestedProfile = process.env.NEXUSMIND_MCP_TOOL_PROFILE ?? cliProfile
// An unknown profile must not fall through to the legacy catalog. Legacy is the
// WIDEST surface, so a typo (`only-context` for `only_context`) on a deployment
// that bought the narrow cut would expose everything the cut exists to hide.
const KNOWN_PROFILES = ['legacy', 'essential', 'reduced_readonly', 'only_context']
if (requestedProfile !== undefined && !KNOWN_PROFILES.includes(requestedProfile)) {
  throw new Error(`Unknown NEXUSMIND_MCP_TOOL_PROFILE "${requestedProfile}". Expected one of: ${KNOWN_PROFILES.join(', ')}`)
}
const profile = requestedProfile ?? 'essential'
const valueAfter = (flag: string): string | undefined => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined }
let activeDefinitions
if (profile === 'essential' || profile === 'reduced_readonly' || profile === 'only_context') {
  const { definitions } = await import('./reduced.js')
  // only_context is the curated registry cut down to context tools. The cut is
  // applied BEFORE the repository config's capability filter so a project that
  // disables a capability narrows the profile rather than tripping its
  // missing-tool check.
  const base = profile === 'only_context' ? (await import('./only-context.js')).selectOnlyContext(definitions) : definitions
  const { loadRepositoryConfig, effectiveCapabilities, filterDefinitions, resolveProject, repositoryRelativePath } = await import('./repository-config.js')
  const loaded = loadRepositoryConfig(valueAfter('--config'))
  const explicitProject = valueAfter('--project')
  if (explicitProject && loaded && !loaded.config.projects[explicitProject]) throw new Error(`CONFIG_INVALID_REFERENCE: ${explicitProject}`)
  const selected = loaded && (explicitProject ? { alias: explicitProject, project: loaded.config.projects[explicitProject] } : resolveProject(loaded.config, repositoryRelativePath(loaded.root, valueAfter('--working-path') ?? process.cwd())))
  const agentProfile = valueAfter('--agent-profile') ?? selected?.project?.agent_profile ?? loaded?.config.defaults?.agent_profile
  activeDefinitions = agentProfile && loaded ? filterDefinitions(base, effectiveCapabilities(loaded.config, agentProfile)) : base
}
if (profile === 'essential') {
  const { startEssential } = await import('./essential.js')
  await startEssential(activeDefinitions)
} else if (profile === 'only_context') {
  const { startEssential } = await import('./essential.js')
  await startEssential(activeDefinitions, 'nexusmind-only-context')
} else if (profile === 'reduced_readonly') {
  const { startReducedReadonly } = await import('./reduced.js')
  await startReducedReadonly(activeDefinitions)
} else {
  await import('./legacy.js')
}
