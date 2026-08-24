import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const servers: Server[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe('docs-ssh files', () => {
  it('routes CLI requests through the HTTP Files API', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'docs-ssh-cli-files-'))
    tempDirs.push(tempDir)

    const server = createServer((request, response) => {
      expect(request.url).toBe('/api/v1/projects/product-docs/entries?path=tasks')
      expect(request.headers.authorization).toBe('Bearer test-token')
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        entries: [{
          modifiedAt: '2026-08-24T00:00:00.000Z',
          name: 'notes.md',
          path: 'tasks/notes.md',
          size: 12,
          type: 'file',
        }],
        path: 'tasks',
        project: 'product-docs',
      }))
    })
    servers.push(server)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.')

    await writeFile(resolve(tempDir, '.docs-ssh.toml'), [
      'project = "product-docs"',
      `viewer_origin = "http://127.0.0.1:${address.port}"`,
      '',
    ].join('\n'))

    const { stderr, stdout } = await execFileAsync(resolve('node_modules/.bin/tsx'), [
      resolve('src/cli.ts'),
      'files',
      'list',
      'tasks',
      '--json',
    ], {
      cwd: tempDir,
      env: {
        ...process.env,
        DOCS_SSH_TOKEN: 'test-token',
      },
      timeout: 10_000,
    })

    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toMatchObject({
      entries: [{ path: 'tasks/notes.md' }],
      project: 'product-docs',
    })
  }, 15_000)
})
