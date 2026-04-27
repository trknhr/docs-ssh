import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, posix, relative, resolve } from 'node:path'
import type { SourceRegistry, SourceSpec, SourceStore, SourceType } from './types.js'

const SOURCE_NAME_PATTERN = /[^a-z0-9-]+/g
const SOURCE_REGISTRY_VERSION = 1

export interface StatePaths {
  registryPath: string
  sourcesDir: string
  stateDir: string
}

export function normalizeSourceName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(SOURCE_NAME_PATTERN, '-')
    .replace(/^-+|-+$/g, '') || 'source'
}

export function getSourceMountPath(name: string): string {
  return posix.join('/sources', normalizeSourceName(name))
}

export function resolveStatePaths(opts: {
  registryPath?: string
  stateDir: string
}): StatePaths {
  const resolvedStateDir = resolve(opts.stateDir)

  return {
    stateDir: resolvedStateDir,
    registryPath: resolve(opts.registryPath ?? `${resolvedStateDir}/sources.json`),
    sourcesDir: resolve(resolvedStateDir, 'sources'),
  }
}

export function getStatePaths(stateDir = process.env.DOCS_SSH_STATE_DIR ?? './.docs-ssh'): StatePaths {
  return resolveStatePaths({
    stateDir,
    registryPath: process.env.DOCS_SSH_REGISTRY_PATH,
  })
}

export function createSourceSpec(opts: {
  name: string
  type: SourceType
  rootPath: string
  managed?: boolean
  createdAt?: string
  repoUrl?: string
  ref?: string
  subdir?: string
}): SourceSpec {
  const normalizedName = normalizeSourceName(opts.name)

  return {
    name: normalizedName,
    type: opts.type,
    rootPath: opts.rootPath,
    managed: opts.managed ?? false,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    repoUrl: opts.repoUrl,
    ref: opts.ref,
    subdir: opts.subdir,
  }
}

export function createFallbackRegistry(rootPath: string): SourceRegistry {
  return {
    version: SOURCE_REGISTRY_VERSION,
    defaultSourceName: 'local',
    sources: [
      createSourceSpec({
        name: 'local',
        type: 'local-folder',
        rootPath,
      }),
    ],
  }
}

export function createEmptyRegistry(): SourceRegistry {
  return {
    version: SOURCE_REGISTRY_VERSION,
    defaultSourceName: '',
    sources: [],
  }
}

export async function readSourceRegistry(path: string): Promise<SourceRegistry | null> {
  try {
    const content = await readFile(path, 'utf8')
    const parsed = JSON.parse(content) as SourceRegistry
    if (parsed.version !== SOURCE_REGISTRY_VERSION) {
      throw new Error(`Unsupported source registry version: ${parsed.version}`)
    }
    return parsed
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function makeRootPathPortable(registryPath: string, absoluteRootPath: string): string {
  const registryDir = dirname(resolve(registryPath))
  const normalizedRootPath = resolve(absoluteRootPath)
  const relativePath = relative(registryDir, normalizedRootPath)
  return relativePath === '' ? '.' : relativePath
}

async function resolveSourceRootPath(opts: {
  source: SourceSpec
  registryPath: string
  fallbackDocsDir: string
}): Promise<string> {
  const { source, registryPath, fallbackDocsDir } = opts
  const registryDir = dirname(resolve(registryPath))
  const configuredPath = isAbsolute(source.rootPath)
    ? resolve(source.rootPath)
    : resolve(registryDir, source.rootPath)

  if (await pathExists(configuredPath)) return configuredPath

  const statePaths = resolveStatePaths({ stateDir: dirname(registryPath) })

  if (source.managed) {
    const managedPath = resolve(statePaths.sourcesDir, source.name, 'repo', source.subdir ?? '.')
    if (await pathExists(managedPath)) return managedPath
  }

  if (source.type === 'local-folder') {
    const fallbackPath = resolve(fallbackDocsDir)
    if (
      basename(configuredPath) === basename(fallbackPath) &&
      (await pathExists(fallbackPath))
    ) {
      return fallbackPath
    }
  }

  return configuredPath
}

export async function writeSourceRegistry(path: string, registry: SourceRegistry): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`)
}

export function buildSourceStore(registry: SourceRegistry): SourceStore {
  const defaultSourceName = registry.defaultSourceName || registry.sources[0]?.name || 'local'
  const defaultSource = registry.sources.find((source) => source.name === defaultSourceName)

  const mounts = registry.sources.flatMap((source) => {
    const sourceMounts = [
      {
        sourceName: source.name,
        mountPoint: getSourceMountPath(source.name),
        rootPath: source.rootPath,
      },
    ]

    if (source.name === defaultSourceName) {
      sourceMounts.push({
        sourceName: source.name,
        mountPoint: '/docs',
        rootPath: source.rootPath,
      })
    }

    return sourceMounts
  })

  return {
    registry: {
      version: SOURCE_REGISTRY_VERSION,
      defaultSourceName,
      sources: registry.sources,
    },
    mounts,
    defaultSource,
    workspaceMountPath: '/workspace',
    tmpMountPath: '/tmp',
    workspaceRootPath: '',
  }
}

export async function loadSourceStore(opts: {
  registryPath?: string
  fallbackDocsDir: string
  workspaceDir: string
}): Promise<SourceStore> {
  const statePaths = getStatePaths()
  const registryPath = resolve(opts.registryPath ?? statePaths.registryPath)
  const registry = await readSourceRegistry(registryPath)
  if (registry && registry.sources.length > 0) {
    const resolvedSources = await Promise.all(
      registry.sources.map(async (source) => ({
        ...source,
        rootPath: await resolveSourceRootPath({
          source,
          registryPath,
          fallbackDocsDir: opts.fallbackDocsDir,
        }),
      })),
    )

    const sourceStore = buildSourceStore({
      ...registry,
      sources: resolvedSources,
    })
    return {
      ...sourceStore,
      workspaceRootPath: resolve(opts.workspaceDir),
    }
  }
  const sourceStore = buildSourceStore(createFallbackRegistry(opts.fallbackDocsDir))
  return {
    ...sourceStore,
    workspaceRootPath: resolve(opts.workspaceDir),
  }
}

export function addSourceToRegistry(
  registry: SourceRegistry,
  source: SourceSpec,
  opts: { makeDefault?: boolean } = {},
): SourceRegistry {
  if (registry.sources.some((existing) => existing.name === source.name)) {
    throw new Error(`Source "${source.name}" already exists in the registry.`)
  }

  const sources = [...registry.sources, source]

  return {
    version: SOURCE_REGISTRY_VERSION,
    defaultSourceName: opts.makeDefault ? source.name : registry.defaultSourceName || source.name,
    sources,
  }
}
