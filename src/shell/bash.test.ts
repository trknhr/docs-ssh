import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBash } from './bash.js'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-bash-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('createBash', () => {
  it('mounts helper commands, project docs, and v2 workspace paths', async () => {
    const tempDir = await createTempDir()
    const docsDir = resolve(tempDir, 'docs')
    const stateDir = resolve(tempDir, 'state')
    const workspaceDir = resolve(tempDir, 'workspace')
    await mkdir(docsDir, { recursive: true })
    await writeFile(resolve(docsDir, 'README.md'), '# Project Docs\n')
    vi.stubEnv('DOCS_SSH_STATE_DIR', stateDir)
    vi.stubEnv('WORKSPACE_DIR', workspaceDir)

    const { bash, fs, sourceStore } = await createBash({
      docsDir,
      docsName: 'Project Docs',
      sshHost: 'docs-ssh',
      sshPort: 2222,
    })

    expect(sourceStore.defaultSource?.name).toBe('local')
    expect(sourceStore.workspaceRootPath).toBe(workspaceDir)
    expect(sourceStore.homeRootPath).toBe(resolve(workspaceDir, 'home'))
    expect(sourceStore.projectRootPath).toBe(resolve(workspaceDir, 'projects', 'default'))
    expect(bash.getEnv().HOME).toBe('/home')
    await expect(fs.readFile('/README.md', 'utf8')).resolves.toContain('/project/docs')
    const agents = await bash.exec('agents')
    expect(agents.stdout).toContain(
      'Before implementing against Project Docs, inspect the mounted project filesystem over SSH first.',
    )
    expect(agents.stdout).toContain(
      'prefer remote-side `printf` or `echo` commands over heredocs or `cat > file`',
    )
    await expect(fs.readFile('/project/docs/README.md', 'utf8')).resolves.toBe('# Project Docs\n')
    await expect(fs.readFile('/project/README.md', 'utf8')).resolves.toContain('# Project')
    await expect(fs.readFile('/home/README.md', 'utf8')).resolves.toContain('# Home')
    await expect(fs.readdir('/project')).resolves.toEqual([
      'README.md',
      'agents',
      'docs',
      'sources',
      'tasks',
      'workspace',
    ])
  })

  it('enforces v2 workspace and docs write rules', async () => {
    const tempDir = await createTempDir()
    const docsDir = resolve(tempDir, 'docs')
    const workspaceDir = resolve(tempDir, 'workspace')
    vi.stubEnv('DOCS_SSH_STATE_DIR', resolve(tempDir, 'state'))
    vi.stubEnv('WORKSPACE_DIR', workspaceDir)
    await mkdir(docsDir, { recursive: true })

    const { fs } = await createBash({
      docsDir,
      docsName: 'Project Docs',
    })

    await fs.mkdir('/project/tasks/example-task', { recursive: true })
    await fs.writeFile('/project/tasks/example-task/notes.md', 'note')
    await expect(
      readFile(resolve(workspaceDir, 'projects', 'default', 'tasks', 'example-task', 'notes.md'), 'utf8'),
    ).resolves.toBe('note')

    await fs.mkdir('/home/tasks/private-task', { recursive: true })
    await fs.writeFile('/home/tasks/private-task/notes.md', 'private')
    await expect(readFile(resolve(workspaceDir, 'home', 'tasks', 'private-task', 'notes.md'), 'utf8')).resolves.toBe(
      'private',
    )

    await fs.writeFile('/tmp/temp.txt', 'tmp')
    await expect(fs.readFile('/tmp/temp.txt', 'utf8')).resolves.toBe('tmp')

    await expect(fs.writeFile('/project/README.md', 'blocked')).rejects.toThrow(
      "EROFS: read-only file system, write '/project/README.md'",
    )
    await expect(fs.writeFile('/project/docs/new.md', 'blocked')).rejects.toThrow(
      "EROFS: read-only file system, write '/project/docs/new.md'",
    )
  })
})
