import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactWithVersions } from './store.js'
import { createBash } from '../shell/bash.js'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-artifact-command-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

function createArtifact(overrides: Partial<ArtifactWithVersions> = {}): ArtifactWithVersions {
  return {
    createdAt: '2026-07-24T00:00:00.000Z',
    creatorDisplayName: 'Alice',
    creatorLogin: 'alice',
    creatorPrincipalId: 'principal-alice',
    format: 'html',
    latestVersion: 1,
    projectDisplayName: 'Product docs',
    projectId: 'project-1',
    projectPublicId: 'project-public-1',
    projectSlug: 'product-docs',
    publicId: '23456789abcdefgh',
    sourcePath: '/projects/product-docs/tasks/demo/artifacts/index.html',
    tenantId: 'tenant-1',
    tenantPublicId: 'tenant-public-1',
    title: 'Demo',
    updatedAt: '2026-07-24T00:00:00.000Z',
    versions: [{
      contentHash: 'a'.repeat(64),
      createdAt: '2026-07-24T00:00:00.000Z',
      createdByLogin: 'alice',
      createdByPrincipalId: 'principal-alice',
      sizeBytes: 42,
      version: 1,
    }],
    visibility: 'private',
    ...overrides,
  }
}

describe('artifact SSH command', () => {
  it('publishes a project-relative artifact path and prints its stable URL', async () => {
    const tempDir = await createTempDir()
    const docsDir = resolve(tempDir, 'docs')
    const workspaceDir = resolve(tempDir, 'workspace')
    await mkdir(docsDir, { recursive: true })
    await mkdir(resolve(workspaceDir, 'tenants/default/projects/product-docs/tasks/demo/artifacts'), { recursive: true })
    await writeFile(resolve(docsDir, 'README.md'), '# Docs\n')
    await writeFile(
      resolve(workspaceDir, 'tenants/default/projects/product-docs/tasks/demo/artifacts/index.html'),
      '<!doctype html><title>Demo</title>',
    )

    const publishArtifact = vi.fn(async () => createArtifact())
    const { bash } = await createBash({
      artifactService: {
        getArtifact: async () => createArtifact(),
        listArtifacts: async () => [],
        publishArtifact,
        updateArtifactVisibility: async () => createArtifact({ visibility: 'project' }),
      },
      docsDir,
      session: {
        principalId: 'principal-alice',
        projectSlug: 'product-docs',
        scopes: ['bootstrap:read', 'project:read', 'project:write'],
        tenantId: 'tenant-1',
        tenantSlug: 'default',
      },
      viewerOrigin: 'https://docs.example.com',
      workspaceDir,
    })

    const result = await bash.exec('artifact publish tasks/demo/artifacts/index.html --title "Demo app"')

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('https://docs.example.com/artifacts/23456789abcdefgh')
    expect(publishArtifact).toHaveBeenCalledWith(expect.objectContaining({
      content: '<!doctype html><title>Demo</title>',
      projectSlug: 'product-docs',
      sourcePath: '/projects/product-docs/tasks/demo/artifacts/index.html',
      title: 'Demo app',
    }))
  })

  it('rejects HTML outside a task artifact directory', async () => {
    const tempDir = await createTempDir()
    const docsDir = resolve(tempDir, 'docs')
    await mkdir(docsDir, { recursive: true })
    await writeFile(resolve(docsDir, 'README.md'), '# Docs\n')

    const { bash } = await createBash({
      artifactService: {
        getArtifact: async () => createArtifact(),
        listArtifacts: async () => [],
        publishArtifact: async () => createArtifact(),
        updateArtifactVisibility: async () => createArtifact(),
      },
      docsDir,
      session: {
        projectSlug: 'product-docs',
      },
      workspaceDir: resolve(tempDir, 'workspace'),
    })

    const result = await bash.exec('artifact publish README.html')

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('tasks/<task>/artifacts')
  })
})
