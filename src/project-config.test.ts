import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findProjectConfig } from './project-config.js'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-project-config-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe('findProjectConfig', () => {
  it('finds .docs-ssh.toml by walking upward from the current directory', async () => {
    const rootDir = await createTempDir()
    const nestedDir = resolve(rootDir, 'packages', 'app')
    await mkdir(nestedDir, { recursive: true })
    await writeFile(
      resolve(rootDir, '.docs-ssh.toml'),
      [
        'server = "docs-ssh"',
        'viewer_origin = "https://docs.example.com"',
        'project = "slack-ai-assistant-agentcore-migration"',
        '',
      ].join('\n'),
    )

    await expect(findProjectConfig(nestedDir)).resolves.toEqual({
      path: resolve(rootDir, '.docs-ssh.toml'),
      project: 'slack-ai-assistant-agentcore-migration',
      server: 'docs-ssh',
      viewerOrigin: 'https://docs.example.com',
    })
  })

  it('accepts host as the SSH config host key', async () => {
    const rootDir = await createTempDir()
    await writeFile(
      resolve(rootDir, '.docs-ssh.toml'),
      [
        'host = "docs-ssh"',
        'viewer_origin = "https://docs.example.com"',
        'project = "serverless-agent"',
        '',
      ].join('\n'),
    )

    await expect(findProjectConfig(rootDir)).resolves.toEqual({
      path: resolve(rootDir, '.docs-ssh.toml'),
      project: 'serverless-agent',
      server: 'docs-ssh',
      viewerOrigin: 'https://docs.example.com',
    })
  })

  it('returns null when no config file exists', async () => {
    const rootDir = await createTempDir()
    await expect(findProjectConfig(rootDir)).resolves.toBeNull()
  })
})
