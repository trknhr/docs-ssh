import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadLocalEnvFile } from './env.js'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-env-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('loadLocalEnvFile', () => {
  it('loads variables from an explicit env file path', async () => {
    const tempDir = await createTempDir()
    const envPath = resolve(tempDir, '.env.local')
    await writeFile(envPath, 'DOCS_SSH_OIDC_ISSUER=https://accounts.google.com\nVIEWER_PORT=3000\n')

    loadLocalEnvFile(envPath)

    expect(process.env.DOCS_SSH_OIDC_ISSUER).toBe('https://accounts.google.com')
    expect(process.env.VIEWER_PORT).toBe('3000')
  })

  it('does not override variables that are already present in the environment', async () => {
    const tempDir = await createTempDir()
    const envPath = resolve(tempDir, '.env.override')
    await writeFile(envPath, 'VIEWER_PORT=3000\n')
    vi.stubEnv('VIEWER_PORT', '4000')

    loadLocalEnvFile(envPath)

    expect(process.env.VIEWER_PORT).toBe('4000')
  })

  it('ignores missing env files', () => {
    expect(() => loadLocalEnvFile(resolve(tmpdir(), 'docs-ssh-missing.env'))).not.toThrow()
  })
})
