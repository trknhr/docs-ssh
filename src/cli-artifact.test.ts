import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-cli-artifact-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe('docs-ssh artifact', () => {
  it('uses the configured project and active server session for SSH publish', async () => {
    const tempDir = await createTempDir()
    const projectDir = resolve(tempDir, 'project')
    const docsSshHome = resolve(tempDir, 'docs-ssh-home')
    const sessionDir = resolve(docsSshHome, 'sessions', 'docs-test')
    const fakeBin = resolve(tempDir, 'bin')
    const identityFile = resolve(sessionDir, 'id_ed25519')
    await mkdir(projectDir, { recursive: true })
    await mkdir(sessionDir, { recursive: true })
    await mkdir(fakeBin, { recursive: true })
    await writeFile(resolve(projectDir, '.docs-ssh.toml'), [
      'server = "docs-test"',
      'project = "product-docs"',
      'viewer_origin = "https://docs.example.com"',
      '',
    ].join('\n'))
    await writeFile(identityFile, 'test identity')
    await writeFile(resolve(sessionDir, 'session.json'), JSON.stringify({
      createdAt: '2026-07-24T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      fingerprint: 'SHA256:test',
      identityFile,
      project: 'default',
      scopes: ['project:read', 'project:write'],
      server: 'docs-test',
      sshCommand: `ssh -i ${identityFile} sess_test@docs-test`,
      username: 'sess_test',
      viewerOrigin: 'https://docs.example.com',
    }))
    const fakeSsh = resolve(fakeBin, 'ssh')
    await writeFile(fakeSsh, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
    await chmod(fakeSsh, 0o755)

    const { stdout } = await execFileAsync(resolve('node_modules/.bin/tsx'), [
      resolve('src/cli.ts'),
      'artifact',
      'publish',
      'tasks/demo/artifacts/index.html',
      '--title',
      'Demo app',
      '--share',
      'project',
      '--json',
    ], {
      cwd: projectDir,
      env: {
        ...process.env,
        DOCS_SSH_HOME: docsSshHome,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      },
      timeout: 10_000,
    })

    expect(stdout).toContain(`sess_test@docs-test`)
    expect(stdout).toContain(
      "'artifact' 'publish' '/projects/product-docs/tasks/demo/artifacts/index.html' '--project' 'product-docs'",
    )
    expect(stdout).toContain("'--title' 'Demo app' '--share' 'project' '--json'")
  }, 15_000)
})
