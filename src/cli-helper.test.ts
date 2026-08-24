import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repoRoot = resolve('.')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')
const cliPath = resolve(repoRoot, 'src/cli.ts')
const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-cli-helper-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe('docs-ssh helper aliases', () => {
  it('prints helper content from top-level commands', async () => {
    const workDir = await createTempDir()
    await writeFile(resolve(workDir, '.docs-ssh.toml'), 'host = "docs-ssh"\nproject = "default"\n')

    const { stdout } = await execFileAsync(tsxBin, [cliPath, 'skill'], {
      cwd: workDir,
      timeout: 10_000,
    })
    const legacy = await execFileAsync(tsxBin, [cliPath, 'helper', 'skill'], {
      cwd: workDir,
      timeout: 10_000,
    })

    expect(stdout).toBe(legacy.stdout)
    expect(stdout).toContain('name: docs-ssh')
    expect(stdout).toContain('## HTTPS workflow')
    expect(stdout).toContain('Require the caller or runtime to inject `DOCS_SSH_TOKEN`')
    expect(stdout.toLowerCase()).not.toContain('envvault')
    expect(stdout).not.toContain('## SSH workflow')
    expect(stdout).not.toContain('ssh docs-ssh -p 2222')
    expect(stdout).not.toContain('fallback')
  }, 15_000)

  it('writes helper content with --output', async () => {
    const workDir = await createTempDir()
    const outputPath = resolve(workDir, '.agents/skills/docs-ssh/SKILL.md')

    await execFileAsync(tsxBin, [cliPath, 'skill', '--output', outputPath], {
      cwd: workDir,
      timeout: 10_000,
    })

    await expect(readFile(outputPath, 'utf8')).resolves.toContain('name: docs-ssh')
  }, 15_000)
})
