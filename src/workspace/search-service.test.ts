import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceFileService } from './file-service.js'
import { ensureWorkspaceLayout } from './layout.js'
import { RgWorkspaceSearchProvider } from './search-service.js'

const tempDirs: string[] = []

async function createSearchProvider() {
  const tempDir = await mkdtemp(join(tmpdir(), 'docs-ssh-search-'))
  tempDirs.push(tempDir)
  const tenantRootPath = resolve(tempDir, 'tenant')
  const projectRootPath = resolve(tenantRootPath, 'projects/default')
  await ensureWorkspaceLayout(tenantRootPath, { projectRootPath })
  const fileService = await WorkspaceFileService.create(projectRootPath, {
    readOnlyPaths: ['README.md', 'issues/README.md', 'tasks/README.md'],
    writableDirectories: ['issues', 'tasks'],
  })
  return {
    projectRootPath,
    provider: new RgWorkspaceSearchProvider(fileService),
    tempDir,
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe('RgWorkspaceSearchProvider', () => {
  it('returns structured literal matches relative to the project root', async () => {
    const { projectRootPath, provider } = await createSearchProvider()
    const searchRoot = resolve(projectRootPath, 'tasks/search')
    await mkdir(searchRoot, { recursive: true })
    await writeFile(resolve(searchRoot, 'notes.md'), 'First Needle\nsecond needle\n日本語 needle\n')
    await writeFile(resolve(searchRoot, 'skip.txt'), 'needle\n')

    await expect(provider.search({
      globs: ['*.md'],
      path: 'tasks/search',
      query: 'needle',
    })).resolves.toEqual({
      caseSensitivity: 'smart',
      limit: 100,
      matches: [
        {
          line: 1,
          path: 'tasks/search/notes.md',
          submatches: [{ end: 12, start: 6, text: 'Needle' }],
          text: 'First Needle',
        },
        {
          line: 2,
          path: 'tasks/search/notes.md',
          submatches: [{ end: 13, start: 7, text: 'needle' }],
          text: 'second needle',
        },
        {
          line: 3,
          path: 'tasks/search/notes.md',
          submatches: [{ end: 10, start: 4, text: 'needle' }],
          text: '日本語 needle',
        },
      ],
      mode: 'literal',
      path: 'tasks/search',
      query: 'needle',
      truncated: false,
    })
  })

  it('supports regex mode and reports when the global result limit truncates matches', async () => {
    const { projectRootPath, provider } = await createSearchProvider()
    const searchRoot = resolve(projectRootPath, 'tasks/search')
    await mkdir(searchRoot, { recursive: true })
    await writeFile(resolve(searchRoot, 'a.md'), 'item-1\nitem-2\n')
    await writeFile(resolve(searchRoot, 'b.md'), 'item-3\n')

    const result = await provider.search({
      caseSensitivity: 'sensitive',
      limit: 2,
      mode: 'regex',
      path: 'tasks/search',
      query: String.raw`item-\d`,
    })

    expect(result.matches.map((match) => [match.path, match.line])).toEqual([
      ['tasks/search/a.md', 1],
      ['tasks/search/a.md', 2],
    ])
    expect(result.truncated).toBe(true)
  })

  it('searches visible hidden files but excludes in-flight HTTP upload files', async () => {
    const { projectRootPath, provider } = await createSearchProvider()
    const searchRoot = resolve(projectRootPath, 'tasks/search')
    await mkdir(searchRoot, { recursive: true })
    await writeFile(resolve(searchRoot, '.hidden.md'), 'find-hidden\n')
    await writeFile(resolve(searchRoot, '.docs-ssh-upload-test'), 'find-hidden\n')

    const result = await provider.search({
      path: 'tasks/search',
      query: 'find-hidden',
    })

    expect(result.matches.map((match) => match.path)).toEqual(['tasks/search/.hidden.md'])
  })

  it('does not follow symbolic links while searching', async () => {
    const { projectRootPath, provider, tempDir } = await createSearchProvider()
    const searchRoot = resolve(projectRootPath, 'tasks/search')
    const outsideRoot = resolve(tempDir, 'outside')
    await mkdir(searchRoot, { recursive: true })
    await mkdir(outsideRoot)
    await writeFile(resolve(outsideRoot, 'secret.md'), 'outside-secret\n')
    await symlink(outsideRoot, resolve(searchRoot, 'link'))

    const result = await provider.search({
      path: 'tasks/search',
      query: 'outside-secret',
    })

    expect(result.matches).toEqual([])
  })

  it('rejects invalid search inputs and paths', async () => {
    const { projectRootPath, provider } = await createSearchProvider()
    await writeFile(resolve(projectRootPath, 'tasks/result.md'), 'result\n')

    await expect(provider.search({ query: '' })).rejects.toMatchObject({
      code: 'invalid_query',
      statusCode: 400,
    })
    await expect(provider.search({ mode: 'regex', query: '[' })).rejects.toMatchObject({
      code: 'invalid_pattern',
      statusCode: 400,
    })
    await expect(provider.search({ globs: ['['], query: 'result' })).rejects.toMatchObject({
      code: 'invalid_glob',
      statusCode: 400,
    })
    await expect(provider.search({ path: '../outside', query: 'result' })).rejects.toMatchObject({
      code: 'invalid_path',
      statusCode: 400,
    })
    await expect(provider.search({ path: 'tasks/result.md', query: 'result' })).rejects.toMatchObject({
      code: 'not_a_directory',
      statusCode: 409,
    })
  })
})
