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
  it('returns writable v2 filesystem paths', () => {
    expect(getWorkspaceWritablePaths()).toEqual([
      '/home/tasks',
      '/home/workspace',
      '/home/docs',
      '/home/agents',
      '/project/tasks',
      '/project/workspace',
      '/project/agents',
      '/projects/default/tasks',
      '/projects/default/workspace',
      '/projects/default/agents',
      '/shared/docs',
      '/shared/policies',
      '/tmp',
    ])

    expect(getWorkspaceWritablePaths({ projectSlug: 'demo' })).toContain('/projects/demo/tasks')
  })

  it('returns the read-only v2 guide and directory readmes', () => {
    expect(getWorkspaceReadOnlyPaths()).toEqual([
      '/README.md',
      '/home/README.md',
      '/home/tasks/README.md',
      '/home/workspace/README.md',
      '/home/docs/README.md',
      '/home/agents/README.md',
      '/project/README.md',
      '/project/docs',
      '/project/sources',
      '/project/tasks/README.md',
      '/project/workspace/README.md',
      '/project/agents/README.md',
      '/projects/default/README.md',
      '/projects/default/docs',
      '/projects/default/sources',
      '/projects/default/tasks/README.md',
      '/projects/default/workspace/README.md',
      '/projects/default/agents/README.md',
      '/shared/README.md',
      '/shared/docs/README.md',
      '/shared/policies/README.md',
    ])
  })

  it('creates the v2 filesystem scaffold', async () => {
    const rootPath = await createTempDir()

    await ensureWorkspaceLayout(rootPath)

    const workspaceReadme = await readFile(resolve(rootPath, 'README.md'), 'utf8')
    expect(workspaceReadme).toContain('/project/tasks/<task-slug>/')
    expect(workspaceReadme).toContain('separates private work')

    const homeReadme = await readFile(resolve(rootPath, 'home', 'README.md'), 'utf8')
    expect(homeReadme).toContain('private durable storage')

    const tasksReadme = await readFile(resolve(rootPath, 'projects', 'default', 'tasks', 'README.md'), 'utf8')
    expect(tasksReadme).toContain('# Tasks')
    expect(tasksReadme).toContain('artifacts/')

    const sharedReadme = await readFile(resolve(rootPath, 'shared', 'README.md'), 'utf8')
    expect(sharedReadme).toContain('tenant-wide shared material')

    await expect(
      readFile(resolve(rootPath, 'home', 'agents', 'codex', 'sessions', 'raw', 'README.md'), 'utf8'),
    ).rejects.toThrow()
  })

  it('does not overwrite existing guide files', async () => {
    const rootPath = await createTempDir()
    await mkdir(resolve(rootPath, 'projects', 'default', 'tasks'), { recursive: true })
    await writeFile(resolve(rootPath, 'README.md'), 'custom root guide\n')
    await writeFile(resolve(rootPath, 'projects', 'default', 'tasks', 'README.md'), 'custom tasks guide\n')

    await ensureWorkspaceLayout(rootPath)

    await expect(readFile(resolve(rootPath, 'README.md'), 'utf8')).resolves.toBe('custom root guide\n')
    await expect(readFile(resolve(rootPath, 'projects', 'default', 'tasks', 'README.md'), 'utf8')).resolves.toBe(
      'custom tasks guide\n',
    )
    await expect(readFile(resolve(rootPath, 'home', 'workspace', 'README.md'), 'utf8')).resolves.toContain('# Workspace')
    await expect(readFile(resolve(rootPath, 'shared', 'policies', 'README.md'), 'utf8')).resolves.toContain('# Policies')
  })
})
