import { readFileSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseDocument } from 'yaml'
import type { ToolDefinition } from './tool-fabric.js'

const KNOWN = new Set(['context.read','memory.read','memory.write','convention.read','convention.write','project.read','client.read','task.read','task.write','sdd.read','sdd.write','code.read','usage.read','usage.write','migration.run','migration.review','harness.read','harness.write'])

type Project = { project_id: string; client_id?: string; paths: string[]; exclude?: string[]; agent_profile?: string }
type Profile = { extends?: string; capabilities?: string[]; disable_capabilities?: string[] }
export type RepositoryConfig = { version: number; repository: { id: string }; defaults?: { project?: string; agent_profile?: string }; projects: Record<string, Project>; agents?: { profiles: Record<string, Profile> } }

export function loadRepositoryConfig(explicit?: string, cwd = process.cwd()): { config: RepositoryConfig; path: string; root: string } | undefined {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
  let path = explicit ? resolve(cwd, explicit) : undefined
  if (!path) {
    let cursor = resolve(cwd)
    while (cursor.startsWith(root)) {
      const candidate = join(cursor, '.nexusmind.yaml')
      try { readFileSync(candidate); path = candidate; break } catch { /* continue */ }
      if (cursor === root) break
      cursor = dirname(cursor)
    }
  }
  if (!path) return undefined
  const configRelative = relative(root, path)
  if (configRelative === '' || (!configRelative.startsWith('..') && !isAbsolute(configRelative))) {
    const doc = parseDocument(readFileSync(path, 'utf8'), { uniqueKeys: true, merge: false })
    if (doc.errors.length) throw new Error(`CONFIG_INVALID_SCHEMA: ${doc.errors[0].message}`)
    const config = doc.toJS() as RepositoryConfig
    validate(config)
    return { config, path, root }
  }
  throw new Error('CONFIG_OUTSIDE_REPOSITORY')
}

function validate(config: RepositoryConfig): void {
  rejectSensitiveKeys(config)
  if (config.version !== 1) throw new Error('CONFIG_UNSUPPORTED_VERSION')
  if (!config.repository?.id || !config.projects || Object.keys(config.projects).length === 0) throw new Error('CONFIG_INVALID_SCHEMA')
  const allowedRoot = new Set(['version','repository','defaults','projects','agents'])
  for (const key of Object.keys(config as object)) if (!allowedRoot.has(key)) throw new Error(`CONFIG_INVALID_SCHEMA: unknown field ${key}`)
  assertKnownKeys(config.repository, new Set(['id']), 'repository')
  if (config.defaults) assertKnownKeys(config.defaults, new Set(['project','agent_profile']), 'defaults')
  for (const [alias, project] of Object.entries(config.projects)) {
    assertKnownKeys(project, new Set(['project_id','client_id','paths','exclude','agent_profile']), `projects.${alias}`)
    if (!project.project_id || !project.paths?.length) throw new Error(`CONFIG_INVALID_SCHEMA: project ${alias}`)
    for (const pattern of [...project.paths, ...(project.exclude ?? [])]) validatePattern(pattern)
  }
  const profiles = config.agents?.profiles ?? {}
  if (config.agents) assertKnownKeys(config.agents, new Set(['profiles']), 'agents')
  for (const [name, profile] of Object.entries(profiles)) {
    assertKnownKeys(profile, new Set(['extends','capabilities','disable_capabilities']), `agents.profiles.${name}`)
    for (const cap of [...(profile.capabilities ?? []), ...(profile.disable_capabilities ?? [])]) if (!KNOWN.has(cap)) throw new Error(`CONFIG_UNKNOWN_CAPABILITY: ${cap}`)
    effectiveCapabilities(config, name)
  }
  if (config.defaults?.project && !config.projects[config.defaults.project]) throw new Error(`CONFIG_INVALID_REFERENCE: ${config.defaults.project}`)
  if (config.defaults?.agent_profile && !profiles[config.defaults.agent_profile]) throw new Error(`CONFIG_INVALID_REFERENCE: ${config.defaults.agent_profile}`)
  for (const project of Object.values(config.projects)) if (project.agent_profile && !profiles[project.agent_profile]) throw new Error(`CONFIG_INVALID_REFERENCE: ${project.agent_profile}`)
}

function assertKnownKeys(value: object, allowed: Set<string>, location: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`CONFIG_INVALID_SCHEMA: unknown field ${location}.${key}`)
}

function rejectSensitiveKeys(value: unknown): void {
  const sensitive = /^(secret|token|password|api[_-]?key|private[_-]?key|credential)s?$/i
  if (Array.isArray(value)) return value.forEach(rejectSensitiveKeys)
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (sensitive.test(key)) throw new Error(`CONFIG_SECRET_FIELD_FORBIDDEN: ${key}`)
    rejectSensitiveKeys(child)
  }
}

export function repositoryRelativePath(root: string, workingPath: string): string {
  const absolute = resolve(process.cwd(), workingPath)
  const candidate = relative(root, absolute).replaceAll('\\', '/')
  if (candidate === '' || candidate === '.') return '.'
  if (candidate.startsWith('..') || isAbsolute(candidate)) throw new Error('WORKING_PATH_OUTSIDE_REPOSITORY')
  return candidate
}

export function effectiveCapabilities(config: RepositoryConfig, name: string, stack: string[] = []): Set<string> {
  if (stack.includes(name)) throw new Error(`CONFIG_PROFILE_CYCLE: ${[...stack, name].join(' -> ')}`)
  const profile = config.agents?.profiles?.[name]
  if (!profile) throw new Error(`CONFIG_INVALID_REFERENCE: ${name}`)
  const result = profile.extends ? effectiveCapabilities(config, profile.extends, [...stack, name]) : new Set<string>()
  for (const cap of profile.capabilities ?? []) result.add(cap)
  for (const cap of profile.disable_capabilities ?? []) result.delete(cap)
  return result
}

export function resolveProject(config: RepositoryConfig, repoPath: string): { alias: string; project: Project } | undefined {
  const path = repoPath.replaceAll('\\', '/')
  const matches: Array<{ alias: string; project: Project; score: number[] }> = []
  for (const [alias, project] of Object.entries(config.projects)) {
    if ((project.exclude ?? []).some(p => matchesGlob(p, path))) continue
    const scores = project.paths.filter(p => matchesGlob(p, path)).map(specificity)
    if (scores.length) matches.push({ alias, project, score: scores.sort(compareScore).at(-1)! })
  }
  matches.sort((a,b) => compareScore(a.score,b.score))
  const best = matches.at(-1)
  if (best && matches.length > 1 && compareScore(best.score, matches.at(-2)!.score) === 0 && best.alias !== matches.at(-2)!.alias) throw new Error('ROUTING_AMBIGUOUS')
  if (best) return { alias: best.alias, project: best.project }
  const alias = config.defaults?.project
  return alias ? { alias, project: config.projects[alias] } : undefined
}

function validatePattern(p: string): void {
  if (!p || p.startsWith('/') || p.includes('\\') || /[\[\]{}]/.test(p) || p.split('/').some(s => !s || s === '.' || s === '..' || (s.includes('**') && s !== '**'))) throw new Error(`ROUTING_INVALID_PATTERN: ${p}`)
}
function matchesGlob(pattern: string, path: string): boolean {
  const escaped = pattern.split('/').map(s => s === '**' ? '(?:[^/]+/)*[^/]*' : s.replace(/[.+^${}()|[\]\\]/g,'\\$&').replaceAll('*','[^/]*').replaceAll('?','[^/]')).join('/')
  return new RegExp(`^${escaped}$`).test(path)
}
function specificity(p: string): number[] { const s=p.split('/'); return [s.filter(x=>!/[?*]/.test(x)).length,[...p].filter(c=>!'*/?'.includes(c)).length,-s.filter(x=>x==='**').length,-([...p].filter(c=>c==='*'||c==='?').length-s.filter(x=>x==='**').length*2),s.length] }
function compareScore(a:number[],b:number[]):number { for(let i=0;i<a.length;i++){const d=a[i]-b[i];if(d)return d}return 0 }

export function filterDefinitions(definitions: readonly ToolDefinition[], capabilities: Set<string>): ToolDefinition[] {
  return definitions.filter(def => {
    const required = def.permissions.map(permission => permission.replace(':', '.'))
    return required.every(capability => capabilities.has(capability)) || def.capabilities.some(cap => capabilities.has(cap))
  })
}
