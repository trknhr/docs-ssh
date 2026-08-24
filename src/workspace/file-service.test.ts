import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceFileService } from './file-service.js'
import { ensureWorkspaceLayout } from './layout.js'

const tempDirs: string[] = []

async function createService(opts: { maxFileBytes?: number } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'docs-ssh-files-'))
  tempDirs.push(tempDir)
  const tenantRootPath = resolve(tempDir, 'tenant')
  const projectRootPath = resolve(tenantRootPath, 'projects/default')
  await ensureWorkspaceLayout(tenantRootPath, { projectRootPath })
  const service = await WorkspaceFileService.create(projectRootPath, {
    maxFileBytes: opts.maxFileBytes,
    readOnlyPaths: ['README.md', 'issues/README.md', 'tasks/README.md'],
    writableDirectories: ['issues', 'tasks'],
  })
  return { projectRootPath, service, tempDir }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe('WorkspaceFileService', () => {
  it('creates nested directories and round-trips arbitrary bytes', async () => {
    const { service } = await createService()

    const rootEntries = await service.list()
    expect(rootEntries.map((entry) => [entry.path, entry.type])).toEqual([
      ['issues', 'directory'],
      ['tasks', 'directory'],
      ['README.md', 'file'],
    ])

    const directory = await service.createDirectory('tasks/http-test/artifacts')
    expect(directory).toMatchObject({
      created: true,
      entry: { path: 'tasks/http-test/artifacts', type: 'directory' },
    })

    const bytes = Buffer.from([0, 10, 127, 128, 255])
    const written = await service.writeFile('tasks/http-test/artifacts/result.bin', [bytes])
    expect(written).toMatchObject({
      created: true,
      entry: {
        path: 'tasks/http-test/artifacts/result.bin',
        size: bytes.length,
        type: 'file',
      },
    })

    const readable = await service.getReadableFile('tasks/http-test/artifacts/result.bin')
    expect(await readFile(readable.absolutePath)).toEqual(bytes)
    expect(await service.stat('tasks/http-test/artifacts/result.bin')).toMatchObject({
      size: bytes.length,
      type: 'file',
    })
  })

  it('keeps the previous file intact when a streamed replacement exceeds the size limit', async () => {
    const { projectRootPath, service } = await createService({ maxFileBytes: 4 })
    await service.writeFile('tasks/result.txt', [Buffer.from('old')])

    await expect(
      service.writeFile('tasks/result.txt', [Buffer.from('abc'), Buffer.from('de')]),
    ).rejects.toMatchObject({
      code: 'file_too_large',
      statusCode: 413,
    })

    expect(await readFile(resolve(projectRootPath, 'tasks/result.txt'), 'utf8')).toBe('old')
    expect((await readdir(resolve(projectRootPath, 'tasks'))).some((name) => name.startsWith('.docs-ssh-upload-'))).toBe(false)
  })

  it('blocks traversal, scaffold writes, and symbolic-link traversal', async () => {
    const { projectRootPath, service, tempDir } = await createService()

    await expect(service.writeFile('../outside.txt', [Buffer.from('blocked')])).rejects.toMatchObject({
      code: 'invalid_path',
      statusCode: 400,
    })
    await expect(service.writeFile('README.md', [Buffer.from('blocked')])).rejects.toMatchObject({
      code: 'path_is_read_only',
      statusCode: 403,
    })
    await expect(service.writeFile('tasks/README.md', [Buffer.from('blocked')])).rejects.toMatchObject({
      code: 'path_is_read_only',
      statusCode: 403,
    })
    await expect(service.createDirectory('tasks/README.md/nested')).rejects.toMatchObject({
      code: 'path_is_read_only',
      statusCode: 403,
    })

    const outsidePath = resolve(tempDir, 'outside')
    await mkdir(outsidePath)
    await writeFile(resolve(outsidePath, 'secret.txt'), 'secret')
    await symlink(outsidePath, resolve(projectRootPath, 'tasks/link'))

    await expect(service.getReadableFile('tasks/link/secret.txt')).rejects.toMatchObject({
      code: 'symlink_not_allowed',
      statusCode: 409,
    })
  })
})
