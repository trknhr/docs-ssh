import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRemoteArchiveBatches,
  formatRemoteExtractCommand,
} from '../bench/ragbench/materialize.js'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-materialize-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe('RAGBench materialize remote writes', () => {
  it('formats remote materialization as a tar stream extraction', () => {
    const command = formatRemoteExtractCommand('/projects/default/tasks/ragbench-cases')

    expect(command).toBe("tar -xf - -C '/projects/default/tasks/ragbench-cases'")
    expect(command).not.toContain('base64')
    expect(command).not.toContain('cat >')
  })

  it('splits remote tar archives into batches below the configured stdin limit', async () => {
    const root = await createTempDir()
    const first = resolve(root, 'case-a')
    const second = resolve(root, 'case-b')
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(resolve(first, 'payload.bin'), Buffer.alloc(700 * 1024, 'a'))
    await writeFile(resolve(second, 'payload.bin'), Buffer.alloc(700 * 1024, 'b'))

    const batches = createRemoteArchiveBatches({
      entries: ['case-a', 'case-b'],
      localRoot: root,
      maxBytes: 900 * 1024,
    })

    expect(batches).toHaveLength(2)
    expect(batches.flatMap((batch) => batch.entries)).toEqual(['case-a', 'case-b'])
    expect(batches.every((batch) => batch.archive.length <= 900 * 1024)).toBe(true)
  })

  it('fails clearly when a single entry exceeds the configured stdin limit', async () => {
    const root = await createTempDir()
    const only = resolve(root, 'case-a')
    await mkdir(only, { recursive: true })
    await writeFile(resolve(only, 'payload.bin'), Buffer.alloc(64 * 1024, 'a'))

    expect(() => createRemoteArchiveBatches({
      entries: ['case-a'],
      localRoot: root,
      maxBytes: 1024,
    })).toThrow(/exceeding --remote-batch-bytes/)
  })
})
