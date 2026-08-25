import { execFile, spawn } from 'node:child_process'
import { createServer, type IncomingMessage } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-cli-token-'))
  tempDirs.push(dir)
  return dir
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function execFileWithInput(
  file: string,
  args: string[],
  input: string,
  options: {
    cwd: string
    timeout?: number
  },
): Promise<{
  stdout: string
  stderr: string
}> {
  return new Promise((resolveExec, rejectExec) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = options.timeout
      ? setTimeout(() => {
        child.kill()
        rejectExec(new Error(`Command timed out after ${options.timeout}ms.`))
      }, options.timeout)
      : null

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      if (timeout) clearTimeout(timeout)
      rejectExec(error)
    })
    child.once('close', (code) => {
      if (timeout) clearTimeout(timeout)
      if (code === 0) {
        resolveExec({ stdout, stderr })
        return
      }
      const error = new Error(`Command failed with exit code ${code}.`)
      Object.assign(error, { stderr, stdout })
      rejectExec(error)
    })
    child.stdin.end(input)
  })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe('docs-ssh login', () => {
  it('rejects unknown flags before inferring a viewer origin', async () => {
    const homeDir = await createTempDir()

    await expect(execFileAsync(resolve('node_modules/.bin/tsx'), [
      'src/cli.ts',
      'login',
      '--server',
      'docs-ssh',
      '--viewr-origin',
      'https://viewer.example.test',
      '--json',
      '--no-open',
      '--home',
      homeDir,
    ], {
      cwd: resolve('.'),
      timeout: 10_000,
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('Unknown flag --viewr-origin. Did you mean --viewer-origin?'),
    })
  }, 15_000)

  it('prints the viewer origin when the login viewer cannot be reached', async () => {
    const homeDir = await createTempDir()

    await expect(execFileAsync(resolve('node_modules/.bin/tsx'), [
      'src/cli.ts',
      'login',
      '--host',
      'docs.example.com',
      '--viewer-origin',
      'http://127.0.0.1:1',
      '--json',
      '--no-open',
      '--home',
      homeDir,
    ], {
      cwd: resolve('.'),
      timeout: 10_000,
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('Could not reach docs-ssh viewer at http://127.0.0.1:1'),
    })
  }, 15_000)

  it('creates a web SSH session without binding the login request to a project', async () => {
    const homeDir = await createTempDir()
    let receivedRequestPayload: Record<string, unknown> | undefined
    let receivedExchangePayload: Record<string, unknown> | undefined

    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'POST' && url.pathname === '/api/cli-login/requests') {
        receivedRequestPayload = JSON.parse(await readRequestBody(request)) as Record<string, unknown>
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          expiresAt: '2026-05-29T01:00:00.000Z',
          id: 'request-1',
          loginUrl: `${viewerOrigin}/cli-login/request-1`,
        }))

        setTimeout(() => {
          const callbackUrl = new URL(String(receivedRequestPayload?.callbackUrl))
          callbackUrl.searchParams.set('code', 'cli-code')
          callbackUrl.searchParams.set('request', 'request-1')
          callbackUrl.searchParams.set('state', String(receivedRequestPayload?.state))
          void fetch(callbackUrl)
        }, 10)
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/cli-login/exchange') {
        receivedExchangePayload = JSON.parse(await readRequestBody(request)) as Record<string, unknown>
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          session: {
            createdAt: '2026-05-29T00:00:00.000Z',
            expiresAt: '2026-05-29T01:00:00.000Z',
            fingerprint: 'SHA256:webfingerprint',
            project: 'default',
            scopes: ['bootstrap:read', 'project:read'],
            username: 'docs-ssh-web-user',
          },
        }))
        return
      }

      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
    })

    let viewerOrigin = ''
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', rejectListen)
          resolveListen()
        })
      })
      const port = (server.address() as AddressInfo).port
      viewerOrigin = `http://127.0.0.1:${port}`

      const { stdout } = await execFileAsync(resolve('node_modules/.bin/tsx'), [
        'src/cli.ts',
        'login',
        '--project',
        'missing-project',
        '--host',
        'docs.example.com',
        '--viewer-origin',
        viewerOrigin,
        '--ttl-seconds',
        '120',
        '--json',
        '--no-open',
        '--home',
        homeDir,
      ], {
        cwd: resolve('.'),
        timeout: 10_000,
      })

      expect(receivedRequestPayload).toMatchObject({
        ttlSeconds: 120,
      })
      expect(receivedRequestPayload).not.toHaveProperty('project')
      expect(receivedRequestPayload?.publicKey).toEqual(expect.stringMatching(/^ssh-ed25519 /u))
      expect(receivedExchangePayload).toMatchObject({
        code: 'cli-code',
        request: 'request-1',
      })

      const sessionPath = resolve(homeDir, 'sessions', 'docs.example.com', 'session.json')
      const sessionFile = JSON.parse(await readFile(sessionPath, 'utf8')) as Record<string, unknown>
      const printedSession = JSON.parse(stdout) as Record<string, unknown>
      expect(printedSession).toEqual(sessionFile)
      expect(sessionFile).toMatchObject({
        expiresAt: '2026-05-29T01:00:00.000Z',
        fingerprint: 'SHA256:webfingerprint',
        project: 'default',
        scopes: ['bootstrap:read', 'project:read'],
        server: 'docs.example.com',
        sshCommand: expect.stringContaining('docs-ssh-web-user@docs.example.com'),
        username: 'docs-ssh-web-user',
        viewerOrigin,
      })
      expect(sessionFile.identityFile).toEqual(resolve(homeDir, 'sessions', 'docs.example.com', 'id_ed25519'))
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
      })
    }
  }, 15_000)

  it('prompts for viewer origin when login has no configured viewer', async () => {
    const homeDir = await createTempDir()
    const workDir = await createTempDir()
    let receivedRequestPayload: Record<string, unknown> | undefined

    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'POST' && url.pathname === '/api/cli-login/requests') {
        receivedRequestPayload = JSON.parse(await readRequestBody(request)) as Record<string, unknown>
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          expiresAt: '2026-05-29T01:00:00.000Z',
          id: 'request-1',
          loginUrl: `${viewerOrigin}/cli-login/request-1`,
        }))

        setTimeout(() => {
          const callbackUrl = new URL(String(receivedRequestPayload?.callbackUrl))
          callbackUrl.searchParams.set('code', 'cli-code')
          callbackUrl.searchParams.set('request', 'request-1')
          callbackUrl.searchParams.set('state', String(receivedRequestPayload?.state))
          void fetch(callbackUrl)
        }, 10)
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/cli-login/exchange') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          session: {
            createdAt: '2026-05-29T00:00:00.000Z',
            expiresAt: '2026-05-29T01:00:00.000Z',
            fingerprint: 'SHA256:webfingerprint',
            project: 'default',
            scopes: ['bootstrap:read', 'project:read'],
            username: 'docs-ssh-web-user',
          },
        }))
        return
      }

      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
    })

    let viewerOrigin = ''
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', rejectListen)
          resolveListen()
        })
      })
      const port = (server.address() as AddressInfo).port
      viewerOrigin = `http://127.0.0.1:${port}`

      const { stderr, stdout } = await execFileWithInput(resolve('node_modules/.bin/tsx'), [
        resolve('src/cli.ts'),
        'login',
        '--interactive',
        '--host',
        'docs.example.com',
        '--json',
        '--no-open',
        '--home',
        homeDir,
      ], `${viewerOrigin}\n`, {
        cwd: workDir,
        timeout: 10_000,
      })

      expect(stderr).toContain('Viewer origin')
      expect(receivedRequestPayload?.publicKey).toEqual(expect.stringMatching(/^ssh-ed25519 /u))
      expect(JSON.parse(stdout)).toMatchObject({
        server: 'docs.example.com',
        username: 'docs-ssh-web-user',
        viewerOrigin,
      })
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
      })
    }
  }, 15_000)
})

describe('docs-ssh token login', () => {
  it('creates an SSH session through a Bearer token and writes the CLI session file', async () => {
    const homeDir = await createTempDir()
    let receivedAuthorization: string | undefined
    let receivedPayload: Record<string, unknown> | undefined

    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method !== 'POST' || url.pathname !== '/api/ssh-sessions') {
        response.writeHead(404, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'not found' }))
        return
      }

      receivedAuthorization = request.headers.authorization
      receivedPayload = JSON.parse(await readRequestBody(request)) as Record<string, unknown>
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        session: {
          createdAt: '2026-05-29T00:00:00.000Z',
          expiresAt: '2026-05-29T01:00:00.000Z',
          fingerprint: 'SHA256:testfingerprint',
          project: 'product-docs',
          scopes: ['project:read', 'sources:read', 'ssh-session:create'],
          username: 'docs-ssh-token-user',
        },
      }))
    })

    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', rejectListen)
          resolveListen()
        })
      })
      const port = (server.address() as AddressInfo).port
      const viewerOrigin = `http://127.0.0.1:${port}`

      const { stdout } = await execFileAsync(resolve('node_modules/.bin/tsx'), [
        'src/cli.ts',
        'token',
        'login',
        '--token',
        'dssh_test_token',
        '--project',
        'product-docs',
        '--host',
        'docs.example.com',
        '--viewer-origin',
        viewerOrigin,
        '--ttl-seconds',
        '120',
        '--json',
        '--home',
        homeDir,
      ], {
        cwd: resolve('.'),
        timeout: 10_000,
      })

      expect(receivedAuthorization).toBe('Bearer dssh_test_token')
      expect(receivedPayload).toMatchObject({
        project: 'product-docs',
        ttlSeconds: 120,
      })
      expect(receivedPayload?.publicKey).toEqual(expect.stringMatching(/^ssh-ed25519 /u))

      const sessionPath = resolve(homeDir, 'sessions', 'docs.example.com', 'product-docs', 'session.json')
      const sessionFile = JSON.parse(await readFile(sessionPath, 'utf8')) as Record<string, unknown>
      const printedSession = JSON.parse(stdout) as Record<string, unknown>
      expect(printedSession).toEqual(sessionFile)
      expect(sessionFile).toMatchObject({
        expiresAt: '2026-05-29T01:00:00.000Z',
        fingerprint: 'SHA256:testfingerprint',
        project: 'product-docs',
        scopes: ['project:read', 'sources:read', 'ssh-session:create'],
        server: 'docs.example.com',
        sshCommand: expect.stringContaining('docs-ssh-token-user@docs.example.com'),
        username: 'docs-ssh-token-user',
        viewerOrigin,
      })
      expect(sessionFile.identityFile).toEqual(resolve(homeDir, 'sessions', 'docs.example.com', 'product-docs', 'id_ed25519'))
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
      })
    }
  }, 15_000)
})
