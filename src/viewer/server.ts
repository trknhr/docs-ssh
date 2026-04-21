import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, extname, posix, resolve, sep } from 'node:path'
import { createAuthStore, type AuthSshKey } from '../auth/store.js'
import { OidcClient, createPendingOidcLogin, getViewerOrigin, type OidcAuthConfig } from '../auth/oidc.js'
import {
  clearPendingOidcCookie,
  clearViewerSessionCookie,
  deriveViewerSessionSecret,
  isSecureViewerRequest,
  readPendingOidcLogin,
  readViewerSession,
  sanitizeViewerReturnTo,
  writePendingOidcCookie,
  writeViewerSessionCookie,
} from '../auth/web-session.js'
import { getSourceMountPath, getStatePaths, loadSourceStore } from '../sources/source-store.js'

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx'])
const TEXT_EXTENSIONS = new Set([
  '.astro',
  '.bash',
  '.cjs',
  '.conf',
  '.css',
  '.cts',
  '.csv',
  '.env',
  '.gql',
  '.graphql',
  '.htm',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.mts',
  '.py',
  '.rb',
  '.scss',
  '.sh',
  '.sql',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
])
const IMAGE_EXTENSIONS = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'])
const SPECIAL_TEXT_FILES = new Set([
  '.gitignore',
  'Dockerfile',
  'LICENSE',
  'NOTICE',
  'README',
  'README.md',
])
const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.next',
  '.turbo',
  'node_modules',
])
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024
const MAX_TREE_NODES = 10_000
const MAX_VIEWER_JSON_BODY_BYTES = 64 * 1024
const VIEWER_SESSION_TTL_MS = 12 * 60 * 60 * 1000

type ViewerFileKind = 'binary' | 'image' | 'markdown' | 'text'
type ViewerMountType = 'docs' | 'source' | 'workspace'

interface ViewerMount {
  aliases: string[]
  label: string
  mountPath: string
  rootPath: string
  type: ViewerMountType
}

interface ViewerTreeNode {
  id: string
  kind: 'directory' | 'file'
  name: string
  path: string
  previewKind?: ViewerFileKind
  children?: ViewerTreeNode[]
}

interface ViewerServerOptions {
  authDbPath?: string
  docsDir: string
  docsName?: string
  host?: string
  oidc?: OidcAuthConfig
  port?: number
  publicOrigin?: string
  registryPath?: string
  sessionSecret?: Buffer | string
  staticDir?: string
  workspaceDir?: string
}

function classifyFile(path: string): ViewerFileKind {
  const name = basename(path)
  const extension = extname(path).toLowerCase()

  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (TEXT_EXTENSIONS.has(extension) || SPECIAL_TEXT_FILES.has(name)) return 'text'
  return 'binary'
}

function guessContentType(path: string): string {
  const extension = extname(path).toLowerCase()

  switch (extension) {
    case '.avif':
      return 'image/avif'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.csv':
      return 'text/csv; charset=utf-8'
    case '.gif':
      return 'image/gif'
    case '.htm':
    case '.html':
      return 'text/html; charset=utf-8'
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.md':
      return 'text/markdown; charset=utf-8'
    case '.png':
      return 'image/png'
    case '.svg':
      return 'image/svg+xml'
    case '.txt':
      return 'text/plain; charset=utf-8'
    case '.webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}

function isHiddenPathSegment(name: string): boolean {
  return name.startsWith('.') && !SPECIAL_TEXT_FILES.has(name)
}

function isDirectoryAllowed(name: string): boolean {
  if (IGNORED_DIRECTORY_NAMES.has(name)) return false
  if (name.startsWith('.')) return false
  return true
}

function isFileAllowed(name: string): boolean {
  if (isHiddenPathSegment(name)) return false
  return classifyFile(name) !== 'binary'
}

function ensureInsideRoot(rootPath: string, relativePath: string): string {
  const normalizedRoot = resolve(rootPath)
  const absolutePath = resolve(normalizedRoot, relativePath)
  if (absolutePath !== normalizedRoot && !absolutePath.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error('Path escapes source root.')
  }
  return absolutePath
}

function normalizeVirtualPath(path: string): string {
  const normalized = posix.normalize(path.startsWith('/') ? path : `/${path}`)
  if (normalized === '/') return normalized
  return normalized.replace(/\/+$/, '')
}

function buildRawUrl(path: string): string {
  return `/api/raw?path=${encodeURIComponent(path)}`
}

function toViewerSshKeyPayload(sshKey: AuthSshKey) {
  return {
    algorithm: sshKey.algorithm,
    createdAt: sshKey.createdAt,
    fingerprint: sshKey.fingerprint,
    name: sshKey.name,
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

function deriveFirstOwnerLogin(email?: string): string | undefined {
  if (!email) return undefined
  const localPart = email.split('@', 1)[0]?.trim().toLowerCase()
  if (!localPart) return undefined

  const normalized = localPart
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || undefined
}

function deriveFirstOwnerName(email?: string): string | undefined {
  return email?.trim() || undefined
}

async function loadViewerContext(opts: ViewerServerOptions) {
  const statePaths = getStatePaths()
  const sourceStore = await loadSourceStore({
    registryPath: opts.registryPath,
    fallbackDocsDir: opts.docsDir,
    workspaceDir: resolve(opts.workspaceDir ?? `${statePaths.stateDir}/workspace`),
  })

  const defaultSourceName = sourceStore.registry.defaultSourceName
  const defaultSource = sourceStore.registry.sources.find((source) => source.name === defaultSourceName)
    ?? sourceStore.registry.sources[0]
  const mounts: ViewerMount[] = []

  if (defaultSource) {
    const aliases = sourceStore.mounts
      .filter((mount) => mount.sourceName === defaultSource.name)
      .map((mount) => mount.mountPoint)
      .sort((left, right) => (left === '/docs' ? -1 : right === '/docs' ? 1 : left.localeCompare(right)))

    mounts.push({
      aliases: aliases.filter((alias) => alias !== '/docs'),
      label: 'docs',
      mountPath: '/docs',
      rootPath: defaultSource.rootPath,
      type: 'docs',
    })
  }

  mounts.push({
    aliases: [],
    label: 'workspace',
    mountPath: sourceStore.workspaceMountPath,
    rootPath: sourceStore.workspaceRootPath,
    type: 'workspace',
  })

  const sourceMounts = sourceStore.registry.sources
    .filter((source) => source.name !== defaultSourceName)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((source) => ({
      aliases: [],
      label: source.name,
      mountPath: getSourceMountPath(source.name),
      rootPath: source.rootPath,
      type: 'source' as const,
    }))

  mounts.push(...sourceMounts)

  return {
    docsName: opts.docsName ?? 'Documentation',
    mounts,
  }
}

function isMountMatch(mountPath: string, path: string): boolean {
  return path === mountPath || path.startsWith(`${mountPath}/`)
}

function findMountByPath(mounts: ViewerMount[], path: string): ViewerMount | null {
  return mounts
    .filter((mount) => isMountMatch(mount.mountPath, path))
    .sort((left, right) => right.mountPath.length - left.mountPath.length)[0]
    ?? null
}

function getMountRelativePath(mount: ViewerMount, path: string): string {
  if (path === mount.mountPath) return ''
  return path.slice(mount.mountPath.length + 1)
}

function toTreeNodeId(kind: 'directory' | 'file', path: string): string {
  return `${kind === 'directory' ? 'dir' : 'file'}:${path}`
}

async function buildTree(mounts: ViewerMount[]) {
  let nodeCount = 0
  let truncated = false

  async function visit(mount: ViewerMount, relativePath = ''): Promise<ViewerTreeNode[]> {
    const directoryPath = ensureInsideRoot(mount.rootPath, relativePath || '.')

    let entries
    try {
      entries = await readdir(directoryPath, { withFileTypes: true })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return []
      }
      throw error
    }

    const directories: ViewerTreeNode[] = []
    const files: ViewerTreeNode[] = []

    for (const entry of entries) {
      if (truncated) break

      const nextRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name
      const virtualPath = posix.join(mount.mountPath, nextRelativePath)

      if (entry.isDirectory()) {
        if (!isDirectoryAllowed(entry.name)) continue
        nodeCount += 1
        if (nodeCount > MAX_TREE_NODES) {
          truncated = true
          break
        }
        directories.push({
          id: toTreeNodeId('directory', virtualPath),
          kind: 'directory',
          name: entry.name,
          path: virtualPath,
          children: await visit(mount, nextRelativePath),
        })
        continue
      }

      if (!entry.isFile() || !isFileAllowed(entry.name)) continue

      nodeCount += 1
      if (nodeCount > MAX_TREE_NODES) {
        truncated = true
        break
      }

      files.push({
        id: toTreeNodeId('file', virtualPath),
        kind: 'file',
        name: entry.name,
        path: virtualPath,
        previewKind: classifyFile(entry.name),
      })
    }

    directories.sort((left, right) => left.name.localeCompare(right.name))
    files.sort((left, right) => left.name.localeCompare(right.name))
    return [...directories, ...files]
  }

  const tree: ViewerTreeNode[] = []
  const sourceNodes: ViewerTreeNode[] = []

  for (const mount of mounts) {
    const node: ViewerTreeNode = {
      id: toTreeNodeId('directory', mount.mountPath),
      kind: 'directory',
      name: mount.label,
      path: mount.mountPath,
      children: await visit(mount),
    }

    if (mount.type === 'source') {
      sourceNodes.push(node)
      continue
    }

    tree.push(node)
  }

  if (sourceNodes.length > 0) {
    tree.push({
      id: toTreeNodeId('directory', '/sources'),
      kind: 'directory',
      name: 'sources',
      path: '/sources',
      children: sourceNodes,
    })
  }

  return {
    tree,
    truncated,
  }
}

function resolveViewerPath(mounts: ViewerMount[], requestedPath: string) {
  const path = normalizeVirtualPath(requestedPath)
  if (path === '/' || path === '/sources') {
    throw new Error('Path does not point to a mounted file.')
  }

  const mount = findMountByPath(mounts, path)
  if (!mount) {
    throw new Error(`Unknown path "${path}".`)
  }

  const relativePath = getMountRelativePath(mount, path)
  return {
    absolutePath: ensureInsideRoot(mount.rootPath, relativePath || '.'),
    aliases: mount.aliases,
    mountPath: mount.mountPath,
    path,
    relativePath,
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  headOnly = false,
) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(headOnly ? undefined : `${JSON.stringify(payload, null, 2)}\n`)
}

function sendHtml(response: ServerResponse, statusCode: number, html: string, headOnly = false) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
  })
  response.end(headOnly ? undefined : html)
}

function sendMethodNotAllowed(response: ServerResponse) {
  sendJson(response, 405, { error: 'Method not allowed.' })
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let totalBytes = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.length
    if (totalBytes > MAX_VIEWER_JSON_BODY_BYTES) {
      throw new Error('Request body was too large.')
    }
    chunks.push(buffer)
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) {
    throw new Error('Request body was empty.')
  }

  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error('Request body was not valid JSON.')
  }
}

function redirect(
  response: ServerResponse,
  location: string,
  opts: {
    cookies?: string[]
    headOnly?: boolean
  } = {},
) {
  response.writeHead(302, {
    Location: location,
    ...(opts.cookies && opts.cookies.length > 0 ? { 'Set-Cookie': opts.cookies } : {}),
  })
  response.end(opts.headOnly ? undefined : `Redirecting to ${location}`)
}

function sendAuthError(
  response: ServerResponse,
  statusCode: number,
  message: string,
  opts: {
    clearCookies?: string[]
    command?: string
    details?: Array<{ label: string; value: string }>
    headOnly?: boolean
  } = {},
) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
    ...(opts.clearCookies && opts.clearCookies.length > 0 ? { 'Set-Cookie': opts.clearCookies } : {}),
  })
  response.end(
    opts.headOnly
      ? undefined
      : `<!doctype html><html lang="en"><body><main><h1>Authentication failed</h1><p>${escapeHtml(message)}</p>${opts.details && opts.details.length > 0 ? `<dl>${opts.details.map((detail) => `<div><dt>${escapeHtml(detail.label)}</dt><dd><code>${escapeHtml(detail.value)}</code></dd></div>`).join('')}</dl>` : ''}${opts.command ? `<p>Link this identity in the local auth database, then retry sign-in.</p><pre>${escapeHtml(opts.command)}</pre>` : ''}</main></body></html>`,
  )
}

async function serveStaticFile(
  staticDir: string,
  requestPath: string,
  response: ServerResponse,
  headOnly = false,
) {
  const normalizedPath = requestPath === '/' ? '/index.html' : requestPath
  const assetPath = normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath
  const resolvedPath = ensureInsideRoot(staticDir, assetPath)
  const fileStats = await stat(resolvedPath)

  response.writeHead(200, {
    'Cache-Control': normalizedPath === '/index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    'Content-Length': String(fileStats.size),
    'Content-Type': guessContentType(resolvedPath),
  })
  if (headOnly) {
    response.end()
    return
  }

  createReadStream(resolvedPath).pipe(response)
}

export function createViewerServer(opts: ViewerServerOptions) {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 3000
  const staticDir = resolve(opts.staticDir ?? './viewer-dist')
  const authStore = opts.authDbPath ? createAuthStore({ dbPath: opts.authDbPath }) : null
  const oidcClient = opts.oidc ? new OidcClient(opts.oidc) : null
  const sessionSecret = opts.sessionSecret ? deriveViewerSessionSecret(opts.sessionSecret) : null

  const getActiveSession = (request: IncomingMessage) => {
    if (!authStore || !sessionSecret) return null
    const session = readViewerSession(sessionSecret, request)
    if (!session) return null

    const user = authStore.findUserByLogin(session.login)
    if (!user || user.id !== session.userId) return null

    return {
      ...session,
      login: user.login,
      userDisplayName: user.displayName,
      userId: user.id,
    }
  }

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const method = request.method ?? 'GET'
      const url = new URL(request.url ?? '/', 'http://localhost')
      const headOnly = method === 'HEAD'
      const isSshKeyRoute = url.pathname === '/api/auth/ssh-keys'

      if (method !== 'GET' && method !== 'HEAD' && !(isSshKeyRoute && method === 'POST')) {
        sendMethodNotAllowed(response)
        return
      }

      if (url.pathname === '/api/auth/session') {
        const session = getActiveSession(request)
        sendJson(
          response,
          200,
          {
            oidc: oidcClient && opts.oidc
              ? {
                  enabled: true,
                  issuer: opts.oidc.issuer,
                  provider: opts.oidc.provider,
                }
              : {
                  enabled: false,
                },
            session: session
              ? {
                  email: session.email,
                  expiresAt: session.expiresAt,
                  issuer: session.issuer,
                  login: session.login,
                  provider: session.provider,
                  subject: session.subject,
                  userDisplayName: session.userDisplayName,
                  userId: session.userId,
                }
              : null,
          },
          headOnly,
        )
        return
      }

      if (isSshKeyRoute) {
        if (!authStore || !sessionSecret) {
          sendJson(response, 501, { error: 'Viewer auth is not configured.' }, headOnly)
          return
        }

        const session = getActiveSession(request)
        if (!session) {
          sendJson(response, 401, { error: 'Sign in to manage SSH keys.' }, headOnly)
          return
        }

        if (method === 'GET' || method === 'HEAD') {
          sendJson(
            response,
            200,
            {
              keys: authStore.listSshKeys(session.login).map(toViewerSshKeyPayload),
            },
            headOnly,
          )
          return
        }

        if (method === 'POST') {
          let payload
          try {
            payload = await readJsonBody(request) as {
              name?: unknown
              publicKey?: unknown
            }
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            })
            return
          }

          if (typeof payload.publicKey !== 'string' || payload.publicKey.trim().length === 0) {
            sendJson(response, 400, { error: 'Missing SSH public key.' })
            return
          }
          if (payload.name !== undefined && payload.name !== null && typeof payload.name !== 'string') {
            sendJson(response, 400, { error: 'SSH key name must be a string.' })
            return
          }

          try {
            const sshKey = authStore.addSshKey({
              name: typeof payload.name === 'string' ? payload.name : undefined,
              publicKey: payload.publicKey,
              userLogin: session.login,
            })
            sendJson(response, 200, {
              key: toViewerSshKeyPayload(sshKey),
            })
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            })
          }
          return
        }

        sendMethodNotAllowed(response)
        return
      }

      if (url.pathname === '/auth/login') {
        if (!oidcClient || !opts.oidc || !sessionSecret) {
          sendJson(response, 501, { error: 'OIDC login is not configured.' }, headOnly)
          return
        }

        const currentSession = getActiveSession(request)
        const returnTo = sanitizeViewerReturnTo(url.searchParams.get('returnTo'))
        if (currentSession) {
          redirect(response, returnTo, { headOnly })
          return
        }

        const secure = isSecureViewerRequest(request, opts.publicOrigin)
        const pendingLogin = createPendingOidcLogin(returnTo)
        const redirectUri = `${getViewerOrigin(request, opts.publicOrigin)}/auth/callback`
        const location = await oidcClient.buildAuthorizationRedirectUrl({
          pendingLogin,
          redirectUri,
        })

        redirect(response, location, {
          cookies: [writePendingOidcCookie(sessionSecret, pendingLogin, secure)],
          headOnly,
        })
        return
      }

      if (url.pathname === '/auth/callback') {
        if (!oidcClient || !opts.oidc || !sessionSecret || !authStore) {
          sendJson(response, 501, { error: 'OIDC login is not configured.' }, headOnly)
          return
        }

        const secure = isSecureViewerRequest(request, opts.publicOrigin)
        const pendingLogin = readPendingOidcLogin(sessionSecret, request)
        if (!pendingLogin) {
          sendAuthError(response, 400, 'The login request has expired. Start the sign-in flow again.', {
            clearCookies: [clearPendingOidcCookie(secure)],
            headOnly,
          })
          return
        }

        const code = url.searchParams.get('code')?.trim()
        const state = url.searchParams.get('state')?.trim()
        if (!code || !state || state !== pendingLogin.state) {
          sendAuthError(response, 400, 'The OIDC callback parameters were invalid.', {
            clearCookies: [clearPendingOidcCookie(secure)],
            headOnly,
          })
          return
        }

        try {
          const redirectUri = `${getViewerOrigin(request, opts.publicOrigin)}/auth/callback`
          const identity = await oidcClient.exchangeCodeForIdentity({
            code,
            codeVerifier: pendingLogin.codeVerifier,
            nonce: pendingLogin.nonce,
            redirectUri,
          })
          const user = authStore.findUserByAuthIdentity({
            issuer: identity.issuer,
            provider: opts.oidc.provider,
            subject: identity.subject,
          })

          const signedUpUser = !user
            ? authStore.signUpFirstUserWithAuthIdentity({
                email: identity.email,
                issuer: identity.issuer,
                ownerLogin: deriveFirstOwnerLogin(identity.email),
                ownerName: deriveFirstOwnerName(identity.email),
                provider: opts.oidc.provider,
                subject: identity.subject,
              })?.owner.user
            : null

          const resolvedUser = user ?? signedUpUser

          if (!resolvedUser) {
            const linkCommand = `pnpm run cli -- auth add-web-identity --provider ${shellQuote(opts.oidc.provider)} --issuer ${shellQuote(identity.issuer)} --subject ${shellQuote(identity.subject)}`
            sendAuthError(
              response,
              403,
              'This web identity is not linked to a docs-ssh user yet.',
              {
                clearCookies: [clearPendingOidcCookie(secure), clearViewerSessionCookie(secure)],
                command: linkCommand,
                details: [
                  { label: 'provider', value: opts.oidc.provider },
                  { label: 'issuer', value: identity.issuer },
                  { label: 'subject', value: identity.subject },
                ],
                headOnly,
              },
            )
            return
          }

          redirect(response, pendingLogin.returnTo, {
            cookies: [
              clearPendingOidcCookie(secure),
              writeViewerSessionCookie(
                sessionSecret,
                {
                  email: identity.email,
                  expiresAt: Date.now() + VIEWER_SESSION_TTL_MS,
                  issuer: identity.issuer,
                  login: resolvedUser.login,
                  provider: opts.oidc.provider,
                  subject: identity.subject,
                  userDisplayName: resolvedUser.displayName,
                  userId: resolvedUser.id,
                },
                secure,
              ),
            ],
            headOnly,
          })
          return
        } catch (error) {
          sendAuthError(
            response,
            401,
            error instanceof Error ? error.message : 'OIDC verification failed.',
            {
              clearCookies: [clearPendingOidcCookie(secure), clearViewerSessionCookie(secure)],
              headOnly,
            },
          )
          return
        }
      }

      if (url.pathname === '/auth/logout') {
        const secure = isSecureViewerRequest(request, opts.publicOrigin)
        redirect(response, sanitizeViewerReturnTo(url.searchParams.get('returnTo')), {
          cookies: [clearViewerSessionCookie(secure), clearPendingOidcCookie(secure)],
          headOnly,
        })
        return
      }

      const context = await loadViewerContext(opts)
      const publicMounts = context.mounts.map((mount) => ({
        aliases: mount.aliases,
        label: mount.label,
        mountPath: mount.mountPath,
        type: mount.type,
      }))

      if (url.pathname === '/api/sources') {
        sendJson(
          response,
          200,
          {
            docsName: context.docsName,
            mounts: publicMounts,
          },
          headOnly,
        )
        return
      }

      if (url.pathname === '/api/tree') {
        const { tree, truncated } = await buildTree(context.mounts)
        sendJson(
          response,
          200,
          {
            docsName: context.docsName,
            mounts: publicMounts,
            tree,
            truncated,
          },
          headOnly,
        )
        return
      }

      if (url.pathname === '/api/file' || url.pathname === '/api/raw') {
        const requestedPath = url.searchParams.get('path')?.trim()

        if (!requestedPath) {
          sendJson(response, 400, { error: 'Missing path query parameter.' }, headOnly)
          return
        }

        let resolvedPath
        try {
          resolvedPath = resolveViewerPath(context.mounts, requestedPath)
        } catch (error) {
          sendJson(
            response,
            404,
            {
              error: error instanceof Error ? error.message : String(error),
            },
            headOnly,
          )
          return
        }

        const fileStats = await stat(resolvedPath.absolutePath)
        if (!fileStats.isFile()) {
          sendJson(response, 404, { error: 'File not found.' }, headOnly)
          return
        }

        if (url.pathname === '/api/raw') {
          response.writeHead(200, {
            'Cache-Control': 'no-store',
            'Content-Length': String(fileStats.size),
            'Content-Type': guessContentType(resolvedPath.absolutePath),
          })
          if (headOnly) {
            response.end()
            return
          }
          createReadStream(resolvedPath.absolutePath).pipe(response)
          return
        }

        const kind = classifyFile(resolvedPath.absolutePath)
        const rawUrl = buildRawUrl(resolvedPath.path)
        const payload = {
          aliases: resolvedPath.aliases,
          kind,
          mountPath: resolvedPath.mountPath,
          name: basename(resolvedPath.absolutePath),
          path: resolvedPath.path,
          rawUrl,
          size: fileStats.size,
        }

        if (kind === 'image') {
          sendJson(response, 200, payload, headOnly)
          return
        }

        if (kind === 'binary') {
          sendJson(
            response,
            415,
            {
              ...payload,
              error: 'This file type is not previewable.',
            },
            headOnly,
          )
          return
        }

        if (fileStats.size > MAX_TEXT_PREVIEW_BYTES) {
          sendJson(
            response,
            413,
            {
              ...payload,
              error: 'This file is too large for inline preview.',
            },
            headOnly,
          )
          return
        }

        const content = await readFile(resolvedPath.absolutePath, 'utf8')
        sendJson(
          response,
          200,
          {
            ...payload,
            content,
          },
          headOnly,
        )
        return
      }

      try {
        await serveStaticFile(staticDir, url.pathname, response, headOnly)
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (url.pathname !== '/' && code !== 'ENOENT') {
          sendJson(response, 404, { error: 'Not found.' }, headOnly)
          return
        }

        const fallbackHtml = `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>docs-ssh viewer</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0d1117;
        color: #e6edf3;
        font: 16px/1.5 "IBM Plex Sans", "Segoe UI", sans-serif;
      }
      main {
        max-width: 48rem;
        padding: 2rem;
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 1rem;
        background: rgba(15, 23, 42, 0.9);
      }
      code {
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Viewer assets are missing.</h1>
      <p>The HTTP API is running, but <code>${staticDir}</code> does not contain the built viewer.</p>
      <p>Run <code>pnpm build</code> to generate the frontend bundle.</p>
    </main>
  </body>
</html>`.trim()

        sendHtml(response, 200, fallbackHtml, headOnly)
      }
    } catch (error) {
      console.error('[viewer]', error)
      sendJson(
        response,
        500,
        {
          error: error instanceof Error ? error.message : 'Internal server error.',
        },
        false,
      )
    }
  })

  return {
    listen: () =>
      new Promise<number>((resolveListen, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          const address = server.address() as AddressInfo
          console.log(`[viewer] listening on http://${host}:${address.port}`)
          resolveListen(address.port)
        })
      }),
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => {
          authStore?.close()
          resolveClose()
        })
      }),
  }
}
