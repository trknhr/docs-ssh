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
  it('mounts helper commands and v2 project paths', async () => {
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
    expect(sourceStore.homeRootPath).toBe(resolve(workspaceDir, 'tenants', 'default', 'principals', 'anonymous', 'home'))
    expect(sourceStore.projectRootPath).toBe(resolve(workspaceDir, 'tenants', 'default', 'projects', 'default'))
    expect(bash.getEnv().HOME).toBe('/home')
    await expect(fs.readFile('/README.md', 'utf8')).resolves.toContain('/projects/default/issues')
    const agents = await bash.exec('agents')
    expect(agents.stdout).toContain(
      'Before implementing against Project Docs, inspect the mounted project filesystem over SSH first.',
    )
    expect(agents.stdout).toContain(
      'prefer remote-side `printf` or `echo` commands over heredocs or `cat > file`',
    )
    await expect(fs.readFile('/projects/default/README.md', 'utf8')).resolves.toContain('# Project')
    await expect(fs.readFile('/home/README.md', 'utf8')).resolves.toContain('# Home')
    await expect(fs.readdir('/projects/default')).resolves.toEqual([
      'README.md',
      'issues',
      'tasks',
    ])
  })

  it('enforces v2 project write rules', async () => {
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

    await fs.writeFile('/projects/default/issues/example-issue.md', '# Example issue\n')
    await expect(
      readFile(resolve(workspaceDir, 'tenants', 'default', 'projects', 'default', 'issues', 'example-issue.md'), 'utf8'),
    ).resolves.toBe('# Example issue\n')

    await fs.mkdir('/projects/default/tasks/example-task', { recursive: true })
    await fs.writeFile('/projects/default/tasks/example-task/notes.md', 'note')
    await expect(
      readFile(resolve(workspaceDir, 'tenants', 'default', 'projects', 'default', 'tasks', 'example-task', 'notes.md'), 'utf8'),
    ).resolves.toBe('note')

    await fs.mkdir('/home/private-notes', { recursive: true })
    await fs.writeFile('/home/private-notes/notes.md', 'private')
    await expect(
      readFile(resolve(workspaceDir, 'tenants', 'default', 'principals', 'anonymous', 'home', 'private-notes', 'notes.md'), 'utf8'),
    ).resolves.toBe('private')

    await fs.writeFile('/tmp/temp.txt', 'tmp')
    await expect(fs.readFile('/tmp/temp.txt', 'utf8')).resolves.toBe('tmp')

    await expect(fs.writeFile('/projects/default/README.md', 'blocked')).rejects.toThrow(
      "EROFS: read-only file system, write '/projects/default/README.md'",
    )
    await expect(fs.mkdir('/projects/other/tasks/example', { recursive: true })).rejects.toThrow(
      "EROFS: read-only file system, mkdir '/projects/other/tasks/example'",
    )
  })

  it('uses session context for project roots, bootstrap output, and write scopes', async () => {
    const tempDir = await createTempDir()
    const docsDir = resolve(tempDir, 'docs')
    const workspaceDir = resolve(tempDir, 'workspace')
    vi.stubEnv('DOCS_SSH_STATE_DIR', resolve(tempDir, 'state'))
    vi.stubEnv('WORKSPACE_DIR', workspaceDir)
    await mkdir(docsDir, { recursive: true })
    await writeFile(resolve(docsDir, 'README.md'), '# Product Docs\n')

    const { bash, fs, sourceStore } = await createBash({
      docsDir,
      docsName: 'Product Docs',
      session: {
        login: 'alice',
        principalId: 'principal-alice',
        principalKind: 'user',
        projectSlug: 'product-docs',
        scopes: ['bootstrap:read', 'project:read'],
        tenantSlug: 'acme',
      },
      workspaceDir,
    })

    expect(sourceStore.homeRootPath).toBe(
      resolve(workspaceDir, 'tenants', 'acme', 'principals', 'principal-alice', 'home'),
    )
    expect(sourceStore.projectRootPath).toBe(resolve(workspaceDir, 'tenants', 'acme', 'projects', 'product-docs'))
    await expect(fs.writeFile('/projects/product-docs/tasks/example/notes.md', 'blocked')).rejects.toThrow(
      "EROFS: read-only file system, write '/projects/product-docs/tasks/example/notes.md'",
    )

    const bootstrap = await bash.exec('bootstrap --json')
    const payload = JSON.parse(bootstrap.stdout) as {
      principal: { login: string }
      project: { slug: string }
      scopes: string[]
    }
    expect(payload.principal.login).toBe('alice')
    expect(payload.project.slug).toBe('product-docs')
    expect(payload.scopes).toEqual(['bootstrap:read', 'project:read'])

    const restricted = await createBash({
      docsDir,
      docsName: 'Product Docs',
      session: {
        login: 'alice',
        principalId: 'principal-alice',
        principalKind: 'user',
        projectSlug: 'product-docs',
        scopes: ['project:read'],
        tenantSlug: 'acme',
      },
      workspaceDir,
    })
    const deniedBootstrap = await restricted.bash.exec('bootstrap --json')
    expect(deniedBootstrap.exitCode).toBe(126)
    expect(deniedBootstrap.stderr).toContain('bootstrap:read')
  })
})
