import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
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
  extraUsers?: Array<{
    displayName: string
    identity: {
      issuer: string
      provider: string
      subject: string
    }
    login: string
    role: 'owner' | 'admin' | 'member'
  }>
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
  for (const user of config.extraUsers ?? []) {
    authStore.addUser({
      displayName: user.displayName,
      identity: user.identity,
      login: user.login,
      role: user.role,
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
    authDbPath,
    baseUrl: `http://127.0.0.1:${port}`,
    owner,
    workspaceDir,
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
      signupAvailable: false,
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
      `${viewer.baseUrl}/auth/login?returnTo=${encodeURIComponent('/?path=/projects/default/README.md')}`,
      jar,
    )
    expect(loginResponse.status).toBe(302)
    expect(loginResponse.headers.get('location')).toContain(`${provider.issuer}/authorize?`)

    const authorizeResponse = await fetchWithCookies(loginResponse.headers.get('location')!, jar)
    expect(authorizeResponse.status).toBe(302)

    const callbackResponse = await fetchWithCookies(authorizeResponse.headers.get('location')!, jar)
    expect(callbackResponse.status).toBe(302)
    expect(callbackResponse.headers.get('location')).toBe('/?path=/projects/default/README.md')

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

  it('requires a signed-in session for viewer file data and raw files', async () => {
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
    const rawPath = '/projects/default/README.md'
    const encodedRawPath = encodeURIComponent(rawPath)

    const treeResponse = await fetch(`${viewer.baseUrl}/api/tree`)
    const treePayload = await treeResponse.json() as { error: string }
    expect(treeResponse.status).toBe(401)
    expect(treePayload.error).toContain('Sign in')

    const fileResponse = await fetch(`${viewer.baseUrl}/api/file?path=${encodedRawPath}`)
    const filePayload = await fileResponse.json() as { error: string }
    expect(fileResponse.status).toBe(401)
    expect(filePayload.error).toContain('Sign in')

    const rawResponse = await fetch(`${viewer.baseUrl}/api/raw?path=${encodedRawPath}`, {
      redirect: 'manual',
    })
    expect(rawResponse.status).toBe(302)
    const rawLocation = rawResponse.headers.get('location')
    expect(rawLocation).toBeTruthy()
    const rawLoginUrl = new URL(rawLocation!, viewer.baseUrl)
    expect(rawLoginUrl.pathname).toBe('/auth/login')
    expect(rawLoginUrl.searchParams.get('returnTo')).toBe(`/api/raw?path=${encodedRawPath}`)

    const jar = new CookieJar()
    const loginResponse = await fetchWithCookies(`${viewer.baseUrl}/auth/login`, jar)
    const authorizeResponse = await fetchWithCookies(loginResponse.headers.get('location')!, jar)
    await fetchWithCookies(authorizeResponse.headers.get('location')!, jar)

    const signedRawResponse = await fetchWithCookies(`${viewer.baseUrl}/api/raw?path=${encodedRawPath}`, jar)
    expect(signedRawResponse.status).toBe(200)
    expect(await signedRawResponse.text()).toContain('# Project')
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

    const initialSessionResponse = await fetch(`${viewer.baseUrl}/api/auth/session`)
    const initialSessionPayload = await initialSessionResponse.json() as {
      oidc: { signupAvailable?: boolean }
      session: null
    }
    expect(initialSessionPayload.oidc.signupAvailable).toBe(true)
    expect(initialSessionPayload.session).toBeNull()

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
    expect(callbackHtml).toContain('Access request needed')
    expect(callbackHtml).toContain('new accounts must be added by an owner')
    expect(callbackHtml).toContain('If you already have access')
    expect(callbackHtml).toContain('If you are a new user')
    expect(callbackHtml).toContain('Try another Google account')
    expect(callbackHtml).toContain('unknown-user')
    expect(callbackHtml).not.toContain('Owner CLI command')
    expect(callbackHtml).not.toContain('auth add-web-identity')
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

  it('creates projects and exposes every accessible project in the tree', async () => {
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

    const initialProjectsResponse = await fetchWithCookies(`${viewer.baseUrl}/api/projects`, jar)
    const initialProjects = await initialProjectsResponse.json() as {
      projects: Array<{ slug: string }>
    }
    expect(initialProjects.projects.map((project) => project.slug)).toEqual(['default'])

    const createProjectResponse = await fetchWithCookies(`${viewer.baseUrl}/api/projects`, jar, {
      body: JSON.stringify({
        displayName: 'Product Docs',
        slug: 'product-docs',
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    const createProjectPayload = await createProjectResponse.json() as {
      project: {
        displayName: string
        slug: string
      }
    }
    expect(createProjectResponse.status).toBe(200)
    expect(createProjectPayload.project).toMatchObject({
      displayName: 'Product Docs',
      slug: 'product-docs',
    })
    await expect(
      stat(resolve(viewer.workspaceDir, 'tenants', 'default', 'projects', 'product-docs', 'README.md')),
    ).resolves.toBeTruthy()

    const treeResponse = await fetchWithCookies(`${viewer.baseUrl}/api/tree?project=product-docs`, jar)
    const treePayload = await treeResponse.json() as {
      mounts: Array<{ aliases: string[], mountPath: string }>
      tree: Array<{ name: string, path: string }>
    }
    expect(treeResponse.status).toBe(200)
    expect(treePayload.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          aliases: [],
          mountPath: '/projects/default',
        }),
        expect.objectContaining({
          aliases: [],
          mountPath: '/projects/product-docs',
        }),
      ]),
    )
    expect(treePayload.tree.map((node) => node.path)).toEqual(
      expect.arrayContaining(['/projects/default', '/projects/product-docs']),
    )

    const missingTreeResponse = await fetchWithCookies(`${viewer.baseUrl}/api/tree?project=missing-project`, jar)
    expect(missingTreeResponse.status).toBe(404)

    const sessionKeyPair = sshUtils.generateKeyPairSync('ed25519')
    const createSessionResponse = await fetchWithCookies(`${viewer.baseUrl}/api/ssh-sessions`, jar, {
      body: JSON.stringify({
        project: 'product-docs',
        publicKey: sessionKeyPair.public,
        ttlSeconds: 600,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    const createSessionPayload = await createSessionResponse.json() as {
      session: {
        expiresAt: string
        fingerprint: string
        project: string
        username: string
      }
    }
    expect(createSessionResponse.status).toBe(200)
    expect(createSessionPayload.session).toMatchObject({
      project: 'product-docs',
    })
    expect(createSessionPayload.session.username).toMatch(/^sess_[a-f0-9]{16}$/)
    expect(createSessionPayload.session.fingerprint.startsWith('SHA256:')).toBe(true)
    expect(Date.parse(createSessionPayload.session.expiresAt)).toBeGreaterThan(Date.now())

    const cliSessionKeyPair = sshUtils.generateKeyPairSync('ed25519')
    const cliRequestResponse = await fetch(`${viewer.baseUrl}/api/cli-login/requests`, {
      body: JSON.stringify({
        callbackUrl: 'http://127.0.0.1:54321/callback',
        project: 'product-docs',
        publicKey: cliSessionKeyPair.public,
        state: 'cli-state',
        ttlSeconds: 600,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    const cliRequestPayload = await cliRequestResponse.json() as {
      id: string
      loginUrl: string
    }
    expect(cliRequestResponse.status).toBe(200)
    expect(cliRequestPayload.loginUrl).toBe(`${viewer.baseUrl}/cli-login/${cliRequestPayload.id}`)

    const cliLoginResponse = await fetchWithCookies(cliRequestPayload.loginUrl, jar)
    expect(cliLoginResponse.status).toBe(200)
    const cliLoginHtml = await cliLoginResponse.text()
    const approveToken = /name="approveToken" value="([^"]+)"/u.exec(cliLoginHtml)?.[1]
    expect(approveToken).toBeTruthy()

    const cliApproveResponse = await fetchWithCookies(`${viewer.baseUrl}/cli-login/${cliRequestPayload.id}/approve`, jar, {
      body: new URLSearchParams({ approveToken: approveToken! }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    })
    expect(cliApproveResponse.status).toBe(302)
    const cliCallbackUrl = new URL(cliApproveResponse.headers.get('location')!)
    expect(cliCallbackUrl.origin).toBe('http://127.0.0.1:54321')
    expect(cliCallbackUrl.searchParams.get('state')).toBe('cli-state')
    expect(cliCallbackUrl.searchParams.get('request')).toBe(cliRequestPayload.id)

    const cliExchangeResponse = await fetch(`${viewer.baseUrl}/api/cli-login/exchange`, {
      body: JSON.stringify({
        code: cliCallbackUrl.searchParams.get('code'),
        request: cliCallbackUrl.searchParams.get('request'),
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    const cliExchangePayload = await cliExchangeResponse.json() as {
      session: {
        fingerprint: string
        project: string
        username: string
      }
    }
    expect(cliExchangeResponse.status).toBe(200)
    expect(cliExchangePayload.session.project).toBe('product-docs')
    expect(cliExchangePayload.session.username).toMatch(/^sess_[a-f0-9]{16}$/)
    expect(cliExchangePayload.session.fingerprint.startsWith('SHA256:')).toBe(true)
  })

  it('updates and archives projects through the viewer API', async () => {
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

    await fetchWithCookies(`${viewer.baseUrl}/api/projects`, jar, {
      body: JSON.stringify({
        displayName: 'Product Docs',
        slug: 'product-docs',
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })

    const updateProjectResponse = await fetchWithCookies(`${viewer.baseUrl}/api/projects`, jar, {
      body: JSON.stringify({
        displayName: 'Product Knowledge',
        slug: 'product-docs',
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'PATCH',
    })
    const updateProjectPayload = await updateProjectResponse.json() as {
      project: {
        displayName: string
        slug: string
      }
    }
    expect(updateProjectResponse.status).toBe(200)
    expect(updateProjectPayload.project).toMatchObject({
      displayName: 'Product Knowledge',
      slug: 'product-docs',
    })

    const renameProjectResponse = await fetchWithCookies(`${viewer.baseUrl}/api/projects`, jar, {
      body: JSON.stringify({
        newSlug: 'product-knowledge',
        slug: 'product-docs',
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'PATCH',
    })
    const renameProjectPayload = await renameProjectResponse.json() as { error: string }
    expect(renameProjectResponse.status).toBe(400)
    expect(renameProjectPayload.error).toContain('Project slugs cannot be changed')

    const archiveProjectResponse = await fetchWithCookies(
      `${viewer.baseUrl}/api/projects?slug=${encodeURIComponent('product-docs')}`,
      jar,
      {
        method: 'DELETE',
      },
    )
    const archiveProjectPayload = await archiveProjectResponse.json() as {
      project: {
        archivedAt?: string | null
        slug: string
      }
    }
    expect(archiveProjectResponse.status).toBe(200)
    expect(archiveProjectPayload.project).toMatchObject({
      archivedAt: expect.any(String),
      slug: 'product-docs',
    })

    const projectsResponse = await fetchWithCookies(`${viewer.baseUrl}/api/projects`, jar)
    const projectsPayload = await projectsResponse.json() as {
      projects: Array<{ slug: string }>
    }
    expect(projectsPayload.projects.map((project) => project.slug)).toEqual(['default'])
  })

  it('lets owners list and add web users', async () => {
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

    const initialUsersResponse = await fetchWithCookies(`${viewer.baseUrl}/api/users`, jar)
    const initialUsers = await initialUsersResponse.json() as {
      users: Array<{ login: string; role: string }>
    }
    expect(initialUsersResponse.status).toBe(200)
    expect(initialUsers.users).toEqual([
      expect.objectContaining({
        login: 'owner',
        role: 'owner',
      }),
    ])

    const createUserResponse = await fetchWithCookies(`${viewer.baseUrl}/api/users`, jar, {
      body: JSON.stringify({
        displayName: 'Bob Member',
        email: 'bob@example.com',
        issuer: provider.issuer,
        login: 'bob',
        provider: 'oidc',
        role: 'member',
        subject: 'bob-subject',
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    const createUserPayload = await createUserResponse.json() as {
      user: {
        identities: Array<{ email?: string; issuer: string; provider: string; subject: string }>
        login: string
        role: string
      }
      users: Array<{ login: string; role: string }>
    }
    expect(createUserResponse.status).toBe(200)
    expect(createUserPayload.user).toMatchObject({
      identities: [
        {
          email: 'bob@example.com',
          issuer: provider.issuer,
          provider: 'oidc',
          subject: 'bob-subject',
        },
      ],
      login: 'bob',
      role: 'member',
    })
    expect(createUserPayload.users.map((user) => [user.login, user.role])).toEqual([
      ['owner', 'owner'],
      ['bob', 'member'],
    ])
  })

  it('creates project-scoped API tokens and uses them for SSH sessions', async () => {
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

    const createProjectResponse = await fetchWithCookies(`${viewer.baseUrl}/api/projects`, jar, {
      body: JSON.stringify({
        displayName: 'Product Docs',
        slug: 'product-docs',
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    expect(createProjectResponse.status).toBe(200)

    const createTokenResponse = await fetchWithCookies(`${viewer.baseUrl}/api/tokens`, jar, {
      body: JSON.stringify({
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        label: 'agent token',
        project: 'product-docs',
        scopes: ['read', 'ssh-session'],
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    const createTokenPayload = await createTokenResponse.json() as {
      token: {
        id: string
        createdAt: string
        expiresAt: string
        label: string
        lastUsedAt: string | null
        project: string
        revokedAt: string | null
        scopes: string[]
        token: string
      }
    }
    expect(createTokenResponse.status).toBe(200)
    expect(createTokenPayload.token).toMatchObject({
      label: 'agent token',
      project: 'product-docs',
      revokedAt: null,
      scopes: ['bootstrap:read', 'project:read', 'sources:read', 'ssh-session:create'],
    })
    expect(createTokenPayload.token.createdAt).toEqual(expect.any(String))
    expect(createTokenPayload.token.expiresAt).toEqual(expect.any(String))
    expect(createTokenPayload.token.lastUsedAt).toBeNull()
    expect(createTokenPayload.token.token).toMatch(/^dssh_/)

    const expiredTokenResponse = await fetchWithCookies(`${viewer.baseUrl}/api/tokens`, jar, {
      body: JSON.stringify({
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        label: 'expired token',
        project: 'product-docs',
        scopes: ['project:read'],
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    const expiredTokenPayload = await expiredTokenResponse.json() as {
      token: {
        id: string
      }
    }
    expect(expiredTokenResponse.status).toBe(200)
    const database = new Database(viewer.authDbPath)
    database
      .prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60 * 1000).toISOString(), expiredTokenPayload.token.id)
    database.close()

    const listTokenResponse = await fetchWithCookies(`${viewer.baseUrl}/api/tokens?project=product-docs`, jar)
    const listTokenPayload = await listTokenResponse.json() as {
      tokens: Array<{
        createdAt: string
        expiresAt: string | null
        id: string
        label: string | null
        lastUsedAt: string | null
        project: string
        revokedAt: string | null
        scopes: string[]
        token?: string
      }>
    }
    expect(listTokenResponse.status).toBe(200)
    expect(listTokenPayload.tokens).toEqual([
      expect.objectContaining({
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
        id: createTokenPayload.token.id,
        label: 'agent token',
        lastUsedAt: null,
        project: 'product-docs',
        revokedAt: null,
        scopes: ['bootstrap:read', 'project:read', 'sources:read', 'ssh-session:create'],
      }),
    ])
    expect(listTokenPayload.tokens[0].token).toBeUndefined()

    const keyPair = sshUtils.generateKeyPairSync('ed25519')
    const bearerSessionResponse = await fetch(`${viewer.baseUrl}/api/ssh-sessions`, {
      body: JSON.stringify({
        project: 'product-docs',
        publicKey: keyPair.public,
      }),
      headers: {
        Authorization: `Bearer ${createTokenPayload.token.token}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    const bearerSessionPayload = await bearerSessionResponse.json() as {
      session: {
        project: string
        scopes: string[]
        username: string
      }
    }
    expect(bearerSessionResponse.status).toBe(200)
    expect(bearerSessionPayload.session).toMatchObject({
      project: 'product-docs',
      scopes: expect.arrayContaining(['bootstrap:read', 'project:read', 'sources:read', 'ssh-session:create']),
      username: expect.stringMatching(/^sess_/),
    })

    const bearerProjectsResponse = await fetch(`${viewer.baseUrl}/api/projects`, {
      headers: {
        Authorization: `Bearer ${createTokenPayload.token.token}`,
      },
    })
    expect(bearerProjectsResponse.status).toBe(401)

    const revokeTokenResponse = await fetchWithCookies(`${viewer.baseUrl}/api/tokens?id=${createTokenPayload.token.id}`, jar, {
      method: 'DELETE',
    })
    expect(revokeTokenResponse.status).toBe(200)
    const afterRevokeResponse = await fetchWithCookies(`${viewer.baseUrl}/api/tokens?project=product-docs`, jar)
    const afterRevokePayload = await afterRevokeResponse.json() as {
      tokens: Array<{ id: string }>
    }
    expect(afterRevokePayload.tokens).toEqual([])
  })

  it('rejects owner role assignment from admin users', async () => {
    const clientId = 'docs-ssh-viewer'
    const provider = await createFakeOidcProvider({
      clientId,
      email: 'admin@example.com',
      subject: 'admin-123',
    })
    const viewer = await createViewerFixture({
      clientId,
      extraUsers: [
        {
          displayName: 'Admin User',
          identity: {
            issuer: provider.issuer,
            provider: 'oidc',
            subject: 'admin-123',
          },
          login: 'admin',
          role: 'admin',
        },
      ],
      issuer: provider.issuer,
    })
    const jar = new CookieJar()

    const loginResponse = await fetchWithCookies(`${viewer.baseUrl}/auth/login`, jar)
    const authorizeResponse = await fetchWithCookies(loginResponse.headers.get('location')!, jar)
    await fetchWithCookies(authorizeResponse.headers.get('location')!, jar)

    const createOwnerResponse = await fetchWithCookies(`${viewer.baseUrl}/api/users`, jar, {
      body: JSON.stringify({
        displayName: 'Mallory Owner',
        email: 'mallory@example.com',
        issuer: provider.issuer,
        login: 'mallory',
        provider: 'oidc',
        role: 'owner',
        subject: 'mallory-subject',
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    const createOwnerPayload = await createOwnerResponse.json() as { error: string }
    expect(createOwnerResponse.status).toBe(403)
    expect(createOwnerPayload.error).toContain('Only owners can assign the owner role.')

    const usersResponse = await fetchWithCookies(`${viewer.baseUrl}/api/users`, jar)
    const usersPayload = await usersResponse.json() as {
      users: Array<{ login: string; role: string }>
    }
    expect(usersPayload.users.map((user) => [user.login, user.role])).toEqual([
      ['owner', 'owner'],
      ['admin', 'admin'],
    ])
  })

  it('prevents admins from changing existing owner roles through user creation', async () => {
    const clientId = 'docs-ssh-viewer'
    const provider = await createFakeOidcProvider({
      clientId,
      email: 'admin@example.com',
      subject: 'admin-123',
    })
    const viewer = await createViewerFixture({
      clientId,
      extraUsers: [
        {
          displayName: 'Admin User',
          identity: {
            issuer: provider.issuer,
            provider: 'oidc',
            subject: 'admin-123',
          },
          login: 'admin',
          role: 'admin',
        },
      ],
      issuer: provider.issuer,
    })
    const jar = new CookieJar()

    const loginResponse = await fetchWithCookies(`${viewer.baseUrl}/auth/login`, jar)
    const authorizeResponse = await fetchWithCookies(loginResponse.headers.get('location')!, jar)
    await fetchWithCookies(authorizeResponse.headers.get('location')!, jar)

    const demoteOwnerResponse = await fetchWithCookies(`${viewer.baseUrl}/api/users`, jar, {
      body: JSON.stringify({
        displayName: 'Owner',
        email: 'owner@example.com',
        issuer: provider.issuer,
        login: 'owner',
        provider: 'oidc',
        role: 'member',
        subject: 'owner-subject',
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    const demoteOwnerPayload = await demoteOwnerResponse.json() as { error: string }
    expect(demoteOwnerResponse.status).toBe(403)
    expect(demoteOwnerPayload.error).toContain('Only owners can update owner users.')

    const usersResponse = await fetchWithCookies(`${viewer.baseUrl}/api/users`, jar)
    const usersPayload = await usersResponse.json() as {
      users: Array<{ login: string; role: string }>
    }
    expect(usersPayload.users.map((user) => [user.login, user.role])).toEqual([
      ['owner', 'owner'],
      ['admin', 'admin'],
    ])
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

    const createSessionResponse = await fetch(`${viewer.baseUrl}/api/ssh-sessions`, {
      body: JSON.stringify({
        publicKey: keyPair.public,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    const createSessionPayload = await createSessionResponse.json() as { error: string }
    expect(createSessionResponse.status).toBe(401)
    expect(createSessionPayload.error).toContain('Sign in')
  })
})
