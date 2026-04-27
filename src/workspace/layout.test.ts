import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureWorkspaceLayout,
  getWorkspaceReadOnlyPaths,
  getWorkspaceWritablePaths,
} from './layout.js'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-workspace-layout-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('workspace layout', () => {
  it('returns writable workspace paths without the reserved shared directory', () => {
    expect(getWorkspaceWritablePaths()).toEqual([
      '/workspace/tasks',
      '/workspace/library',
      '/workspace/decisions',
      '/workspace/archive',
    ])

    expect(getWorkspaceWritablePaths('/agent-workspace')).toEqual([
      '/agent-workspace/tasks',
      '/agent-workspace/library',
      '/agent-workspace/decisions',
      '/agent-workspace/archive',
    ])
  })

  it('returns the read-only guide and directory readmes', () => {
    expect(getWorkspaceReadOnlyPaths()).toEqual([
      '/workspace/README.md',
      '/workspace/_policy.json',
      '/workspace/tasks/README.md',
      '/workspace/library/README.md',
      '/workspace/decisions/README.md',
      '/workspace/archive/README.md',
      '/workspace/shared/README.md',
    ])
  })

  it('creates the workspace scaffold and policy file', async () => {
    const rootPath = await createTempDir()

    await ensureWorkspaceLayout(rootPath)

    const policy = JSON.parse(await readFile(resolve(rootPath, '_policy.json'), 'utf8'))
    expect(policy).toMatchObject({
      schemaVersion: 1,
      root: '/workspace',
      tmpRoot: '/tmp',
      naming: {
        taskSlugStyle: 'kebab-case',
      },
      taskTemplate: {
        suggestedFiles: ['brief.md', 'plan.md', 'notes.md', 'handoff.md'],
        suggestedDirectories: ['artifacts'],
      },
    })
    expect(policy.directories.shared).toEqual({
      purpose: 'Reserved for future multi-user sharing.',
      reserved: true,
      readme: '/workspace/shared/README.md',
    })

    const workspaceReadme = await readFile(resolve(rootPath, 'README.md'), 'utf8')
    expect(workspaceReadme).toContain('/workspace/tasks/<task-slug>/')
    expect(workspaceReadme).toContain('Do not add additional loose files or new top-level directories')

    const tasksReadme = await readFile(resolve(rootPath, 'tasks', 'README.md'), 'utf8')
    expect(tasksReadme).toContain('# Tasks')
    expect(tasksReadme).toContain('artifacts/')

    const sharedReadme = await readFile(resolve(rootPath, 'shared', 'README.md'), 'utf8')
    expect(sharedReadme).toContain('Reserved for future multi-user sharing.')
  })

  it('does not overwrite existing guide files', async () => {
    const rootPath = await createTempDir()
    await mkdir(resolve(rootPath, 'tasks'), { recursive: true })
    await writeFile(resolve(rootPath, 'README.md'), 'custom workspace guide\n')
    await writeFile(resolve(rootPath, 'tasks', 'README.md'), 'custom tasks guide\n')

    await ensureWorkspaceLayout(rootPath)

    await expect(readFile(resolve(rootPath, 'README.md'), 'utf8')).resolves.toBe('custom workspace guide\n')
    await expect(readFile(resolve(rootPath, 'tasks', 'README.md'), 'utf8')).resolves.toBe('custom tasks guide\n')
    await expect(readFile(resolve(rootPath, 'library', 'README.md'), 'utf8')).resolves.toContain('# Library')
    await expect(readFile(resolve(rootPath, '_policy.json'), 'utf8')).resolves.toContain('"schemaVersion": 1')
  })
})
