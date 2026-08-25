import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repoRoot = resolve('.')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')
const cliPath = resolve(repoRoot, 'src/cli.ts')
const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-cli-config-'))
  tempDirs.push(dir)
  return dir
}

async function writeFakeSsh(binDir: string, bootstrapPayload: unknown): Promise<void> {
  const sshPath = resolve(binDir, 'ssh')
  await writeFile(sshPath, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(bootstrapPayload)}\nJSON\n`)
  await chmod(sshPath, 0o755)
}

async function writeSession(homeDir: string, server = 'docs.example.com'): Promise<void> {
  const sessionDir = resolve(homeDir, 'sessions', server)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(resolve(sessionDir, 'id_ed25519'), 'test identity')
  await writeFile(resolve(sessionDir, 'session.json'), `${JSON.stringify({
    createdAt: '2026-05-29T00:00:00.000Z',
    expiresAt: '2999-05-29T01:00:00.000Z',
    fingerprint: 'SHA256:testfingerprint',
    identityFile: resolve(sessionDir, 'id_ed25519'),
    project: 'default',
    scopes: ['bootstrap:read', 'project:read'],
    server,
    sshCommand: `ssh -i ${resolve(sessionDir, 'id_ed25519')} sess_test@${server}`,
    username: 'sess_test',
    viewerOrigin: 'https://docs.example.com',
  }, null, 2)}\n`)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe('docs-ssh config init', () => {
  it('writes connection config before the first login', async () => {
    const homeDir = await createTempDir()
    const workDir = await createTempDir()

    const { stdout } = await execFileAsync(tsxBin, [
      cliPath,
      'config',
      'init',
      '--host',
      'docs.example.com',
      '--viewer-origin',
      'https://docs.example.com',
      '--home',
      homeDir,
      '--json',
    ], {
      cwd: workDir,
      timeout: 10_000,
    })

    const configPath = resolve(workDir, '.docs-ssh.toml')
    await expect(readFile(configPath, 'utf8')).resolves.toBe([
      'host = "docs.example.com"',
      'viewer_origin = "https://docs.example.com"',
      '',
    ].join('\n'))
    expect(JSON.parse(stdout)).toMatchObject({
      host: 'docs.example.com',
      loginRequired: true,
      server: 'docs.example.com',
      viewerOrigin: 'https://docs.example.com',
    })
    expect(JSON.parse(stdout)).not.toHaveProperty('project')
  }, 15_000)

  it('writes .docs-ssh.toml for a project selected from the active SSH session host', async () => {
    const homeDir = await createTempDir()
    const workDir = await createTempDir()
    const binDir = await createTempDir()
    await writeSession(homeDir)
    await writeFakeSsh(binDir, {
      project: {
        root: '/projects/default',
        slug: 'default',
      },
      projects: [
        { current: true, root: '/projects/default', slug: 'default' },
        { current: false, root: '/projects/product-docs', slug: 'product-docs' },
      ],
    })

    const { stdout } = await execFileAsync(tsxBin, [
      cliPath,
      'config',
      'init',
      '--host',
      'docs.example.com',
      '--project',
      'product-docs',
      '--home',
      homeDir,
      '--json',
    ], {
      cwd: workDir,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      },
      timeout: 10_000,
    })

    const configPath = resolve(workDir, '.docs-ssh.toml')
    const printedConfigPath = resolve(await realpath(workDir), '.docs-ssh.toml')
    await expect(readFile(configPath, 'utf8')).resolves.toBe([
      'host = "docs.example.com"',
      'viewer_origin = "https://docs.example.com"',
      'project = "product-docs"',
      '',
    ].join('\n'))
    expect(JSON.parse(stdout)).toMatchObject({
      path: printedConfigPath,
      host: 'docs.example.com',
      project: 'product-docs',
      server: 'docs.example.com',
      viewerOrigin: 'https://docs.example.com',
    })
  }, 15_000)

  it('requires --project in non-interactive shells when multiple projects are accessible', async () => {
    const homeDir = await createTempDir()
    const workDir = await createTempDir()
    const binDir = await createTempDir()
    await writeSession(homeDir)
    await writeFakeSsh(binDir, {
      project: {
        root: '/projects/default',
        slug: 'default',
      },
      projects: [
        { current: true, root: '/projects/default', slug: 'default' },
        { current: false, root: '/projects/product-docs', slug: 'product-docs' },
      ],
    })

    await expect(execFileAsync(tsxBin, [
      cliPath,
      'config',
      'init',
      '--host',
      'docs.example.com',
      '--home',
      homeDir,
    ], {
      cwd: workDir,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      },
      timeout: 10_000,
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('Pass --project'),
    })
  }, 15_000)

  it('uses the only active server session when no server is configured yet', async () => {
    const homeDir = await createTempDir()
    const workDir = await createTempDir()
    const binDir = await createTempDir()
    await writeSession(homeDir, 'docs-ssh-local')
    await writeFakeSsh(binDir, {
      project: {
        root: '/projects/default',
        slug: 'default',
      },
      projects: [
        { current: true, root: '/projects/default', slug: 'default' },
      ],
    })

    const { stdout } = await execFileAsync(tsxBin, [
      cliPath,
      'config',
      'init',
      '--home',
      homeDir,
      '--json',
    ], {
      cwd: workDir,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      },
      timeout: 10_000,
    })

    const configPath = resolve(workDir, '.docs-ssh.toml')
    await expect(readFile(configPath, 'utf8')).resolves.toContain('host = "docs-ssh-local"')
    expect(JSON.parse(stdout)).toMatchObject({
      host: 'docs-ssh-local',
      project: 'default',
      server: 'docs-ssh-local',
      viewerOrigin: 'https://docs.example.com',
    })
  }, 15_000)

  it('requires --host in non-interactive shells when multiple active hosts exist', async () => {
    const homeDir = await createTempDir()
    const workDir = await createTempDir()
    await writeSession(homeDir, 'docs-one')
    await writeSession(homeDir, 'docs-two')

    await expect(execFileAsync(tsxBin, [
      cliPath,
      'config',
      'init',
      '--home',
      homeDir,
    ], {
      cwd: workDir,
      timeout: 10_000,
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('Multiple active docs-ssh hosts are available. Pass --host'),
    })
  }, 15_000)

  it('completes a first-run config after login without requiring --force', async () => {
    const homeDir = await createTempDir()
    const workDir = await createTempDir()
    const binDir = await createTempDir()
    await writeFile(resolve(workDir, '.docs-ssh.toml'), [
      'host = "docs.example.com"',
      'viewer_origin = "https://docs.example.com"',
      '',
    ].join('\n'))
    await writeSession(homeDir)
    await writeFakeSsh(binDir, {
      project: {
        root: '/projects/default',
        slug: 'default',
      },
      projects: [
        { current: true, root: '/projects/default', slug: 'default' },
        { current: false, root: '/projects/product-docs', slug: 'product-docs' },
      ],
    })

    const { stdout } = await execFileAsync(tsxBin, [
      cliPath,
      'config',
      'init',
      '--project',
      'product-docs',
      '--home',
      homeDir,
      '--json',
    ], {
      cwd: workDir,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      },
      timeout: 10_000,
    })

    await expect(readFile(resolve(workDir, '.docs-ssh.toml'), 'utf8')).resolves.toBe([
      'host = "docs.example.com"',
      'viewer_origin = "https://docs.example.com"',
      'project = "product-docs"',
      '',
    ].join('\n'))
    expect(JSON.parse(stdout)).toMatchObject({
      host: 'docs.example.com',
      project: 'product-docs',
    })
  }, 15_000)
})
