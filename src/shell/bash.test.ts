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
  it('mounts helper files, docs, and workspace paths', async () => {
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
    expect(bash.getEnv().HOME).toBe('/workspace')
    await expect(fs.readFile('/AGENTS.md', 'utf8')).resolves.toContain(
      'Before implementing against Project Docs, inspect the mounted docs over SSH first.',
    )
    await expect(fs.readFile('/AGENTS.md', 'utf8')).resolves.toContain(
      'prefer remote-side `printf` or `echo` commands over heredocs or `cat > file`',
    )
    await expect(fs.readFile('/docs/README.md', 'utf8')).resolves.toBe('# Project Docs\n')
    await expect(fs.readFile('/workspace/README.md', 'utf8')).resolves.toContain('# Workspace')
  })

  it('enforces workspace and docs write rules', async () => {
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

    await fs.mkdir('/workspace/tasks/example-task', { recursive: true })
    await fs.writeFile('/workspace/tasks/example-task/notes.md', 'note')
    await expect(readFile(resolve(workspaceDir, 'tasks', 'example-task', 'notes.md'), 'utf8')).resolves.toBe('note')

    await fs.writeFile('/scratch/temp.txt', 'scratch')
    await expect(fs.readFile('/scratch/temp.txt', 'utf8')).resolves.toBe('scratch')

    await expect(fs.writeFile('/workspace/README.md', 'blocked')).rejects.toThrow(
      "EROFS: read-only file system, write '/workspace/README.md'",
    )
    await expect(fs.writeFile('/docs/new.md', 'blocked')).rejects.toThrow(
      "EROFS: read-only file system, write '/docs/new.md'",
    )
  })
})
