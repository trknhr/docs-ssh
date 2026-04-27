import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addSourceToRegistry,
  buildSourceStore,
  createEmptyRegistry,
  createFallbackRegistry,
  createSourceSpec,
  getSourceMountPath,
  loadSourceStore,
  makeRootPathPortable,
  normalizeSourceName,
  readSourceRegistry,
  writeSourceRegistry,
} from './source-store.js'
import type { SourceRegistry } from './types.js'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-source-store-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('source-store', () => {
  it('normalizes source names and mount paths', () => {
    expect(normalizeSourceName('  GitHub Docs  ')).toBe('github-docs')
    expect(normalizeSourceName('***')).toBe('source')
    expect(getSourceMountPath('GitHub Docs')).toBe('/project/sources/github-docs')
  })

  it('makes root paths portable relative to the registry', () => {
    expect(makeRootPathPortable('/tmp/state/sources.json', '/tmp/docs/project')).toBe('../docs/project')
    expect(makeRootPathPortable('/tmp/docs/sources.json', '/tmp/docs')).toBe('.')
  })

  it('creates source specs and fallback registries with normalized values', () => {
    const source = createSourceSpec({
      name: ' GitHub Docs ',
      type: 'git-repo',
      rootPath: './repo',
      managed: true,
      createdAt: '2026-04-06T00:00:00.000Z',
      repoUrl: 'https://github.com/github/docs.git',
      ref: 'main',
      subdir: 'content',
    })

    expect(source).toEqual({
      name: 'github-docs',
      type: 'git-repo',
      rootPath: './repo',
      managed: true,
      createdAt: '2026-04-06T00:00:00.000Z',
      repoUrl: 'https://github.com/github/docs.git',
      ref: 'main',
      subdir: 'content',
    })

    expect(createEmptyRegistry()).toEqual({
      version: 1,
      defaultSourceName: '',
      sources: [],
    })

    expect(createFallbackRegistry('/docs/root')).toEqual({
      version: 1,
      defaultSourceName: 'local',
      sources: [
        expect.objectContaining({
          name: 'local',
          type: 'local-folder',
          rootPath: '/docs/root',
          managed: false,
        }),
      ],
    })
  })

  it('adds sources and updates the default source when requested', () => {
    const docs = createSourceSpec({
      name: 'docs',
      type: 'local-folder',
      rootPath: '/docs',
      createdAt: '2026-04-06T00:00:00.000Z',
    })
    const reference = createSourceSpec({
      name: 'reference',
      type: 'local-folder',
      rootPath: '/reference',
      createdAt: '2026-04-06T00:00:00.000Z',
    })

    const initial = addSourceToRegistry(createEmptyRegistry(), docs)
    expect(initial.defaultSourceName).toBe('docs')

    const next = addSourceToRegistry(initial, reference, { makeDefault: true })
    expect(next.defaultSourceName).toBe('reference')
    expect(next.sources).toHaveLength(2)

    expect(() => addSourceToRegistry(next, reference)).toThrow('Source "reference" already exists in the registry.')
  })

  it('builds mounts for the default source and named sources', () => {
    const registry: SourceRegistry = {
      version: 1,
      defaultSourceName: 'docs',
      sources: [
        createSourceSpec({
          name: 'docs',
          type: 'local-folder',
          rootPath: '/data/docs',
          createdAt: '2026-04-06T00:00:00.000Z',
        }),
        createSourceSpec({
          name: 'reference',
          type: 'local-folder',
          rootPath: '/data/reference',
          createdAt: '2026-04-06T00:00:00.000Z',
        }),
      ],
    }

    const store = buildSourceStore(registry)

    expect(store.defaultSource?.name).toBe('docs')
    expect(store.mounts).toEqual(
      expect.arrayContaining([
        {
          sourceName: 'docs',
          mountPoint: '/project/docs',
          rootPath: '/data/docs',
        },
        {
          sourceName: 'docs',
          mountPoint: '/project/sources/docs',
          rootPath: '/data/docs',
        },
        {
          sourceName: 'docs',
          mountPoint: '/projects/default/docs',
          rootPath: '/data/docs',
        },
        {
          sourceName: 'docs',
          mountPoint: '/projects/default/sources/docs',
          rootPath: '/data/docs',
        },
        {
          sourceName: 'reference',
          mountPoint: '/project/sources/reference',
          rootPath: '/data/reference',
        },
        {
          sourceName: 'reference',
          mountPoint: '/projects/default/sources/reference',
          rootPath: '/data/reference',
        },
      ]),
    )
  })

  it('falls back to the first source when the registry has no explicit default', () => {
    const store = buildSourceStore({
      version: 1,
      defaultSourceName: '',
      sources: [
        createSourceSpec({
          name: 'primary',
          type: 'local-folder',
          rootPath: '/primary',
          createdAt: '2026-04-06T00:00:00.000Z',
        }),
        createSourceSpec({
          name: 'secondary',
          type: 'local-folder',
          rootPath: '/secondary',
          createdAt: '2026-04-06T00:00:00.000Z',
        }),
      ],
    })

    expect(store.registry.defaultSourceName).toBe('primary')
    expect(store.defaultSource?.name).toBe('primary')
    expect(store.mounts.find((mount) => mount.mountPoint === '/project/docs')?.rootPath).toBe('/primary')
  })

  it('reads and writes source registries', async () => {
    const tempDir = await createTempDir()
    const registryPath = resolve(tempDir, 'sources.json')
    const registry: SourceRegistry = {
      version: 1,
      defaultSourceName: 'docs',
      sources: [
        createSourceSpec({
          name: 'docs',
          type: 'local-folder',
          rootPath: '../docs',
          createdAt: '2026-04-06T00:00:00.000Z',
        }),
      ],
    }

    await writeSourceRegistry(registryPath, registry)

    await expect(readSourceRegistry(registryPath)).resolves.toEqual(registry)
    await expect(readSourceRegistry(resolve(tempDir, 'missing.json'))).resolves.toBeNull()
  })

  it('loads a fallback store when the registry does not exist', async () => {
    const tempDir = await createTempDir()
    const docsDir = resolve(tempDir, 'docs')
    const workspaceDir = resolve(tempDir, 'workspace')
    await mkdir(docsDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })

    const store = await loadSourceStore({
      registryPath: resolve(tempDir, 'missing.json'),
      fallbackDocsDir: docsDir,
      workspaceDir,
    })

    expect(store.defaultSource?.name).toBe('local')
    expect(store.mounts).toEqual(
      expect.arrayContaining([
        {
          sourceName: 'local',
          mountPoint: '/project/docs',
          rootPath: docsDir,
        },
        {
          sourceName: 'local',
          mountPoint: '/project/sources/local',
          rootPath: docsDir,
        },
        {
          sourceName: 'local',
          mountPoint: '/projects/default/docs',
          rootPath: docsDir,
        },
        {
          sourceName: 'local',
          mountPoint: '/projects/default/sources/local',
          rootPath: docsDir,
        },
      ]),
    )
    expect(store.workspaceRootPath).toBe(workspaceDir)
    expect(store.homeRootPath).toBe(resolve(workspaceDir, 'home'))
    expect(store.projectRootPath).toBe(resolve(workspaceDir, 'projects', 'default'))
    expect(store.sharedRootPath).toBe(resolve(workspaceDir, 'shared'))
  })

  it('resolves source roots relative to the registry location', async () => {
    const tempDir = await createTempDir()
    const docsDir = resolve(tempDir, 'mounted', 'docs')
    const workspaceDir = resolve(tempDir, 'workspace')
    const registryPath = resolve(tempDir, 'sources.json')
    await mkdir(docsDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })

    await writeSourceRegistry(registryPath, {
      version: 1,
      defaultSourceName: 'project',
      sources: [
        createSourceSpec({
          name: 'project',
          type: 'local-folder',
          rootPath: makeRootPathPortable(registryPath, docsDir),
          createdAt: '2026-04-06T00:00:00.000Z',
        }),
      ],
    })

    const store = await loadSourceStore({
      registryPath,
      fallbackDocsDir: resolve(tempDir, 'fallback-docs'),
      workspaceDir,
    })

    expect(store.defaultSource?.rootPath).toBe(docsDir)
  })

  it('falls back to the managed checkout path when the configured path is missing', async () => {
    const tempDir = await createTempDir()
    const workspaceDir = resolve(tempDir, 'workspace')
    const fallbackDocsDir = resolve(tempDir, 'fallback-docs')
    const managedPath = resolve(tempDir, 'sources', 'repo-docs', 'repo', 'content')
    const registryPath = resolve(tempDir, 'sources.json')
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(fallbackDocsDir, { recursive: true })
    await mkdir(managedPath, { recursive: true })

    await writeSourceRegistry(registryPath, {
      version: 1,
      defaultSourceName: 'repo-docs',
      sources: [
        createSourceSpec({
          name: 'repo-docs',
          type: 'git-repo',
          rootPath: './missing',
          managed: true,
          subdir: 'content',
          createdAt: '2026-04-06T00:00:00.000Z',
        }),
      ],
    })

    const store = await loadSourceStore({
      registryPath,
      fallbackDocsDir,
      workspaceDir,
    })

    expect(store.defaultSource?.rootPath).toBe(managedPath)
  })

  it('falls back to the runtime docs path for missing local folders with the same basename', async () => {
    const tempDir = await createTempDir()
    const registryPath = resolve(tempDir, 'state', 'sources.json')
    const fallbackDocsDir = resolve(tempDir, 'runtime', 'docs')
    const workspaceDir = resolve(tempDir, 'workspace')
    await mkdir(fallbackDocsDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })

    await writeSourceRegistry(registryPath, {
      version: 1,
      defaultSourceName: 'docs',
      sources: [
        createSourceSpec({
          name: 'docs',
          type: 'local-folder',
          rootPath: '../old/docs',
          createdAt: '2026-04-06T00:00:00.000Z',
        }),
      ],
    })

    const store = await loadSourceStore({
      registryPath,
      fallbackDocsDir,
      workspaceDir,
    })

    expect(store.defaultSource?.rootPath).toBe(fallbackDocsDir)
  })
})
