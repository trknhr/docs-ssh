import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, extname, posix, resolve, sep } from 'node:path'
import {
  createAuthStore,
  type AuthApiToken,
  type AuthApiTokenScope,
  type AuthApiTokenSession,
  type AuthMembershipRole,
  type AuthPrincipalSession,
  type AuthProject,
  type AuthSshKey,
  type AuthSshSession,
  type AuthStore,
  type AuthTenantUser,
  type AuthWorkspaceAccessRequest,
} from '../auth/store.js'
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
import { getStatePaths, loadSourceStore } from '../sources/source-store.js'
import { ensureWorkspaceLayout } from '../workspace/layout.js'

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
const IDENTIFIER_PATTERN = /[^a-z0-9-]+/g
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
const CLI_LOGIN_REQUEST_TTL_MS = 5 * 60 * 1000
const VIEWER_SESSION_TTL_MS = 12 * 60 * 60 * 1000
const PROTECTED_VIEWER_DATA_ROUTES = new Set(['/api/tree', '/api/file', '/api/raw'])

type ViewerFileKind = 'binary' | 'image' | 'markdown' | 'text'
type ViewerMountType = 'home' | 'project'

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
  onboardingMode?: 'approval' | 'closed'
  port?: number
  publicOrigin?: string
  registryPath?: string
  sessionSecret?: Buffer | string
  staticDir?: string
  workspaceDir?: string
}

interface ActiveViewerSession {
  email?: string
  expiresAt: number
  issuer: string
  login: string
  provider: string
  subject: string
  userDisplayName: string
  userId: string
}

interface CliLoginRequest {
  approveToken: string
  callbackUrl: string
  code?: string
  consumedAt?: number
  createdAt: number
  expiresAt: number
  id: string
  publicKey: string
  result?: ReturnType<typeof toViewerSshSessionPayload>
  scopes?: string[]
  state: string
  ttlSeconds?: number
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
    throw new Error('Path escapes mounted root.')
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

function toViewerSshSessionPayload(session: AuthSshSession) {
  return {
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    fingerprint: session.fingerprint,
    project: session.currentProjectSlug,
    scopes: session.scopes,
    username: session.username,
  }
}

function toViewerApiTokenPayload(token: AuthApiToken, secret?: string) {
  return {
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    id: token.id,
    label: token.label,
    lastUsedAt: token.lastUsedAt,
    project: token.projectSlug,
    revokedAt: token.revokedAt,
    scopes: token.scopes,
    ...(secret ? { token: secret } : {}),
  }
}

function toViewerProjectPayload(project: AuthProject) {
  return {
    archivedAt: project.archivedAt,
    createdAt: project.createdAt,
    displayName: project.displayName,
    publicId: project.publicId,
    slug: project.slug,
  }
}

function toViewerWorkspaceAccessRequestPayload(request: AuthWorkspaceAccessRequest) {
  return {
    createdAt: request.createdAt,
    intendedUse: request.intendedUse,
    publicId: request.publicId,
    requester: {
      displayName: request.requesterDisplayName,
      email: request.requesterEmail,
      login: request.requesterLogin,
    },
    reviewNote: request.reviewNote,
    reviewedAt: request.reviewedAt,
    status: request.status,
    updatedAt: request.updatedAt,
    workspace: request.tenant
      ? {
          displayName: request.tenant.displayName,
          publicId: request.tenant.publicId,
        }
      : null,
    workspaceName: request.workspaceName,
  }
}

function toViewerTenantInvitationPayload(invitation: ReturnType<AuthStore['getTenantInvitation']>) {
  if (!invitation) return null
  return {
    acceptedAt: invitation.acceptedAt,
    createdAt: invitation.createdAt,
    email: invitation.email,
    expiresAt: invitation.expiresAt,
    publicId: invitation.publicId,
    role: invitation.role,
    status: invitation.status,
    workspace: {
      displayName: invitation.tenant.displayName,
      publicId: invitation.tenant.publicId,
    },
  }
}

function toViewerUserPayload(user: AuthTenantUser) {
  return {
    createdAt: user.createdAt,
    displayName: user.displayName,
    identities: user.identities.map((identity) => ({
      email: identity.email,
      issuer: identity.issuer,
      provider: identity.provider,
      subject: identity.subject,
    })),
    login: user.login,
    role: user.role,
  }
}

function canManageUsers(session: AuthPrincipalSession | null): boolean {
  return session?.membership.role === 'owner' || session?.membership.role === 'admin'
}

function parseMembershipRole(value: unknown): AuthMembershipRole {
  if (value === undefined || value === null || value === '') return 'member'
  if (value === 'owner' || value === 'admin' || value === 'member') return value
  throw new Error('Role must be owner, admin, or member.')
}

function parseApiTokenScopes(value: unknown): AuthApiTokenScope[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || !value.every((scope) => typeof scope === 'string')) {
    throw new Error('scopes must be an array of strings.')
  }

  const scopes: AuthApiTokenScope[] = []
  const addScopes = (...entries: AuthApiTokenScope[]) => {
    for (const entry of entries) {
      if (!scopes.includes(entry)) scopes.push(entry)
    }
  }

  for (const scope of value) {
    switch (scope) {
      case 'read':
        addScopes('bootstrap:read', 'project:read', 'sources:read')
        break
      case 'write':
        addScopes('bootstrap:read', 'project:read', 'sources:read', 'project:write')
        break
      case 'ssh-session':
        addScopes('ssh-session:create')
        break
      case 'bootstrap:read':
      case 'project:read':
      case 'project:write':
      case 'sources:read':
      case 'ssh-session:create':
        addScopes(scope)
        break
      default:
        throw new Error(`Unsupported API token scope: ${scope}`)
    }
  }

  return scopes
}

function normalizeViewerIdentifier(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(IDENTIFIER_PATTERN, '-')
    .replace(/^-+|-+$/g, '')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
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

function getRequestedProjectSlug(url: URL): string | undefined {
  const explicitProject = url.searchParams.get('project')?.trim()
  if (explicitProject) return explicitProject

  const requestedPath = url.searchParams.get('path')?.trim()
  if (!requestedPath) return undefined

  const normalizedPath = normalizeVirtualPath(requestedPath)
  const [, root, slug] = normalizedPath.split('/')
  return root === 'projects' && slug ? slug : undefined
}

function getRequestedPublicProject(url: URL): { projectPublicId: string; tenantPublicId: string } | null {
  const projectPublicId = url.searchParams.get('projectId')?.trim()
  const tenantPublicId = url.searchParams.get('workspaceId')?.trim()
  if (!projectPublicId && !tenantPublicId) return null
  if (!projectPublicId || !tenantPublicId) {
    throw new Error('workspaceId and projectId must be provided together.')
  }
  return { projectPublicId, tenantPublicId }
}

function isProtectedViewerDataRoute(pathname: string): boolean {
  return PROTECTED_VIEWER_DATA_ROUTES.has(pathname)
}

function buildViewerReturnTo(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`
}

function getViewerRequestOrigin(request: IncomingMessage, publicOrigin?: string): string {
  if (publicOrigin) return publicOrigin.replace(/\/+$/u, '')

  const host = request.headers.host
  return host ? `http://${host}` : 'http://localhost'
}

function getBearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim())
  return match?.[1]?.trim() || null
}

function isLocalCallbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

function appendQueryParams(url: string, params: Record<string, string>): string {
  const nextUrl = new URL(url)
  for (const [key, value] of Object.entries(params)) {
    nextUrl.searchParams.set(key, value)
  }
  return nextUrl.toString()
}

function createCliLoginRequestHtml(request: CliLoginRequest, session: ActiveViewerSession): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Authorize docs-ssh CLI</title></head>',
    '<body>',
    '<main>',
    '<h1>Authorize docs-ssh CLI</h1>',
    `<p>Signed in as <strong>${escapeHtml(session.userDisplayName || session.login)}</strong>.</p>`,
    '<dl>',
    '<div><dt>Access</dt><dd><code>Authorized projects for this user</code></dd></div>',
    `<div><dt>Expires</dt><dd><code>${escapeHtml(new Date(request.expiresAt).toISOString())}</code></dd></div>`,
    '</dl>',
    `<form method="post" action="/cli-login/${encodeURIComponent(request.id)}/approve">`,
    `<input type="hidden" name="approveToken" value="${escapeHtml(request.approveToken)}">`,
    '<button type="submit">Authorize SSH session</button>',
    '</form>',
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

function createCliLoginCompleteHtml(): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>docs-ssh CLI authorized</title></head>',
    '<body><main><h1>docs-ssh CLI authorized</h1><p>You can return to the terminal.</p></main></body>',
    '</html>',
  ].join('')
}

function getValidCliLoginRequest(
  requests: Map<string, CliLoginRequest>,
  id: string | undefined,
): CliLoginRequest | null {
  if (!id) return null
  const request = requests.get(id)
  if (!request) return null
  if (request.expiresAt <= Date.now()) {
    requests.delete(id)
    return null
  }
  return request
}

async function loadViewerContext(
  opts: ViewerServerOptions,
  context: {
    authStore?: AuthStore | null
    includeHome?: boolean
    principalSession?: AuthPrincipalSession | null
    projectSlug?: string
    session?: ActiveViewerSession | null
    scopedProjectOnly?: boolean
  } = {},
) {
  const statePaths = getStatePaths()
  const principalSession = context.principalSession ?? (
    context.authStore && context.session
      ? context.authStore.findUserProjectSession(context.session.login, context.projectSlug)
      : null
  )
  if (context.projectSlug && context.authStore && context.session && !principalSession) {
    throw new Error(`Project "${context.projectSlug}" was not found or is not accessible.`)
  }

  const projectSessions = context.scopedProjectOnly
    ? (principalSession ? [principalSession] : [])
    : context.authStore && context.session
    ? context.authStore
      .listProjects({ userLogin: context.session.login })
      .map((project) => context.authStore!.findUserProjectSession(context.session!.login, project.slug))
      .filter((session): session is AuthPrincipalSession => Boolean(session))
    : []
  const visibleProjectSessions = principalSession && !projectSessions.some((session) => session.project.id === principalSession.project.id)
    ? [...projectSessions, principalSession]
    : projectSessions

  const sourceStore = await loadSourceStore({
    registryPath: opts.registryPath,
    fallbackDocsDir: opts.docsDir,
    principalId: principalSession?.principal.id,
    projectSlug: principalSession?.project.slug ?? context.projectSlug,
    tenantSlug: principalSession?.tenant.slug,
    workspaceDir: resolve(opts.workspaceDir ?? `${statePaths.stateDir}/workspace`),
  })
  await ensureWorkspaceLayout(sourceStore.tenantRootPath, {
    homeRootPath: sourceStore.homeRootPath,
    projectRootPath: sourceStore.projectRootPath,
    projectSlug: sourceStore.projectSlug,
  })
  const projectMountPath = sourceStore.projectMountPath

  const mounts: ViewerMount[] = []

  if (context.includeHome !== false) {
    mounts.push({
      aliases: [],
      label: 'home',
      mountPath: sourceStore.homeMountPath,
      rootPath: sourceStore.homeRootPath,
      type: 'home',
    })
  }

  if (visibleProjectSessions.length > 0) {
    for (const projectSession of visibleProjectSessions) {
      const projectSourceStore = projectSession.project.slug === sourceStore.projectSlug
        ? sourceStore
        : await loadSourceStore({
          registryPath: opts.registryPath,
          fallbackDocsDir: opts.docsDir,
          principalId: projectSession.principal.id,
          projectSlug: projectSession.project.slug,
          tenantSlug: projectSession.tenant.slug,
          workspaceDir: resolve(opts.workspaceDir ?? `${statePaths.stateDir}/workspace`),
        })
      await ensureWorkspaceLayout(projectSourceStore.tenantRootPath, {
        homeRootPath: projectSourceStore.homeRootPath,
        projectRootPath: projectSourceStore.projectRootPath,
        projectSlug: projectSourceStore.projectSlug,
      })

      mounts.push({
        aliases: [],
        label: `projects/${projectSession.project.slug}`,
        mountPath: `${projectSourceStore.projectsMountPath}/${projectSession.project.slug}`,
        rootPath: projectSourceStore.projectRootPath,
        type: 'project',
      })
    }
  } else {
    mounts.push({
      aliases: [],
      label: `projects/${sourceStore.projectSlug}`,
      mountPath: projectMountPath,
      rootPath: sourceStore.projectRootPath,
      type: 'project',
    })
  }

  return {
    docsName: opts.docsName ?? 'Documentation',
    mounts,
  }
}

async function ensureViewerProjectWorkspace(
  opts: ViewerServerOptions,
  authStore: AuthStore,
  userLogin: string,
  projectSlug: string,
): Promise<void> {
  const principalSession = authStore.findUserProjectSession(userLogin, projectSlug)
  if (!principalSession) {
    throw new Error(`Project "${projectSlug}" was not found or is not accessible.`)
  }

  const statePaths = getStatePaths()
  const sourceStore = await loadSourceStore({
    registryPath: opts.registryPath,
    fallbackDocsDir: opts.docsDir,
    principalId: principalSession.principal.id,
    projectSlug: principalSession.project.slug,
    tenantSlug: principalSession.tenant.slug,
    workspaceDir: resolve(opts.workspaceDir ?? `${statePaths.stateDir}/workspace`),
  })
  await ensureWorkspaceLayout(sourceStore.tenantRootPath, {
    homeRootPath: sourceStore.homeRootPath,
    projectRootPath: sourceStore.projectRootPath,
    projectSlug: sourceStore.projectSlug,
  })
}

function isMountMatch(mountPath: string, path: string): boolean {
  return path === mountPath || path.startsWith(`${mountPath}/`)
}

function getMatchingMountPath(mount: ViewerMount, path: string): string | null {
  for (const mountPath of [mount.mountPath, ...mount.aliases]) {
    if (isMountMatch(mountPath, path)) return mountPath
  }
  return null
}

function findMountByPath(mounts: ViewerMount[], path: string): { matchedPath: string, mount: ViewerMount } | null {
  return mounts
    .map((mount) => {
      const matchedPath = getMatchingMountPath(mount, path)
      return matchedPath ? { matchedPath, mount } : null
    })
    .filter((match): match is { matchedPath: string, mount: ViewerMount } => Boolean(match))
    .sort((left, right) => right.matchedPath.length - left.matchedPath.length)[0]
    ?? null
}

function getMountRelativePath(matchedPath: string, path: string): string {
  if (path === matchedPath) return ''
  return path.slice(matchedPath.length + 1)
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
  for (const mount of mounts) {
    const node: ViewerTreeNode = {
      id: toTreeNodeId('directory', mount.mountPath),
      kind: 'directory',
      name: mount.label,
      path: mount.mountPath,
      children: await visit(mount),
    }

    tree.push(node)
  }

  return {
    tree,
    truncated,
  }
}

function resolveViewerPath(mounts: ViewerMount[], requestedPath: string) {
  const path = normalizeVirtualPath(requestedPath)
  if (path === '/' || path === '/projects') {
    throw new Error('Path does not point to a mounted file.')
  }

  const match = findMountByPath(mounts, path)
  if (!match) {
    throw new Error(`Unknown path "${path}".`)
  }

  const relativePath = getMountRelativePath(match.matchedPath, path)
  return {
    absolutePath: ensureInsideRoot(match.mount.rootPath, relativePath || '.'),
    aliases: match.mount.aliases,
    mountPath: match.mount.mountPath,
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

async function readRequestBodyText(request: IncomingMessage): Promise<string> {
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

  return raw
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const raw = await readRequestBodyText(request)

  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error('Request body was not valid JSON.')
  }
}

async function readFormBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readRequestBodyText(request))
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
    commandIntro?: string
    details?: Array<{ label: string; value: string }>
    headOnly?: boolean
    nextSteps?: string[]
    title?: string
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
      : [
          '<!doctype html>',
          '<html lang="en">',
          '<head>',
          '<meta charset="utf-8">',
          '<meta name="viewport" content="width=device-width,initial-scale=1">',
          `<title>${escapeHtml(opts.title ?? 'Authentication failed')}</title>`,
          '<style>',
          ':root{color-scheme:dark;background:#101827;color:#e6edf7;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
          '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;background:radial-gradient(circle at top left,#1d2b43 0,#101827 34rem)}',
          'main{width:min(720px,100%);border:1px solid #26364d;background:#141f31;border-radius:8px;padding:32px;box-shadow:0 24px 80px rgba(0,0,0,.32)}',
          '.eyebrow{margin:0 0 10px;color:#8ea0b8;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}',
          'h1{margin:0;color:#f3f7ff;font-size:32px;line-height:1.12}p{color:#b8c4d6;font-size:16px;line-height:1.65;margin:16px 0 0}',
          'ol{margin:16px 0 0;padding-left:22px;color:#cdd7e6;line-height:1.65}li+li{margin-top:6px}',
          'dl{display:grid;gap:10px;margin:18px 0 0;padding:16px;border:1px solid #27384f;border-radius:8px;background:#0f1725}',
          'dt{color:#8ea0b8;font-size:12px;font-weight:700;text-transform:uppercase}dd{margin:3px 0 0;overflow-wrap:anywhere}',
          'code,pre{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}code{color:#dbe8ff}pre{overflow:auto;margin:12px 0 0;padding:14px;border-radius:8px;background:#0b1220;color:#dbe8ff;font-size:13px;line-height:1.5}',
          'details{margin-top:18px}summary{cursor:pointer;color:#9fcef5;font-weight:700}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}',
          'a{color:inherit}.button{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 16px;border-radius:999px;background:#55b8ed;color:#06121d;font-weight:800;text-decoration:none}',
          '.secondary{background:#223148;color:#dbe8ff}',
          '</style>',
          '</head>',
          '<body>',
          '<main>',
          '<p class="eyebrow">docs-ssh sign-in</p>',
          `<h1>${escapeHtml(opts.title ?? 'Authentication failed')}</h1>`,
          `<p>${escapeHtml(message)}</p>`,
          opts.nextSteps && opts.nextSteps.length > 0
            ? `<ol>${opts.nextSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>`
            : '',
          opts.details && opts.details.length > 0
            ? `<dl>${opts.details.map((detail) => `<div><dt>${escapeHtml(detail.label)}</dt><dd><code>${escapeHtml(detail.value)}</code></dd></div>`).join('')}</dl>`
            : '',
          opts.command
            ? `<details><summary>${escapeHtml(opts.commandIntro ?? 'Owner CLI command')}</summary><pre>${escapeHtml(opts.command)}</pre></details>`
            : '',
          '<div class="actions">',
          '<a class="button" href="/auth/login">Try another Google account</a>',
          '<a class="button secondary" href="/">Back to viewer</a>',
          '</div>',
          '</main>',
          '</body>',
          '</html>',
        ].join(''),
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
  const cliLoginRequests = new Map<string, CliLoginRequest>()

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
      const isSshSessionRoute = url.pathname === '/api/ssh-sessions'
      const isApiTokenRoute = url.pathname === '/api/tokens'
      const isProjectRoute = url.pathname === '/api/projects'
      const isUserRoute = url.pathname === '/api/users'
      const isOnboardingRequestRoute = url.pathname === '/api/onboarding/request'
      const isOperatorWorkspaceRequestsRoute = url.pathname === '/api/operator/workspace-requests'
      const isInvitationRoute = url.pathname === '/api/invitations'
      const isInvitationAcceptRoute = url.pathname === '/api/invitations/accept'
      const isCliLoginRequestRoute = url.pathname === '/api/cli-login/requests'
      const isCliLoginExchangeRoute = url.pathname === '/api/cli-login/exchange'
      const cliLoginViewMatch = /^\/cli-login\/([^/]+)$/u.exec(url.pathname)
      const cliLoginApproveMatch = /^\/cli-login\/([^/]+)\/approve$/u.exec(url.pathname)

      if (
        method !== 'GET'
        && method !== 'HEAD'
        && !(isSshKeyRoute && method === 'POST')
        && !(isSshSessionRoute && method === 'POST')
        && !(isApiTokenRoute && method === 'POST')
        && !(isApiTokenRoute && method === 'DELETE')
        && !(isProjectRoute && method === 'POST')
        && !(isProjectRoute && method === 'PATCH')
        && !(isProjectRoute && method === 'DELETE')
        && !(isUserRoute && method === 'POST')
        && !(isOnboardingRequestRoute && method === 'POST')
        && !(isOperatorWorkspaceRequestsRoute && method === 'PATCH')
        && !(isInvitationRoute && method === 'POST')
        && !(isInvitationAcceptRoute && method === 'POST')
        && !(isCliLoginRequestRoute && method === 'POST')
        && !(isCliLoginExchangeRoute && method === 'POST')
        && !(cliLoginApproveMatch && method === 'POST')
      ) {
        sendMethodNotAllowed(response)
        return
      }

      if (url.pathname === '/api/auth/session') {
        const session = getActiveSession(request)
        const principalSession = session && authStore
          ? authStore.findUserProjectSession(session.login)
          : null
        const onboarding = session && authStore
          ? authStore.getUserOnboardingState(session.login)
          : null
        sendJson(
          response,
          200,
          {
            oidc: oidcClient && opts.oidc
              ? {
                  enabled: true,
                  issuer: opts.oidc.issuer,
                  onboardingMode: opts.onboardingMode ?? 'closed',
                  provider: opts.oidc.provider,
                  signupAvailable: Boolean(authStore && !authStore.hasUsers()),
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
                  accessRequest: onboarding?.accessRequest
                    ? toViewerWorkspaceAccessRequestPayload(onboarding.accessRequest)
                    : null,
                  instanceOperator: onboarding?.instanceOperator ?? false,
                  projectPublicId: principalSession?.project.publicId,
                  role: principalSession?.membership.role,
                  subject: session.subject,
                  tenant: principalSession?.tenant.slug,
                  tenantPublicId: principalSession?.tenant.publicId,
                  userDisplayName: session.userDisplayName,
                  userId: session.userId,
                  workspaces: onboarding?.memberships.map((membership) => ({
                    displayName: membership.tenant.displayName,
                    publicId: membership.tenant.publicId,
                    role: membership.role,
                  })) ?? [],
                }
              : null,
          },
          headOnly,
        )
        return
      }

      if (isOnboardingRequestRoute) {
        if (!authStore || !sessionSecret) {
          sendJson(response, 501, { error: 'Viewer auth is not configured.' }, headOnly)
          return
        }
        const session = getActiveSession(request)
        if (!session) {
          sendJson(response, 401, { error: 'Sign in to request a workspace.' }, headOnly)
          return
        }
        if ((opts.onboardingMode ?? 'closed') === 'closed') {
          sendJson(response, 403, { error: 'New workspace requests are currently closed.' }, headOnly)
          return
        }
        if (method !== 'POST') {
          sendMethodNotAllowed(response)
          return
        }

        let payload
        try {
          payload = await readJsonBody(request) as {
            intendedUse?: unknown
            workspaceName?: unknown
          }
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        if (typeof payload.workspaceName !== 'string' || payload.workspaceName.trim().length === 0) {
          sendJson(response, 400, { error: 'Enter a workspace name.' })
          return
        }
        if (payload.workspaceName.trim().length > 160) {
          sendJson(response, 400, { error: 'Workspace name must be 160 characters or fewer.' })
          return
        }
        if (payload.intendedUse !== undefined && payload.intendedUse !== null && typeof payload.intendedUse !== 'string') {
          sendJson(response, 400, { error: 'Intended use must be a string.' })
          return
        }
        if (typeof payload.intendedUse === 'string' && payload.intendedUse.trim().length > 4_000) {
          sendJson(response, 400, { error: 'Intended use must be 4,000 characters or fewer.' })
          return
        }

        try {
          const accessRequest = authStore.createWorkspaceAccessRequest({
            intendedUse: typeof payload.intendedUse === 'string' ? payload.intendedUse : undefined,
            userLogin: session.login,
            workspaceName: payload.workspaceName,
          })
          sendJson(response, 200, {
            accessRequest: toViewerWorkspaceAccessRequestPayload(accessRequest),
          })
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      if (isInvitationAcceptRoute) {
        if (!authStore) {
          sendJson(response, 501, { error: 'Viewer auth is not configured.' }, headOnly)
          return
        }
        const token = url.searchParams.get('token')?.trim()
        if (!token) {
          sendJson(response, 400, { error: 'Missing invitation token.' }, headOnly)
          return
        }
        const invitation = authStore.getTenantInvitation(token)
        if (!invitation) {
          sendJson(response, 404, { error: 'Invitation was not found.' }, headOnly)
          return
        }
        if (method === 'GET' || method === 'HEAD') {
          sendJson(response, 200, { invitation: toViewerTenantInvitationPayload(invitation) }, headOnly)
          return
        }

        const session = getActiveSession(request)
        if (!session) {
          sendJson(response, 401, { error: 'Sign in to accept this invitation.' })
          return
        }
        try {
          const principalSession = authStore.acceptTenantInvitation({ token, userLogin: session.login })
          await ensureViewerProjectWorkspace(opts, authStore, session.login, principalSession.project.slug)
          sendJson(response, 200, {
            invitation: toViewerTenantInvitationPayload(authStore.getTenantInvitation(token)),
            workspace: {
              displayName: principalSession.tenant.displayName,
              projectPublicId: principalSession.project.publicId,
              publicId: principalSession.tenant.publicId,
            },
          })
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      if (isInvitationRoute) {
        if (!authStore || !sessionSecret) {
          sendJson(response, 501, { error: 'Viewer auth is not configured.' }, headOnly)
          return
        }
        const session = getActiveSession(request)
        if (!session) {
          sendJson(response, 401, { error: 'Sign in to invite workspace members.' }, headOnly)
          return
        }
        if (method !== 'POST') {
          sendMethodNotAllowed(response)
          return
        }
        let payload
        try {
          payload = await readJsonBody(request) as { email?: unknown; role?: unknown }
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        if (typeof payload.email !== 'string' || !payload.email.trim()) {
          sendJson(response, 400, { error: 'Enter an email address.' })
          return
        }
        let role: AuthMembershipRole
        try {
          role = parseMembershipRole(payload.role)
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        try {
          const invitation = authStore.createTenantInvitation({
            email: payload.email,
            inviterLogin: session.login,
            role,
          })
          const origin = getViewerRequestOrigin(request, opts.publicOrigin)
          sendJson(response, 200, {
            invitation: toViewerTenantInvitationPayload(invitation),
            inviteUrl: `${origin}/invite/${encodeURIComponent(invitation.token)}`,
          })
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      if (isOperatorWorkspaceRequestsRoute) {
        if (!authStore || !sessionSecret) {
          sendJson(response, 501, { error: 'Viewer auth is not configured.' }, headOnly)
          return
        }
        const session = getActiveSession(request)
        if (!session) {
          sendJson(response, 401, { error: 'Sign in as an instance operator.' }, headOnly)
          return
        }

        if (method === 'GET' || method === 'HEAD') {
          const requestedStatus = url.searchParams.get('status')?.trim()
          if (requestedStatus && requestedStatus !== 'pending' && requestedStatus !== 'approved' && requestedStatus !== 'rejected') {
            sendJson(response, 400, { error: 'Unsupported workspace request status.' }, headOnly)
            return
          }
          try {
            const requests = authStore.listWorkspaceAccessRequests({
              reviewerLogin: session.login,
              status: requestedStatus as 'approved' | 'pending' | 'rejected' | undefined,
            })
            sendJson(response, 200, {
              requests: requests.map(toViewerWorkspaceAccessRequestPayload),
            }, headOnly)
          } catch (error) {
            sendJson(response, 403, { error: error instanceof Error ? error.message : String(error) }, headOnly)
          }
          return
        }

        if (method === 'PATCH') {
          let payload
          try {
            payload = await readJsonBody(request) as {
              decision?: unknown
              publicId?: unknown
              reviewNote?: unknown
            }
          } catch (error) {
            sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
            return
          }
          if (payload.decision !== 'approved' && payload.decision !== 'rejected') {
            sendJson(response, 400, { error: 'Decision must be approved or rejected.' })
            return
          }
          if (typeof payload.publicId !== 'string' || payload.publicId.trim().length === 0) {
            sendJson(response, 400, { error: 'Missing workspace request id.' })
            return
          }
          if (payload.reviewNote !== undefined && payload.reviewNote !== null && typeof payload.reviewNote !== 'string') {
            sendJson(response, 400, { error: 'Review note must be a string.' })
            return
          }

          try {
            const accessRequest = authStore.reviewWorkspaceAccessRequest({
              decision: payload.decision,
              publicId: payload.publicId,
              reviewerLogin: session.login,
              reviewNote: typeof payload.reviewNote === 'string' ? payload.reviewNote : undefined,
            })
            if (accessRequest.status === 'approved') {
              await ensureViewerProjectWorkspace(opts, authStore, accessRequest.requesterLogin, 'default')
            }
            sendJson(response, 200, {
              accessRequest: toViewerWorkspaceAccessRequestPayload(accessRequest),
            })
          } catch (error) {
            sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        sendMethodNotAllowed(response)
        return
      }

      if (isCliLoginRequestRoute) {
        if (method !== 'POST') {
          sendMethodNotAllowed(response)
          return
        }

        let payload
        try {
          payload = await readJsonBody(request) as {
            callbackUrl?: unknown
            publicKey?: unknown
            scopes?: unknown
            state?: unknown
            ttlSeconds?: unknown
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
        if (typeof payload.callbackUrl !== 'string' || !isLocalCallbackUrl(payload.callbackUrl)) {
          sendJson(response, 400, { error: 'callbackUrl must be a local http URL.' })
          return
        }
        if (typeof payload.state !== 'string' || payload.state.trim().length === 0) {
          sendJson(response, 400, { error: 'Missing state.' })
          return
        }
        const ttlSeconds = payload.ttlSeconds
        if (ttlSeconds !== undefined && ttlSeconds !== null && (typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0)) {
          sendJson(response, 400, { error: 'ttlSeconds must be a positive integer.' })
          return
        }
        if (
          payload.scopes !== undefined
          && (!Array.isArray(payload.scopes) || !payload.scopes.every((scope) => typeof scope === 'string'))
        ) {
          sendJson(response, 400, { error: 'scopes must be an array of strings.' })
          return
        }

        const id = randomUUID()
        const createdAt = Date.now()
        const loginRequest: CliLoginRequest = {
          approveToken: randomUUID(),
          callbackUrl: payload.callbackUrl,
          createdAt,
          expiresAt: createdAt + CLI_LOGIN_REQUEST_TTL_MS,
          id,
          publicKey: payload.publicKey,
          scopes: Array.isArray(payload.scopes) ? payload.scopes : undefined,
          state: payload.state,
          ttlSeconds: typeof ttlSeconds === 'number' ? ttlSeconds : undefined,
        }
        cliLoginRequests.set(id, loginRequest)

        const origin = getViewerRequestOrigin(request, opts.publicOrigin)
        sendJson(response, 200, {
          expiresAt: new Date(loginRequest.expiresAt).toISOString(),
          id,
          loginUrl: `${origin}/cli-login/${encodeURIComponent(id)}`,
        }, headOnly)
        return
      }

      if (cliLoginViewMatch) {
        if (!authStore || !sessionSecret) {
          sendJson(response, 501, { error: 'Viewer auth is not configured.' }, headOnly)
          return
        }

        const loginRequest = getValidCliLoginRequest(cliLoginRequests, cliLoginViewMatch[1])
        if (!loginRequest) {
          sendHtml(response, 404, '<!doctype html><html lang="en"><body><main><h1>CLI login request expired</h1><p>Run docs-ssh login again.</p></main></body></html>', headOnly)
          return
        }

        const session = getActiveSession(request)
        if (!session) {
          redirect(response, `/auth/login?returnTo=${encodeURIComponent(url.pathname)}`, { headOnly })
          return
        }

        sendHtml(response, 200, createCliLoginRequestHtml(loginRequest, session), headOnly)
        return
      }

      if (cliLoginApproveMatch) {
        if (!authStore || !sessionSecret) {
          sendJson(response, 501, { error: 'Viewer auth is not configured.' }, headOnly)
          return
        }

        const loginRequest = getValidCliLoginRequest(cliLoginRequests, cliLoginApproveMatch[1])
        if (!loginRequest) {
          sendHtml(response, 404, '<!doctype html><html lang="en"><body><main><h1>CLI login request expired</h1><p>Run docs-ssh login again.</p></main></body></html>', headOnly)
          return
        }

        const session = getActiveSession(request)
        if (!session) {
          redirect(response, `/auth/login?returnTo=${encodeURIComponent(`/cli-login/${loginRequest.id}`)}`, { headOnly })
          return
        }

        let form
        try {
          form = await readFormBody(request)
        } catch (error) {
          sendHtml(response, 400, `<!doctype html><html lang="en"><body><main><h1>Invalid approval</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></main></body></html>`)
          return
        }

        if (form.get('approveToken') !== loginRequest.approveToken) {
          sendHtml(response, 403, '<!doctype html><html lang="en"><body><main><h1>Invalid approval token</h1></main></body></html>')
          return
        }

        try {
          const sshSession = authStore.createSshSession({
            publicKey: loginRequest.publicKey,
            scopes: loginRequest.scopes,
            ttlSeconds: loginRequest.ttlSeconds,
            userLogin: session.login,
          })
          loginRequest.code = randomUUID()
          loginRequest.result = toViewerSshSessionPayload(sshSession)
          redirect(
            response,
            appendQueryParams(loginRequest.callbackUrl, {
              code: loginRequest.code,
              request: loginRequest.id,
              state: loginRequest.state,
            }),
          )
        } catch (error) {
          sendHtml(response, 400, `<!doctype html><html lang="en"><body><main><h1>Could not authorize CLI login</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></main></body></html>`)
        }
        return
      }

      if (isCliLoginExchangeRoute) {
        if (method !== 'POST') {
          sendMethodNotAllowed(response)
          return
        }

        let payload
        try {
          payload = await readJsonBody(request) as {
            code?: unknown
            request?: unknown
          }
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          })
          return
        }

        if (typeof payload.request !== 'string' || typeof payload.code !== 'string') {
          sendJson(response, 400, { error: 'Missing request or code.' })
          return
        }

        const loginRequest = getValidCliLoginRequest(cliLoginRequests, payload.request)
        if (!loginRequest || loginRequest.code !== payload.code || !loginRequest.result) {
          sendJson(response, 404, { error: 'CLI login request was not found or is not approved.' })
          return
        }
        if (loginRequest.consumedAt) {
          sendJson(response, 410, { error: 'CLI login code was already consumed.' })
          return
        }

        loginRequest.consumedAt = Date.now()
        cliLoginRequests.delete(loginRequest.id)
        sendJson(response, 200, {
          session: loginRequest.result,
        })
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

      if (isApiTokenRoute) {
        if (!authStore || !sessionSecret) {
          sendJson(response, 501, { error: 'Viewer auth is not configured.' }, headOnly)
          return
        }

        const session = getActiveSession(request)
        if (!session) {
          sendJson(response, 401, { error: 'Sign in to manage API tokens.' }, headOnly)
          return
        }

        const requestedProject = url.searchParams.get('project')?.trim() || undefined
        const principalSession = authStore.findUserProjectSession(session.login, requestedProject)
        if (!principalSession || !canManageUsers(principalSession)) {
          sendJson(response, 403, { error: 'Only owners and admins can manage API tokens.' }, headOnly)
          return
        }

        if (method === 'GET' || method === 'HEAD') {
          sendJson(
            response,
            200,
            {
              tokens: authStore
                .listApiTokens({
                  projectSlug: requestedProject,
                  tenantSlug: principalSession.tenant.slug,
                  userLogin: session.login,
                })
                .map((token) => toViewerApiTokenPayload(token)),
            },
            headOnly,
          )
          return
        }

        if (method === 'POST') {
          let payload
          try {
            payload = await readJsonBody(request) as {
              expiresAt?: unknown
              label?: unknown
              project?: unknown
              scopes?: unknown
            }
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            })
            return
          }

          if (typeof payload.project !== 'string' || payload.project.trim().length === 0) {
            sendJson(response, 400, { error: 'Missing project slug.' })
            return
          }
          if (payload.label !== undefined && payload.label !== null && typeof payload.label !== 'string') {
            sendJson(response, 400, { error: 'API token label must be a string.' })
            return
          }
          if (payload.expiresAt !== undefined && payload.expiresAt !== null && typeof payload.expiresAt !== 'string') {
            sendJson(response, 400, { error: 'API token expiration must be a string.' })
            return
          }

          let scopes: AuthApiTokenScope[] | undefined
          try {
            scopes = parseApiTokenScopes(payload.scopes)
          } catch (error) {
            sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
            return
          }

          const tokenProjectSession = authStore.findUserProjectSession(session.login, payload.project)
          if (!tokenProjectSession || !canManageUsers(tokenProjectSession)) {
            sendJson(response, 403, { error: 'Only owners and admins can manage API tokens.' })
            return
          }

          try {
            const token = authStore.createApiToken({
              expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : undefined,
              label: typeof payload.label === 'string' ? payload.label : undefined,
              projectSlug: payload.project,
              scopes,
              tenantSlug: tokenProjectSession.tenant.slug,
              userLogin: session.login,
            })
            sendJson(response, 200, {
              token: toViewerApiTokenPayload(token, token.token),
              tokens: authStore
                .listApiTokens({
                  projectSlug: token.projectSlug,
                  tenantSlug: tokenProjectSession.tenant.slug,
                  userLogin: session.login,
                })
                .map((entry) => toViewerApiTokenPayload(entry)),
            })
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            })
          }
          return
        }

        if (method === 'DELETE') {
          const id = url.searchParams.get('id')?.trim()
          if (!id) {
            sendJson(response, 400, { error: 'Missing API token id.' })
            return
          }

          try {
            const token = authStore.revokeApiToken({
              id,
              userLogin: session.login,
            })
            sendJson(response, 200, {
              token: toViewerApiTokenPayload(token),
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

      if (isSshSessionRoute) {
        if (!authStore) {
          sendJson(response, 501, { error: 'Viewer auth is not configured.' }, headOnly)
          return
        }

        if (method === 'POST') {
          let payload
          try {
            payload = await readJsonBody(request) as {
              project?: unknown
              publicKey?: unknown
              scopes?: unknown
              ttlSeconds?: unknown
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
          if (payload.project !== undefined && payload.project !== null && typeof payload.project !== 'string') {
            sendJson(response, 400, { error: 'Project slug must be a string.' })
            return
          }
          const ttlSeconds = payload.ttlSeconds
          if (ttlSeconds !== undefined && ttlSeconds !== null && (typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0)) {
            sendJson(response, 400, { error: 'ttlSeconds must be a positive integer.' })
            return
          }
          if (
            payload.scopes !== undefined
            && (!Array.isArray(payload.scopes) || !payload.scopes.every((scope) => typeof scope === 'string'))
          ) {
            sendJson(response, 400, { error: 'scopes must be an array of strings.' })
            return
          }

          const session = getActiveSession(request)
          let apiTokenSession: AuthApiTokenSession | null = null
          if (!session) {
            const bearerToken = getBearerToken(request)
            if (!bearerToken) {
              sendJson(response, 401, { error: 'Sign in to create SSH sessions.' }, headOnly)
              return
            }
            try {
              apiTokenSession = authStore.authenticateApiToken(bearerToken, {
                projectSlug: typeof payload.project === 'string' ? payload.project : undefined,
                requiredScopes: ['ssh-session:create'],
              })
            } catch (error) {
              sendJson(response, 403, { error: error instanceof Error ? error.message : String(error) })
              return
            }
            if (!apiTokenSession) {
              sendJson(response, 401, { error: 'API token is invalid or expired.' })
              return
            }
          }

          try {
            const sshSession = authStore.createSshSession({
              projectSlug: apiTokenSession?.principalSession.project.slug
                ?? (typeof payload.project === 'string' ? payload.project : undefined),
              publicKey: payload.publicKey,
              scopes: apiTokenSession?.token.scopes ?? (Array.isArray(payload.scopes) ? payload.scopes : undefined),
              sourceApiTokenId: apiTokenSession?.token.id,
              ttlSeconds: typeof ttlSeconds === 'number' ? ttlSeconds : undefined,
              userLogin: session?.login ?? apiTokenSession?.principalSession.login,
            })
            sendJson(response, 200, {
              session: toViewerSshSessionPayload(sshSession),
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

      if (isProjectRoute) {
        if (!authStore || !sessionSecret) {
          sendJson(response, 501, { error: 'Viewer auth is not configured.' }, headOnly)
          return
        }

        const session = getActiveSession(request)
        if (!session) {
          sendJson(response, 401, { error: 'Sign in to manage projects.' }, headOnly)
          return
        }

        if (method === 'GET' || method === 'HEAD') {
          const principalSession = authStore.findUserProjectSession(session.login)
          const requestedWorkspacePublicId = url.searchParams.get('workspaceId')?.trim()
          const requestedTenant = requestedWorkspacePublicId
            ? authStore.getTenantByPublicId(requestedWorkspacePublicId)
            : principalSession?.tenant ?? null
          const onboarding = authStore.getUserOnboardingState(session.login)
          if (
            !requestedTenant
            || !onboarding?.memberships.some((membership) => membership.tenant.id === requestedTenant.id)
          ) {
            sendJson(response, 404, { error: 'Workspace was not found or is not accessible.' }, headOnly)
            return
          }
          sendJson(
            response,
            200,
            {
              projects: authStore.listProjects({
                tenantSlug: requestedTenant.slug,
                userLogin: session.login,
              }).map(toViewerProjectPayload),
            },
            headOnly,
          )
          return
        }

        if (method === 'POST') {
          let payload
          try {
            payload = await readJsonBody(request) as {
              displayName?: unknown
              slug?: unknown
            }
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            })
            return
          }

          if (typeof payload.slug !== 'string' || payload.slug.trim().length === 0) {
            sendJson(response, 400, { error: 'Missing project slug.' })
            return
          }
          if (payload.displayName !== undefined && payload.displayName !== null && typeof payload.displayName !== 'string') {
            sendJson(response, 400, { error: 'Project display name must be a string.' })
            return
          }

          try {
            const project = authStore.createProject({
              displayName: typeof payload.displayName === 'string' ? payload.displayName : undefined,
              slug: payload.slug,
              userLogin: session.login,
            })
            await ensureViewerProjectWorkspace(opts, authStore, session.login, project.slug)
            sendJson(response, 200, {
              project: toViewerProjectPayload(project),
            })
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            })
          }
          return
        }

        if (method === 'PATCH') {
          let payload
          try {
            payload = await readJsonBody(request) as {
              displayName?: unknown
              newSlug?: unknown
              slug?: unknown
            }
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            })
            return
          }

          if (typeof payload.slug !== 'string' || payload.slug.trim().length === 0) {
            sendJson(response, 400, { error: 'Missing project slug.' })
            return
          }
          if (payload.displayName !== undefined && payload.displayName !== null && typeof payload.displayName !== 'string') {
            sendJson(response, 400, { error: 'Project display name must be a string.' })
            return
          }
          if (payload.newSlug !== undefined && payload.newSlug !== null && typeof payload.newSlug !== 'string') {
            sendJson(response, 400, { error: 'New project slug must be a string.' })
            return
          }

          try {
            const project = authStore.updateProject({
              displayName: typeof payload.displayName === 'string' ? payload.displayName : undefined,
              newSlug: typeof payload.newSlug === 'string' ? payload.newSlug : undefined,
              slug: payload.slug,
              userLogin: session.login,
            })
            await ensureViewerProjectWorkspace(opts, authStore, session.login, project.slug)
            sendJson(response, 200, {
              project: toViewerProjectPayload(project),
            })
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            })
          }
          return
        }

        if (method === 'DELETE') {
          const slug = url.searchParams.get('slug')
          if (!slug || slug.trim().length === 0) {
            sendJson(response, 400, { error: 'Missing project slug.' })
            return
          }

          try {
            const project = authStore.archiveProject({
              slug,
              userLogin: session.login,
            })
            sendJson(response, 200, {
              project: toViewerProjectPayload(project),
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

      if (isUserRoute) {
        if (!authStore || !sessionSecret) {
          sendJson(response, 501, { error: 'Viewer auth is not configured.' }, headOnly)
          return
        }

        const session = getActiveSession(request)
        if (!session) {
          sendJson(response, 401, { error: 'Sign in to manage users.' }, headOnly)
          return
        }

        const principalSession = authStore.findUserProjectSession(session.login)
        if (!principalSession || !canManageUsers(principalSession)) {
          sendJson(response, 403, { error: 'Only owners and admins can manage users.' }, headOnly)
          return
        }

        if (method === 'GET' || method === 'HEAD') {
          sendJson(
            response,
            200,
            {
              users: authStore.listUsers({ tenantSlug: principalSession.tenant.slug }).map(toViewerUserPayload),
            },
            headOnly,
          )
          return
        }

        if (method === 'POST') {
          let payload
          try {
            payload = await readJsonBody(request) as {
              displayName?: unknown
              email?: unknown
              issuer?: unknown
              login?: unknown
              provider?: unknown
              role?: unknown
              subject?: unknown
            }
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            })
            return
          }

          if (typeof payload.login !== 'string' || payload.login.trim().length === 0) {
            sendJson(response, 400, { error: 'Missing user login.' })
            return
          }
          if (payload.displayName !== undefined && payload.displayName !== null && typeof payload.displayName !== 'string') {
            sendJson(response, 400, { error: 'Display name must be a string.' })
            return
          }
          if (typeof payload.issuer !== 'string' || payload.issuer.trim().length === 0) {
            sendJson(response, 400, { error: 'Missing identity issuer.' })
            return
          }
          if (typeof payload.subject !== 'string' || payload.subject.trim().length === 0) {
            sendJson(response, 400, { error: 'Missing identity subject.' })
            return
          }
          if (payload.provider !== undefined && payload.provider !== null && typeof payload.provider !== 'string') {
            sendJson(response, 400, { error: 'Identity provider must be a string.' })
            return
          }
          if (payload.email !== undefined && payload.email !== null && typeof payload.email !== 'string') {
            sendJson(response, 400, { error: 'Identity email must be a string.' })
            return
          }

          let role: AuthMembershipRole
          try {
            role = parseMembershipRole(payload.role)
          } catch (error) {
            sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
            return
          }
          if (role === 'owner' && principalSession.membership.role !== 'owner') {
            sendJson(response, 403, { error: 'Only owners can assign the owner role.' })
            return
          }
          const targetLogin = normalizeViewerIdentifier(payload.login)
          const existingTargetUser = targetLogin
            ? authStore
                .listUsers({ tenantSlug: principalSession.tenant.slug })
                .find((user) => user.login === targetLogin)
            : null
          if (existingTargetUser && principalSession.membership.role !== 'owner') {
            if (existingTargetUser.role === 'owner') {
              sendJson(response, 403, { error: 'Only owners can update owner users.' })
              return
            }
            if (existingTargetUser.role !== role) {
              sendJson(response, 403, { error: 'Only owners can change existing user roles.' })
              return
            }
          }

          try {
            const user = authStore.addUser({
              displayName: typeof payload.displayName === 'string' ? payload.displayName : undefined,
              identity: {
                email: typeof payload.email === 'string' ? payload.email : undefined,
                issuer: payload.issuer,
                provider: typeof payload.provider === 'string' ? payload.provider : undefined,
                subject: payload.subject,
              },
              login: payload.login,
              role,
              tenantSlug: principalSession.tenant.slug,
            })
            sendJson(response, 200, {
              user: toViewerUserPayload(user),
              users: authStore.listUsers({ tenantSlug: principalSession.tenant.slug }).map(toViewerUserPayload),
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
          const verifiedEmail = identity.emailVerified ? identity.email : undefined
          const user = authStore.findUserByAuthIdentity({
            issuer: identity.issuer,
            provider: opts.oidc.provider,
            subject: identity.subject,
          })

          const signedUpUser = !user
            ? authStore.signUpFirstUserWithAuthIdentity({
                email: verifiedEmail,
                issuer: identity.issuer,
                ownerLogin: deriveFirstOwnerLogin(verifiedEmail),
                ownerName: deriveFirstOwnerName(verifiedEmail),
                provider: opts.oidc.provider,
                subject: identity.subject,
              })?.owner.user
            : null

          const invitationToken = /^\/invite\/([^/]+)$/u.exec(pendingLogin.returnTo)?.[1]
          const invitation = invitationToken
            ? authStore.getTenantInvitation(decodeURIComponent(invitationToken))
            : null
          const invitationRegistrationAllowed = Boolean(
            invitation
            && invitation.status === 'pending'
            && verifiedEmail
            && invitation.email === verifiedEmail.trim().toLowerCase(),
          )

          const registeredUser = !user
            && !signedUpUser
            && (opts.onboardingMode === 'approval' || invitationRegistrationAllowed)
            ? authStore.registerUserWithAuthIdentity({
                displayName: deriveFirstOwnerName(verifiedEmail) ?? 'User',
                email: verifiedEmail,
                issuer: identity.issuer,
                login: deriveFirstOwnerLogin(verifiedEmail) ?? 'user',
                provider: opts.oidc.provider,
                subject: identity.subject,
              }).user
            : null

          const resolvedUser = user ?? signedUpUser ?? registeredUser

          if (!resolvedUser) {
            sendAuthError(
              response,
              403,
              'New account registration is currently closed on this server.',
              {
                clearCookies: [clearPendingOidcCookie(secure), clearViewerSessionCookie(secure)],
                details: [
                  { label: 'provider', value: opts.oidc.provider },
                  { label: 'issuer', value: identity.issuer },
                  { label: 'subject', value: identity.subject },
                ],
                headOnly,
                nextSteps: [
                  'If you already have access, try again with the Google account that the owner linked.',
                  'If you are a new user, ask the server operator when workspace requests will reopen.',
                ],
                title: 'Registration closed',
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
                  email: verifiedEmail,
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

      const session = getActiveSession(request)
      const requestedProjectSlug = getRequestedProjectSlug(url)
      let requestedPublicProject: ReturnType<typeof getRequestedPublicProject>
      try {
        requestedPublicProject = getRequestedPublicProject(url)
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }, headOnly)
        return
      }
      const requestedPrincipalSession = session && authStore && requestedPublicProject
        ? authStore.findUserProjectSessionByPublicIds(
            session.login,
            requestedPublicProject.tenantPublicId,
            requestedPublicProject.projectPublicId,
          )
        : null
      if (session && requestedPublicProject && !requestedPrincipalSession) {
        sendJson(response, 404, { error: 'Workspace or project was not found or is not accessible.' }, headOnly)
        return
      }
      let apiTokenSession: AuthApiTokenSession | null = null
      if (authStore && isProtectedViewerDataRoute(url.pathname) && !session) {
        const bearerToken = getBearerToken(request)
        if (bearerToken) {
          try {
            apiTokenSession = authStore.authenticateApiToken(bearerToken, {
              projectSlug: requestedProjectSlug,
              requiredScopes: ['project:read'],
            })
          } catch (error) {
            sendJson(response, 403, { error: error instanceof Error ? error.message : String(error) }, headOnly)
            return
          }
          if (!apiTokenSession) {
            sendJson(response, 401, { error: 'API token is invalid or expired.' }, headOnly)
            return
          }
        }
      }

      if (authStore && sessionSecret && isProtectedViewerDataRoute(url.pathname) && !session && !apiTokenSession) {
        if (url.pathname === '/api/raw' && oidcClient) {
          response.writeHead(302, {
            'Cache-Control': 'no-store',
            Location: `/auth/login?returnTo=${encodeURIComponent(buildViewerReturnTo(url))}`,
          })
          response.end()
          return
        }

        sendJson(response, 401, { error: 'Sign in to access viewer data.' }, headOnly)
        return
      }

      let context
      try {
        context = await loadViewerContext(opts, {
          authStore,
          includeHome: !apiTokenSession,
          principalSession: apiTokenSession?.principalSession ?? requestedPrincipalSession,
          projectSlug: apiTokenSession?.principalSession.project.slug ?? requestedProjectSlug,
          session,
          scopedProjectOnly: Boolean(apiTokenSession || requestedPrincipalSession),
        })
      } catch (error) {
        sendJson(response, 404, {
          error: error instanceof Error ? error.message : String(error),
        }, headOnly)
        return
      }
      const publicMounts = context.mounts.map((mount) => ({
        aliases: mount.aliases,
        label: mount.label,
        mountPath: mount.mountPath,
        type: mount.type,
      }))

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
        if (
          code === 'ENOENT'
          && (
            /^\/w\/[^/]+\/p\/[^/]+(?:\/files(?:\/.*)?)?$/u.test(url.pathname)
            || /^\/invite\/[^/]+$/u.test(url.pathname)
          )
        ) {
          try {
            await serveStaticFile(staticDir, '/', response, headOnly)
            return
          } catch {
            // Fall through to the missing-assets page below.
          }
        }
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
