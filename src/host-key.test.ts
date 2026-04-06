import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureHostKey,
  generateHostKeyPem,
  getHostKeyFingerprint,
  logHostKeyFingerprint,
  writeHostKey,
} from './host-key.js'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-host-key-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('host-key', () => {
  it('generates PEM host keys and fingerprints them deterministically', () => {
    const pem = generateHostKeyPem()

    expect(pem).toContain('BEGIN RSA PRIVATE KEY')
    expect(getHostKeyFingerprint('docs-ssh')).toBe(getHostKeyFingerprint(Buffer.from('docs-ssh')))
  })

  it('writes host keys to disk and loads existing keys without regenerating them', async () => {
    const tempDir = await createTempDir()
    const hostKeyPath = resolve(tempDir, 'nested', 'ssh_host_key')
    const pem = generateHostKeyPem()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await writeHostKey(hostKeyPath, pem)
    await expect(readFile(hostKeyPath, 'utf8')).resolves.toBe(pem)

    const loaded = await ensureHostKey(hostKeyPath)
    expect(loaded.toString('utf8')).toBe(pem)
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Loaded host key from ${hostKeyPath} (SHA256:`),
    )
  })

  it('creates a host key on first run and reuses it on later loads', async () => {
    const tempDir = await createTempDir()
    const hostKeyPath = resolve(tempDir, 'ssh_host_key')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const generated = await ensureHostKey(hostKeyPath)
    const loaded = await ensureHostKey(hostKeyPath)

    expect(generated.equals(loaded)).toBe(true)
    expect(logSpy).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(`Generated host key at ${hostKeyPath} (SHA256:`),
    )
    expect(logSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(`Loaded host key from ${hostKeyPath} (SHA256:`),
    )
  })

  it('logs host key fingerprints with the provided source label', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    logHostKeyFingerprint('env var', 'secret')

    expect(logSpy).toHaveBeenCalledWith(
      `Loaded host key from env var (SHA256:${getHostKeyFingerprint('secret')})`,
    )
  })
})
