import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runFilesCommand } from './command.js'

const tempDirs: string[] = []

async function createProjectDir(): Promise<{ nestedDir: string, projectDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'docs-ssh-files-command-'))
  tempDirs.push(tempDir)
  const projectDir = resolve(tempDir, 'project')
  const nestedDir = resolve(projectDir, 'nested')
  await mkdir(nestedDir, { recursive: true })
  await writeFile(resolve(projectDir, '.docs-ssh.toml'), [
    'project = "product-docs"',
    'viewer_origin = "https://docs.example.com"',
    '',
  ].join('\n'))
  return { nestedDir, projectDir }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    status,
  })
}

function createOutput() {
  const chunks: Buffer[] = []
  return {
    bytes: () => Buffer.concat(chunks),
    stream: {
      write(chunk: string | Uint8Array) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
      },
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe('runFilesCommand', () => {
  it('lists a configured project with its bearer token and emits JSON', async () => {
    const { nestedDir } = await createProjectDir()
    const stdout = createOutput()
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      expect(url.pathname).toBe('/api/v1/projects/product-docs/entries')
      expect(url.searchParams.get('path')).toBe('tasks')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret-token')
      return jsonResponse({
        entries: [{
          modifiedAt: '2026-08-24T00:00:00.000Z',
          name: 'notes.md',
          path: 'tasks/notes.md',
          size: 12,
          type: 'file',
        }],
        path: 'tasks',
        project: 'product-docs',
      })
    })

    await runFilesCommand(['list', 'tasks', '--json'], {
      cwd: nestedDir,
      env: { DOCS_SSH_TOKEN: 'secret-token' },
      fetch: fetchMock,
      stdout: stdout.stream,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(JSON.parse(stdout.text())).toMatchObject({
      entries: [{ path: 'tasks/notes.md' }],
      project: 'product-docs',
    })
    expect(stdout.text()).not.toContain('secret-token')
  })

  it('passes repeated glob filters and formats search matches like rg', async () => {
    const { nestedDir } = await createProjectDir()
    const stdout = createOutput()
    const stderr = createOutput()
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      expect(url.pathname).toBe('/api/v1/projects/product-docs/search')
      expect(url.searchParams.get('q')).toBe('needle')
      expect(url.searchParams.get('path')).toBe('tasks')
      expect(url.searchParams.getAll('glob')).toEqual(['*.md', '!archive/**'])
      expect(url.searchParams.get('limit')).toBe('2')
      expect(url.searchParams.get('mode')).toBe('regex')
      expect(url.searchParams.get('case')).toBe('insensitive')
      return jsonResponse({
        case: 'insensitive',
        limit: 2,
        matches: [{
          line: 7,
          path: 'tasks/notes.md',
          submatches: [{ end: 6, start: 0, text: 'Needle' }],
          text: 'Needle here',
        }],
        mode: 'regex',
        path: 'tasks',
        project: 'product-docs',
        query: 'needle',
        truncated: true,
      })
    })

    await runFilesCommand([
      'search',
      'needle',
      '--path',
      'tasks',
      '--glob',
      '*.md',
      '--glob',
      '!archive/**',
      '--limit',
      '2',
      '--mode',
      'regex',
      '--case',
      'insensitive',
    ], {
      cwd: nestedDir,
      env: { DOCS_SSH_TOKEN: 'secret-token' },
      fetch: fetchMock,
      stderr: stderr.stream,
      stdout: stdout.stream,
    })

    expect(stdout.text()).toBe('tasks/notes.md:7:Needle here\n')
    expect(stderr.text()).toBe('docs-ssh files: results truncated at 2 matches.\n')
  })

  it('writes local bytes and creates a remote directory', async () => {
    const { nestedDir, projectDir } = await createProjectDir()
    const inputPath = resolve(projectDir, 'payload.bin')
    const inputBytes = Buffer.from([0, 1, 127, 128, 255])
    await writeFile(inputPath, inputBytes)
    const stdout = createOutput()
    const requests: Array<{ body: Buffer, method: string, pathname: string }> = []
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      requests.push({
        body: init?.body ? Buffer.from(await new Response(init.body).arrayBuffer()) : Buffer.alloc(0),
        method: init?.method ?? 'GET',
        pathname: url.pathname,
      })
      if (init?.method === 'PUT') {
        return jsonResponse({
          entry: {
            modifiedAt: '2026-08-24T00:00:00.000Z',
            name: 'payload.bin',
            path: 'tasks/demo/payload.bin',
            size: inputBytes.length,
            type: 'file',
          },
          project: 'product-docs',
        }, 201)
      }
      return jsonResponse({
        entry: {
          modifiedAt: '2026-08-24T00:00:00.000Z',
          name: 'demo',
          path: 'tasks/demo',
          size: null,
          type: 'directory',
        },
        project: 'product-docs',
      }, 201)
    })

    await runFilesCommand([
      'write',
      'tasks/demo/payload.bin',
      '--input',
      '../payload.bin',
      '--json',
    ], {
      cwd: nestedDir,
      env: { DOCS_SSH_TOKEN: 'secret-token' },
      fetch: fetchMock,
      stdout: stdout.stream,
    })
    await runFilesCommand(['mkdir', 'tasks/demo', '--json'], {
      cwd: nestedDir,
      env: { DOCS_SSH_TOKEN: 'secret-token' },
      fetch: fetchMock,
      stdout: stdout.stream,
    })

    expect(requests).toEqual([
      {
        body: inputBytes,
        method: 'PUT',
        pathname: '/api/v1/projects/product-docs/files/tasks%2Fdemo%2Fpayload.bin',
      },
      {
        body: Buffer.from(JSON.stringify({ path: 'tasks/demo' })),
        method: 'POST',
        pathname: '/api/v1/projects/product-docs/directories',
      },
    ])
  })

  it('streams reads as bytes and refuses to replace local output without --force', async () => {
    const { nestedDir } = await createProjectDir()
    const bytes = Buffer.from([0, 255, 10, 42])
    const stdout = createOutput()
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(bytes))

    await runFilesCommand(['read', 'tasks/demo/payload.bin'], {
      cwd: nestedDir,
      env: { DOCS_SSH_TOKEN: 'secret-token' },
      fetch: fetchMock,
      stdout: stdout.stream,
    })
    expect(stdout.bytes()).toEqual(bytes)

    await expect(runFilesCommand(['read', 'tasks/demo/payload.bin', '--force'], {
      cwd: nestedDir,
      env: { DOCS_SSH_TOKEN: 'secret-token' },
      fetch: fetchMock,
      stdout: stdout.stream,
    })).rejects.toThrow('--force requires --output')
    expect(fetchMock).toHaveBeenCalledOnce()

    const outputPath = resolve(nestedDir, 'download.bin')
    await writeFile(outputPath, 'existing')
    await expect(runFilesCommand([
      'read',
      'tasks/demo/payload.bin',
      '--output',
      'download.bin',
    ], {
      cwd: nestedDir,
      env: { DOCS_SSH_TOKEN: 'secret-token' },
      fetch: fetchMock,
      stdout: stdout.stream,
    })).rejects.toThrow('Pass --force to replace it')
    expect(await readFile(outputPath, 'utf8')).toBe('existing')
  })

  it('requires an injected token and reports structured API errors', async () => {
    const { nestedDir } = await createProjectDir()
    await expect(runFilesCommand(['list'], {
      cwd: nestedDir,
      env: {},
    })).rejects.toThrow('DOCS_SSH_TOKEN is required')

    await expect(runFilesCommand(['list'], {
      cwd: nestedDir,
      env: { DOCS_SSH_TOKEN: 'secret-token' },
      fetch: async () => jsonResponse({
        error: {
          code: 'insufficient_scope',
          message: 'Project write scope is required.',
        },
      }, 403),
    })).rejects.toThrow('HTTP 403 insufficient_scope: Project write scope is required.')
  })
})
