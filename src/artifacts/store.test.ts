import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createArtifactStore, type PublishArtifactInput } from './store.js'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-artifact-store-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

function createPublishInput(overrides: Partial<PublishArtifactInput> = {}): PublishArtifactInput {
  return {
    content: '<!doctype html><title>First</title>',
    creatorDisplayName: 'Alice',
    creatorLogin: 'alice',
    creatorPrincipalId: 'principal-alice',
    format: 'html',
    projectDisplayName: 'Product docs',
    projectId: 'project-1',
    projectPublicId: 'project-public-1',
    projectSlug: 'product-docs',
    sourcePath: '/projects/product-docs/tasks/demo/artifacts/index.html',
    tenantId: 'tenant-1',
    tenantPublicId: 'tenant-public-1',
    title: 'Demo',
    ...overrides,
  }
}

describe('createArtifactStore', () => {
  it('publishes immutable versions at a stable artifact id', async () => {
    const tempDir = await createTempDir()
    const dbPath = resolve(tempDir, 'artifacts.sqlite')
    const store = createArtifactStore({ dbPath })

    const first = store.publishArtifact(createPublishInput())
    const second = store.publishArtifact(createPublishInput({
      content: '<!doctype html><title>Second</title>',
      title: 'Renamed demo',
    }))

    expect(first.artifact.publicId).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{16}$/)
    expect(second.artifact.publicId).toBe(first.artifact.publicId)
    expect(second.artifact.latestVersion).toBe(2)
    expect(second.artifact.title).toBe('Renamed demo')
    expect(second.artifact.versions.map((version) => version.version)).toEqual([2, 1])
    expect(store.getArtifactContent(first.artifact.publicId, 1)?.content).toContain('First')
    expect(store.getArtifactContent(first.artifact.publicId, 2)?.content).toContain('Second')

    store.close()

    const reopened = createArtifactStore({ dbPath })
    expect(reopened.getArtifact(first.artifact.publicId)?.latestVersion).toBe(2)
    reopened.close()
  })

  it('keeps artifacts private until their creator shares them with the project', async () => {
    const tempDir = await createTempDir()
    const store = createArtifactStore({ dbPath: resolve(tempDir, 'artifacts.sqlite') })
    const published = store.publishArtifact(createPublishInput())

    expect(store.listArtifacts({
      principalId: 'principal-bob',
      projectId: 'project-1',
      tenantId: 'tenant-1',
    })).toEqual([])

    const shared = store.updateArtifactVisibility({
      principalId: 'principal-alice',
      publicId: published.artifact.publicId,
      visibility: 'project',
    })
    expect(shared.visibility).toBe('project')
    expect(store.listArtifacts({
      principalId: 'principal-bob',
      projectId: 'project-1',
      tenantId: 'tenant-1',
    }).map((artifact) => artifact.publicId)).toEqual([published.artifact.publicId])

    expect(() => store.updateArtifactVisibility({
      principalId: 'principal-bob',
      publicId: published.artifact.publicId,
      visibility: 'private',
    })).toThrow(/not found or is not owned/)
    store.close()
  })
})
