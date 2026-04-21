import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import ssh2 from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthStore } from '../auth/store.js'
import { createViewerServer } from './server.js'

const tempDirs: string[] = []
const closers: Array<() => Promise<void>> = []
const { utils: sshUtils } = ssh2

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-viewer-'))
  tempDirs.push(dir)
  return dir
}

class CookieJar {
  #cookies = new Map<string, string>()

  absorb(response: Response): void {
    const values = response.headers.getSetCookie?.() ?? []
    for (const value of values) {
      const [pair] = value.split(';', 1)
      if (!pair) continue
      const separatorIndex = pair.indexOf('=')
      if (separatorIndex === -1) continue

      const name = pair.slice(0, separatorIndex)
      const cookieValue = pair.slice(separatorIndex + 1)
      if (!cookieValue) {
        this.#cookies.delete(name)
        continue
      }
      this.#cookies.set(name, cookieValue)
    }
  }

  header(): string | undefined {
    if (this.#cookies.size === 0) return undefined
    return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

function createCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

async function startServer(server: Server): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolveListen((server.address() as AddressInfo).port)
    })
  })
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function createFakeOidcProvider(config: {
  clientId: string
  email?: string
  subject: string
}) {
  const codes = new Map<
    string,
    {
      clientId: string
      codeChallenge: string
      nonce: string
      redirectUri: string
      subject: string
    }
  >()
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const publicJwk = await exportJWK(publicKey) as JWK
  publicJwk.alg = 'RS256'
  publicJwk.kid = 'viewer-test'
  publicJwk.use = 'sig'

  const provider = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`
    const url = new URL(request.url ?? '/', baseUrl)

    if (url.pathname === '/.well-known/openid-configuration') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(
        JSON.stringify({
          authorization_endpoint: `${baseUrl}/authorize`,
          issuer: baseUrl,
          jwks_uri: `${baseUrl}/jwks`,
          token_endpoint: `${baseUrl}/token`,
        }),
      )
      return
    }

    if (url.pathname === '/jwks') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ keys: [publicJwk] }))
      return
    }

    if (url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri')
      const state = url.searchParams.get('state')
      const nonce = url.searchParams.get('nonce')
      const codeChallenge = url.searchParams.get('code_challenge')
      const clientId = url.searchParams.get('client_id')
      if (!redirectUri || !state || !nonce || !codeChallenge || !clientId) {
        response.writeHead(400)
        response.end('invalid authorize request')
        return
      }

      const code = randomUUID()
      codes.set(code, {
        clientId,
        codeChallenge,
        nonce,
        redirectUri,
        subject: config.subject,
      })

      response.writeHead(302, {
        Location: `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      })
      response.end()
      return
    }

    if (url.pathname === '/token') {
      const body = new URLSearchParams(await readRequestBody(request))
      const code = body.get('code')
      const codeVerifier = body.get('code_verifier')
      const redirectUri = body.get('redirect_uri')
      const clientId = body.get('client_id')
      if (!code || !codeVerifier || !redirectUri || !clientId) {
        response.writeHead(400)
        response.end('invalid token request')
        return
      }

      const authorization = codes.get(code)
      if (!authorization) {
        response.writeHead(400)
        response.end('unknown code')
        return
      }

      if (
        authorization.clientId !== clientId
        || authorization.redirectUri !== redirectUri
        || authorization.codeChallenge !== createCodeChallenge(codeVerifier)
      ) {
        response.writeHead(400)
        response.end('pkce mismatch')
        return
      }

      const idToken = await new SignJWT({
        email: config.email,
        nonce: authorization.nonce,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'viewer-test' })
        .setAudience(clientId)
        .setExpirationTime('5m')
        .setIssuedAt()
        .setIssuer(baseUrl)
        .setSubject(authorization.subject)
        .sign(privateKey)

      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(
        JSON.stringify({
          access_token: 'test-access-token',
          id_token: idToken,
          token_type: 'Bearer',
        }),
      )
      return
    }

    response.writeHead(404)
    response.end('not found')
  })

  const port = await startServer(provider)
  closers.push(
    () =>
      new Promise((resolveClose) => {
        provider.close(() => resolveClose())
      }),
  )

  return {
    issuer: `http://127.0.0.1:${port}`,
  }
}

async function createViewerFixture(config: {
  bootstrapOwner?: boolean
  clientId: string
  issuer: string
  linkedIdentity?: {
    issuer: string
    provider: string
    subject: string
  }
}) {
  const tempDir = await createTempDir()
  const docsDir = resolve(tempDir, 'docs')
  const authDbPath = resolve(tempDir, 'state', 'auth.sqlite')
  const workspaceDir = resolve(tempDir, 'workspace')
  await mkdir(docsDir, { recursive: true })
  await writeFile(resolve(docsDir, 'README.md'), '# Viewer Docs\n')

  const authStore = createAuthStore({ dbPath: authDbPath })
  const owner = config.bootstrapOwner === false
    ? null
    : authStore.ensureSingleTenantOwner({
        ownerLogin: 'owner',
        ownerName: 'Owner',
      })

  if (config.linkedIdentity && owner) {
    authStore.addAuthIdentity({
      issuer: config.linkedIdentity.issuer,
      provider: config.linkedIdentity.provider,
      subject: config.linkedIdentity.subject,
      userLogin: owner.user.login,
    })
  }
  authStore.close()

  const viewer = createViewerServer({
    authDbPath,
    docsDir,
    docsName: 'Viewer Docs',
    oidc: {
      clientId: config.clientId,
      issuer: config.issuer,
      provider: 'oidc',
      scope: 'openid email profile',
    },
    port: 0,
    sessionSecret: 'viewer-test-secret',
    staticDir: resolve(tempDir, 'viewer-dist'),
    workspaceDir,
  })
  const port = await viewer.listen()
  closers.push(() => viewer.close())

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    owner,
  }
}

async function fetchWithCookies(url: string, jar: CookieJar, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const cookieHeader = jar.header()
  if (cookieHeader) headers.set('cookie', cookieHeader)

  const response = await fetch(url, {
    ...init,
    headers,
    redirect: 'manual',
  })
  jar.absorb(response)
  return response
}

afterEach(async () => {
  await Promise.all(closers.splice(0).reverse().map((close) => close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe('createViewerServer OIDC session flow', () => {
  it('reports OIDC readiness before login', async () => {
    const clientId = 'docs-ssh-viewer'
    const provider = await createFakeOidcProvider({
      clientId,
      subject: 'user-123',
    })
    const viewer = await createViewerFixture({
      clientId,
      issuer: provider.issuer,
    })

    const response = await fetch(`${viewer.baseUrl}/api/auth/session`)
    const payload = await response.json() as {
      oidc: { enabled: boolean; issuer?: string }
      session: null
    }

    expect(payload.oidc).toEqual({
      enabled: true,
      issuer: provider.issuer,
      provider: 'oidc',
    })
    expect(payload.session).toBeNull()
  })

  it('creates a viewer session after a successful OIDC callback', async () => {
    const clientId = 'docs-ssh-viewer'
    const provider = await createFakeOidcProvider({
      clientId,
      email: 'owner@example.com',
      subject: 'user-123',
    })
    const viewer = await createViewerFixture({
      clientId,
      issuer: provider.issuer,
      linkedIdentity: {
        issuer: provider.issuer,
        provider: 'oidc',
        subject: 'user-123',
      },
    })
    const jar = new CookieJar()

    const loginResponse = await fetchWithCookies(
      `${viewer.baseUrl}/auth/login?returnTo=${encodeURIComponent('/?path=/docs/README.md')}`,
      jar,
    )
    expect(loginResponse.status).toBe(302)
    expect(loginResponse.headers.get('location')).toContain(`${provider.issuer}/authorize?`)

    const authorizeResponse = await fetchWithCookies(loginResponse.headers.get('location')!, jar)
    expect(authorizeResponse.status).toBe(302)

    const callbackResponse = await fetchWithCookies(authorizeResponse.headers.get('location')!, jar)
    expect(callbackResponse.status).toBe(302)
    expect(callbackResponse.headers.get('location')).toBe('/?path=/docs/README.md')

    const sessionResponse = await fetchWithCookies(`${viewer.baseUrl}/api/auth/session`, jar)
    const sessionPayload = await sessionResponse.json() as {
      session: {
        email?: string
        issuer: string
        login: string
        provider: string
        subject: string
        userDisplayName: string
      }
    }

    expect(sessionPayload.session).toMatchObject({
      email: 'owner@example.com',
      issuer: provider.issuer,
      login: viewer.owner!.user.login,
      provider: 'oidc',
      subject: 'user-123',
      userDisplayName: viewer.owner!.user.displayName,
    })
  })

  it('signs up the first web user automatically when auth.db is empty', async () => {
    const clientId = 'docs-ssh-viewer'
    const provider = await createFakeOidcProvider({
      clientId,
      email: 'first.owner@example.com',
      subject: 'first-owner',
    })
    const viewer = await createViewerFixture({
      bootstrapOwner: false,
      clientId,
      issuer: provider.issuer,
    })
    const jar = new CookieJar()

    const loginResponse = await fetchWithCookies(`${viewer.baseUrl}/auth/login`, jar)
    const authorizeResponse = await fetchWithCookies(loginResponse.headers.get('location')!, jar)
    const callbackResponse = await fetchWithCookies(authorizeResponse.headers.get('location')!, jar)

    expect(callbackResponse.status).toBe(302)
    expect(callbackResponse.headers.get('location')).toBe('/')

    const sessionResponse = await fetchWithCookies(`${viewer.baseUrl}/api/auth/session`, jar)
    const sessionPayload = await sessionResponse.json() as {
      session: {
        email?: string
        issuer: string
        login: string
        provider: string
        subject: string
        userDisplayName: string
      }
    }

    expect(sessionPayload.session).toMatchObject({
      email: 'first.owner@example.com',
      issuer: provider.issuer,
      login: 'first-owner',
      provider: 'oidc',
      subject: 'first-owner',
      userDisplayName: 'first.owner@example.com',
    })
  })

  it('rejects OIDC callbacks for identities that are not linked in auth.db', async () => {
    const clientId = 'docs-ssh-viewer'
    const provider = await createFakeOidcProvider({
      clientId,
      subject: 'unknown-user',
    })
    const viewer = await createViewerFixture({
      clientId,
      issuer: provider.issuer,
    })
    const jar = new CookieJar()

    const loginResponse = await fetchWithCookies(`${viewer.baseUrl}/auth/login`, jar)
    const authorizeResponse = await fetchWithCookies(loginResponse.headers.get('location')!, jar)
    const callbackResponse = await fetchWithCookies(authorizeResponse.headers.get('location')!, jar)

    expect(callbackResponse.status).toBe(403)
    const callbackHtml = await callbackResponse.text()
    expect(callbackHtml).toContain('This web identity is not linked to a docs-ssh user yet.')
    expect(callbackHtml).toContain('unknown-user')
    expect(callbackHtml).toContain(`--provider 'oidc'`)
    expect(callbackHtml).toContain(`--issuer '${provider.issuer}'`)
    expect(callbackHtml).toContain(`--subject 'unknown-user'`)
    expect(callbackHtml).not.toContain('auth init')

    const sessionResponse = await fetchWithCookies(`${viewer.baseUrl}/api/auth/session`, jar)
    const sessionPayload = await sessionResponse.json() as { session: null }
    expect(sessionPayload.session).toBeNull()
  })

  it('lists and adds SSH keys for the signed-in user', async () => {
    const clientId = 'docs-ssh-viewer'
    const provider = await createFakeOidcProvider({
      clientId,
      email: 'owner@example.com',
      subject: 'user-123',
    })
    const viewer = await createViewerFixture({
      clientId,
      issuer: provider.issuer,
      linkedIdentity: {
        issuer: provider.issuer,
        provider: 'oidc',
        subject: 'user-123',
      },
    })
    const jar = new CookieJar()

    const loginResponse = await fetchWithCookies(`${viewer.baseUrl}/auth/login`, jar)
    const authorizeResponse = await fetchWithCookies(loginResponse.headers.get('location')!, jar)
    await fetchWithCookies(authorizeResponse.headers.get('location')!, jar)

    const emptyListResponse = await fetchWithCookies(`${viewer.baseUrl}/api/auth/ssh-keys`, jar)
    const emptyListPayload = await emptyListResponse.json() as { keys: Array<unknown> }
    expect(emptyListResponse.status).toBe(200)
    expect(emptyListPayload.keys).toEqual([])

    const keyPair = sshUtils.generateKeyPairSync('ed25519')
    const addResponse = await fetchWithCookies(`${viewer.baseUrl}/api/auth/ssh-keys`, jar, {
      body: JSON.stringify({
        name: 'Laptop',
        publicKey: keyPair.public,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    const addPayload = await addResponse.json() as {
      key: {
        algorithm: string
        fingerprint: string
        name: string | null
      }
    }

    expect(addResponse.status).toBe(200)
    expect(addPayload.key.name).toBe('Laptop')
    expect(addPayload.key.algorithm).toBe('ssh-ed25519')
    expect(addPayload.key.fingerprint.startsWith('SHA256:')).toBe(true)

    const listResponse = await fetchWithCookies(`${viewer.baseUrl}/api/auth/ssh-keys`, jar)
    const listPayload = await listResponse.json() as {
      keys: Array<{
        algorithm: string
        fingerprint: string
        name: string | null
      }>
    }

    expect(listResponse.status).toBe(200)
    expect(listPayload.keys).toHaveLength(1)
    expect(listPayload.keys[0]).toMatchObject({
      algorithm: 'ssh-ed25519',
      fingerprint: addPayload.key.fingerprint,
      name: 'Laptop',
    })
  })

  it('rejects SSH key management without a signed-in session', async () => {
    const clientId = 'docs-ssh-viewer'
    const provider = await createFakeOidcProvider({
      clientId,
      subject: 'user-123',
    })
    const viewer = await createViewerFixture({
      clientId,
      issuer: provider.issuer,
    })

    const listResponse = await fetch(`${viewer.baseUrl}/api/auth/ssh-keys`)
    const listPayload = await listResponse.json() as { error: string }
    expect(listResponse.status).toBe(401)
    expect(listPayload.error).toContain('Sign in')

    const keyPair = sshUtils.generateKeyPairSync('ed25519')
    const addResponse = await fetch(`${viewer.baseUrl}/api/auth/ssh-keys`, {
      body: JSON.stringify({
        publicKey: keyPair.public,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    const addPayload = await addResponse.json() as { error: string }
    expect(addResponse.status).toBe(401)
    expect(addPayload.error).toContain('Sign in')
  })
})
