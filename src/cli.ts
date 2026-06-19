#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { access, appendFile, chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import ssh2 from 'ssh2'
import { createAuthStore, type AuthStore } from './auth/store.js'
import { inferViewerOrigin } from './cli-login-config.js'
import { loadLocalEnvFile } from './env.js'
import { loadInstanceConfig } from './instance-config.js'
import {
  addSourceToRegistry,
  createEmptyRegistry,
  createFallbackRegistry,
  createSourceSpec,
  makeRootPathPortable,
  getStatePaths,
  normalizeSourceName,
  readSourceRegistry,
  writeSourceRegistry,
  loadSourceStore,
} from './sources/source-store.js'
import type { SourceRegistry, SourceSpec } from './sources/types.js'
import { getGitRepoPreset } from './ingest/presets.js'
import { findProjectConfig } from './project-config.js'
import {
  createAgentsMarkdown,
  createSetupMarkdown,
  createSkillMarkdown,
} from './shell/helper-content.js'
import { ensureWorkspaceLayout } from './workspace/layout.js'

const execFileAsync = promisify(execFile)
const { utils: sshUtils } = ssh2

const DEFAULT_CLI_LOGIN_TTL_SECONDS = 60 * 60
const DEFAULT_CLI_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

loadLocalEnvFile()

interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | boolean>
}

interface CliLoginConfig {
  project: string
  server: string
  viewerOrigin: string
}

type CliSessionScope = 'project' | 'server'

interface CliSessionFile {
  createdAt: string
  expiresAt: string
  fingerprint: string
  identityFile: string
  project: string
  scopes: string[]
  server: string
  sshCommand: string
  username: string
  viewerOrigin: string
}

interface CliSshSessionPayload {
  createdAt: string
  expiresAt: string
  fingerprint: string
  project: string
  scopes: string[]
  username: string
}

function printUsage(): void {
  console.log(`docs-ssh CLI

Usage:
  docs-ssh ingest local-folder <path> [--name <name>] [--default]
  docs-ssh ingest git-repo <repo-url> [--name <name>] [--subdir <path>] [--ref <ref>] [--default]
  docs-ssh ingest <preset> [--name <name>] [--default]
  docs-ssh sources list
  docs-ssh login [--server <alias>] [--viewer-origin <url>] [--ttl-seconds <seconds>] [--json] [--no-open]
  docs-ssh token login --token <token> [--server <alias>] [--project <slug>] [--viewer-origin <url>] [--ttl-seconds <seconds>] [--json]
  docs-ssh status [--server <alias>] [--project <slug>] [--json]
  docs-ssh logout [--server <alias>] [--project <slug>] [--json]
  docs-ssh projects list [--db-path <path>] [--user <login>] [--tenant-slug <slug>] [--all]
  docs-ssh projects create --project <slug> [--display-name <name>] [--db-path <path>] [--user <login>] [--tenant-slug <slug>]
  docs-ssh projects update --project <slug> --display-name <name> [--db-path <path>] [--user <login>] [--tenant-slug <slug>]
  docs-ssh projects archive --project <slug> [--db-path <path>] [--user <login>] [--tenant-slug <slug>]
  docs-ssh auth init [--db-path <path>] [--tenant-slug <slug>] [--tenant-name <name>] [--owner-login <login>] [--owner-name <name>]
  docs-ssh auth create-project --project <slug> [--display-name <name>] [--db-path <path>] [--user <login>] [--tenant-slug <slug>]
  docs-ssh auth list-projects [--db-path <path>] [--user <login>] [--tenant-slug <slug>] [--all]
  docs-ssh auth add-ssh-key <public-key-path> [--db-path <path>] [--user <login>] [--name <name>]
  docs-ssh auth create-ssh-session <public-key-path> [--db-path <path>] [--user <login>] [--tenant-slug <slug>] [--project <slug>] [--scopes <csv>] [--ttl-seconds <seconds>] [--username <name>]
  docs-ssh auth list-ssh-sessions [--db-path <path>] [--user <login>] [--tenant-slug <slug>] [--all] [--include-expired] [--include-revoked]
  docs-ssh auth revoke-ssh-session <session-id-or-username> [--db-path <path>] [--user <login>]
  docs-ssh auth add-web-identity --issuer <issuer> --subject <subject> [--provider <provider>] [--email <email>] [--user <login>] [--db-path <path>]
  docs-ssh helper agents [--output <path>] [--append]
  docs-ssh helper skill [--output <path>]
  docs-ssh helper setup [--output <path>]

Initial presets:
  github
  supabase
  neon
  cloudflare
`)
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | boolean>()

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--') continue
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }

    const key = token.slice(2)
    const next = argv[index + 1]

    if (!next || next.startsWith('--')) {
      flags.set(key, true)
      continue
    }

    flags.set(key, next)
    index += 1
  }

  return { positionals, flags }
}

function getFlagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

function getFlagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true
}

function getOptionalIntegerFlag(args: ParsedArgs, name: string): number | undefined {
  const value = getFlagString(args, name)
  if (value === undefined) return undefined

  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`)
  }

  return parsed
}

function getRequiredFlagString(args: ParsedArgs, name: string): string {
  const value = getFlagString(args, name)
  if (!value) {
    throw new Error(`Missing required --${name} flag.`)
  }
  return value
}

function getJsonFlag(args: ParsedArgs): boolean {
  return getFlagBoolean(args, 'json')
}

function normalizeViewerOrigin(value: string): string {
  return value.replace(/\/+$/u, '')
}

function sanitizePathPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'default'
}

function getDocsSshHome(args: ParsedArgs): string {
  return resolve(getFlagString(args, 'home') ?? process.env.DOCS_SSH_HOME ?? `${homedir()}/.docs-ssh`)
}

function getCliSessionDir(
  args: ParsedArgs,
  config: Pick<CliLoginConfig, 'project' | 'server'>,
  scope: CliSessionScope = 'project',
): string {
  const pathParts = [
    getDocsSshHome(args),
    'sessions',
    sanitizePathPart(config.server),
  ]
  if (scope === 'project') pathParts.push(sanitizePathPart(config.project))
  return resolve(...pathParts)
}

function getCliSessionPath(
  args: ParsedArgs,
  config: Pick<CliLoginConfig, 'project' | 'server'>,
  scope: CliSessionScope = 'project',
): string {
  return resolve(getCliSessionDir(args, config, scope), 'session.json')
}

async function resolveCliLoginConfig(args: ParsedArgs): Promise<CliLoginConfig> {
  const projectConfig = await findProjectConfig()
  const server = getFlagString(args, 'server') ?? projectConfig?.server ?? 'docs-ssh'
  const project = getFlagString(args, 'project') ?? projectConfig?.project ?? 'default'
  const viewerOrigin = normalizeViewerOrigin(
    getFlagString(args, 'viewer-origin')
    ?? projectConfig?.viewerOrigin
    ?? process.env.DOCS_SSH_VIEWER_ORIGIN
    ?? inferViewerOrigin(server),
  )

  return {
    project,
    server,
    viewerOrigin,
  }
}

async function readCliSessionFile(path: string): Promise<CliSessionFile | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as CliSessionFile
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

async function readCliSession(args: ParsedArgs, config: Pick<CliLoginConfig, 'project' | 'server'>): Promise<CliSessionFile | null> {
  const serverSession = await readCliSessionFile(getCliSessionPath(args, config, 'server'))
  if (serverSession) return serverSession
  return readCliSessionFile(getCliSessionPath(args, config, 'project'))
}

function isCliSessionActive(session: CliSessionFile | null): boolean {
  return Boolean(session && Date.parse(session.expiresAt) > Date.now())
}

function createSshCommand(session: {
  identityFile: string
  server: string
  username: string
}): string {
  return `ssh -i ${session.identityFile} ${session.username}@${session.server}`
}

async function createCliIdentity(
  args: ParsedArgs,
  config: Pick<CliLoginConfig, 'project' | 'server'>,
  scope: CliSessionScope = 'project',
): Promise<{
  identityFile: string
  publicKey: string
}> {
  const sessionDir = getCliSessionDir(args, config, scope)
  const identityFile = resolve(sessionDir, 'id_ed25519')
  const keyPair = sshUtils.generateKeyPairSync('ed25519')

  await mkdir(sessionDir, { recursive: true, mode: 0o700 })
  await chmod(sessionDir, 0o700)
  await writeFile(identityFile, String(keyPair.private), { mode: 0o600 })
  await chmod(identityFile, 0o600)

  return {
    identityFile,
    publicKey: String(keyPair.public),
  }
}

async function writeCliSessionFile(
  args: ParsedArgs,
  config: CliLoginConfig,
  identityFile: string,
  session: CliSshSessionPayload,
  scope: CliSessionScope = 'project',
): Promise<CliSessionFile> {
  const sessionFile: CliSessionFile = {
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    fingerprint: session.fingerprint,
    identityFile,
    project: session.project,
    scopes: session.scopes,
    server: config.server,
    sshCommand: createSshCommand({
      identityFile,
      server: config.server,
      username: session.username,
    }),
    username: session.username,
    viewerOrigin: config.viewerOrigin,
  }
  await writeFile(getCliSessionPath(args, config, scope), `${JSON.stringify(sessionFile, null, 2)}\n`, { mode: 0o600 })
  await chmod(getCliSessionPath(args, config, scope), 0o600)
  return sessionFile
}

function printCliSessionSummary(sessionFile: CliSessionFile): void {
  console.log('Created docs-ssh SSH session')
  console.log(`- server: ${sessionFile.server}`)
  console.log(`- project: ${sessionFile.project}`)
  console.log(`- username: ${sessionFile.username}`)
  console.log(`- expires: ${sessionFile.expiresAt}`)
  console.log(`- identity: ${sessionFile.identityFile}`)
  console.log(`- command: ${sessionFile.sshCommand}`)
}

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform
  if (platform === 'darwin') {
    await execFileAsync('open', [url])
    return
  }
  if (platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', url])
    return
  }
  await execFileAsync('xdg-open', [url])
}

async function readHttpRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function createCliLoginCallback(expectedState: string): Promise<{
  callbackUrl: string
  close: () => Promise<void>
  wait: Promise<{ code: string; request: string }>
}> {
  const callbackServer = createServer()
  let timeout: NodeJS.Timeout | null = null
  let closed = false

  const wait = new Promise<{ code: string; request: string }>((resolveCallback, rejectCallback) => {
    const finish = (error?: Error, result?: { code: string; request: string }) => {
      if (timeout) clearTimeout(timeout)
      if (!closed) {
        closed = true
        callbackServer.close()
      }
      if (error) {
        rejectCallback(error)
        return
      }
      resolveCallback(result!)
    }

    callbackServer.on('request', async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        response.writeHead(404)
        response.end('not found')
        return
      }

      const state = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      const requestId = url.searchParams.get('request')
      if (request.method === 'POST') await readHttpRequestBody(request)

      if (state !== expectedState || !code || !requestId) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><html lang="en"><body><main><h1>Invalid docs-ssh callback</h1></main></body></html>')
        finish(new Error('Invalid docs-ssh callback.'))
        return
      }

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html lang="en"><body><main><h1>docs-ssh CLI authorized</h1><p>You can return to the terminal.</p></main></body></html>')
      finish(undefined, { code, request: requestId })
    })

    callbackServer.once('error', rejectCallback)
    timeout = setTimeout(() => {
      finish(new Error('Timed out waiting for browser login.'))
    }, DEFAULT_CLI_LOGIN_TIMEOUT_MS)
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    callbackServer.once('error', rejectListen)
    callbackServer.listen(0, '127.0.0.1', () => {
      callbackServer.off('error', rejectListen)
      resolveListen()
    })
  })

  const port = (callbackServer.address() as AddressInfo).port
  return {
    callbackUrl: `http://127.0.0.1:${port}/callback`,
    close: () =>
      new Promise((resolveClose) => {
        if (timeout) clearTimeout(timeout)
        if (closed) {
          resolveClose()
          return
        }
        closed = true
        callbackServer.close(() => resolveClose())
      }),
    wait,
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = (await response.json()) as T & { error?: string }
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `Request failed with ${response.status}.`)
  }
  return payload
}

function deriveRepoName(repoUrl: string): string {
  return basename(repoUrl).replace(/\.git$/u, '')
}

async function ensureDirectoryExists(path: string, label: string): Promise<void> {
  const info = await stat(path).catch(() => null)
  if (!info || !info.isDirectory()) {
    throw new Error(`${label} must be an existing directory: ${path}`)
  }
}

function resolveSubdirPath(rootPath: string, subdir?: string): string {
  if (!subdir) return rootPath

  const resolvedPath = resolve(rootPath, subdir)
  const relativePath = relative(rootPath, resolvedPath)

  if (relativePath.startsWith('..') || relativePath === '') {
    throw new Error(`subdir must stay within the source root: ${subdir}`)
  }

  return resolvedPath
}

async function loadWritableRegistry(registryPath: string): Promise<SourceRegistry> {
  const existing = await readSourceRegistry(registryPath)
  return existing ?? createEmptyRegistry()
}

function printIngestSummary(source: SourceSpec, makeDefault: boolean): void {
  console.log(`Ingested source "${source.name}"`)
  console.log(`- type: ${source.type}`)
  console.log(`- root: ${source.rootPath}`)
  if (makeDefault) console.log('- default registry entry: yes')
  if (source.repoUrl) console.log(`- repo: ${source.repoUrl}`)
  if (source.subdir) console.log(`- subdir: ${source.subdir}`)
  console.log('')
  console.log('The source registry was updated for future ingestion workflows.')
}

async function ingestLocalFolder(args: ParsedArgs): Promise<void> {
  const sourcePathArg = args.positionals[2]
  if (!sourcePathArg) throw new Error('Missing required path for local-folder ingest.')

  const sourcePath = resolve(sourcePathArg)
  await ensureDirectoryExists(sourcePath, 'Source path')

  const statePaths = getStatePaths(getFlagString(args, 'state-dir'))
  const registry = await loadWritableRegistry(statePaths.registryPath)
  const name = normalizeSourceName(getFlagString(args, 'name') ?? basename(sourcePath))
  const makeDefault = getFlagBoolean(args, 'default') || registry.sources.length === 0

  const source = createSourceSpec({
    name,
    type: 'local-folder',
    rootPath: makeRootPathPortable(statePaths.registryPath, sourcePath),
  })

  const nextRegistry = addSourceToRegistry(registry, source, { makeDefault })
  await writeSourceRegistry(statePaths.registryPath, nextRegistry)
  printIngestSummary(source, makeDefault)
}

async function ingestGitRepoFromConfig(config: {
  repoUrl: string
  name: string
  subdir?: string
  ref?: string
  makeDefault: boolean
  stateDir?: string
}): Promise<void> {
  const statePaths = getStatePaths(config.stateDir)
  const registry = await loadWritableRegistry(statePaths.registryPath)
  const name = normalizeSourceName(config.name)
  const targetRoot = resolve(statePaths.sourcesDir, name)
  const checkoutRoot = resolve(targetRoot, 'repo')

  if (registry.sources.some((source) => source.name === name)) {
    throw new Error(`Source "${name}" already exists in the registry.`)
  }

  await access(targetRoot).then(
    () => {
      throw new Error(`Managed source directory already exists: ${targetRoot}`)
    },
    () => undefined,
  )

  await mkdir(targetRoot, { recursive: true })

  const cloneArgs = ['clone', '--depth', '1']
  if (config.ref) cloneArgs.push('--branch', config.ref)
  cloneArgs.push(config.repoUrl, checkoutRoot)

  try {
    await execFileAsync('git', cloneArgs)
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr.trim()
        : ''
    throw new Error(stderr ? `git clone failed: ${stderr}` : 'git clone failed.')
  }

  const mountedRoot = resolveSubdirPath(checkoutRoot, config.subdir)
  await ensureDirectoryExists(mountedRoot, 'Mounted repo path')

  const source = createSourceSpec({
    name,
    type: 'git-repo',
    rootPath: makeRootPathPortable(statePaths.registryPath, mountedRoot),
    managed: true,
    repoUrl: config.repoUrl,
    ref: config.ref,
    subdir: config.subdir,
  })

  const nextRegistry = addSourceToRegistry(registry, source, {
    makeDefault: config.makeDefault,
  })
  await writeSourceRegistry(statePaths.registryPath, nextRegistry)
  printIngestSummary(source, config.makeDefault)
}

async function ingestGitRepo(args: ParsedArgs): Promise<void> {
  const repoUrl = args.positionals[2]
  if (!repoUrl) throw new Error('Missing required repo URL for git-repo ingest.')

  const name = getFlagString(args, 'name') ?? deriveRepoName(repoUrl)
  await ingestGitRepoFromConfig({
    repoUrl,
    name,
    ref: getFlagString(args, 'ref'),
    subdir: getFlagString(args, 'subdir'),
    makeDefault: getFlagBoolean(args, 'default'),
    stateDir: getFlagString(args, 'state-dir'),
  })
}

async function ingestPreset(presetName: string, args: ParsedArgs): Promise<void> {
  const preset = getGitRepoPreset(presetName)
  if (!preset) throw new Error(`Unknown ingest target: ${presetName}`)

  await ingestGitRepoFromConfig({
    repoUrl: preset.repoUrl,
    name: getFlagString(args, 'name') ?? preset.name,
    subdir: preset.subdir,
    makeDefault: getFlagBoolean(args, 'default'),
    stateDir: getFlagString(args, 'state-dir'),
  })
}

async function listSources(args: ParsedArgs): Promise<void> {
  const statePaths = getStatePaths(getFlagString(args, 'state-dir'))
  const registry = (await readSourceRegistry(statePaths.registryPath)) ?? createFallbackRegistry(resolve('./docs'))

  console.log(`Registry: ${statePaths.registryPath}`)
  console.log('')

  for (const source of registry.sources) {
    const defaultMark = source.name === registry.defaultSourceName ? ' (default)' : ''
    console.log(`- ${source.name}${defaultMark}`)
    console.log(`  type: ${source.type}`)
    console.log(`  root: ${source.rootPath}`)
  }
}

async function cliLogin(args: ParsedArgs): Promise<void> {
  const config = await resolveCliLoginConfig(args)
  const json = getJsonFlag(args)
  const ttlSeconds = getOptionalIntegerFlag(args, 'ttl-seconds') ?? DEFAULT_CLI_LOGIN_TTL_SECONDS
  const scopes = getFlagString(args, 'scopes')?.split(',')
  const state = randomBytes(24).toString('base64url')
  const callback = await createCliLoginCallback(state)
  const identity = await createCliIdentity(args, config, 'server')

  try {
    const requestPayload = await fetchJson<{
      expiresAt: string
      id: string
      loginUrl: string
    }>(`${config.viewerOrigin}/api/cli-login/requests`, {
      body: JSON.stringify({
        callbackUrl: callback.callbackUrl,
        publicKey: identity.publicKey,
        scopes,
        state,
        ttlSeconds,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })

    if (!json) {
      console.error(`Open this URL to authorize docs-ssh CLI:\n${requestPayload.loginUrl}`)
    }
    if (!getFlagBoolean(args, 'no-open')) {
      await openBrowser(requestPayload.loginUrl)
    }

    const callbackPayload = await callback.wait
    const exchangePayload = await fetchJson<{
      session: CliSshSessionPayload
    }>(`${config.viewerOrigin}/api/cli-login/exchange`, {
      body: JSON.stringify({
        code: callbackPayload.code,
        request: callbackPayload.request,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })

    const sessionFile = await writeCliSessionFile(args, config, identity.identityFile, exchangePayload.session, 'server')

    if (json) {
      console.log(JSON.stringify(sessionFile, null, 2))
      return
    }

    printCliSessionSummary(sessionFile)
  } finally {
    await callback.close()
  }
}

async function cliTokenLogin(args: ParsedArgs): Promise<void> {
  const config = await resolveCliLoginConfig(args)
  const token = getRequiredFlagString(args, 'token')
  const ttlSeconds = getOptionalIntegerFlag(args, 'ttl-seconds') ?? DEFAULT_CLI_LOGIN_TTL_SECONDS
  const identity = await createCliIdentity(args, config)
  const payload = await fetchJson<{
    session: CliSshSessionPayload
  }>(`${config.viewerOrigin}/api/ssh-sessions`, {
    body: JSON.stringify({
      project: config.project,
      publicKey: identity.publicKey,
      ttlSeconds,
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })
  const sessionFile = await writeCliSessionFile(args, config, identity.identityFile, payload.session)

  if (getJsonFlag(args)) {
    console.log(JSON.stringify(sessionFile, null, 2))
    return
  }

  printCliSessionSummary(sessionFile)
}

async function cliStatus(args: ParsedArgs): Promise<void> {
  const config = await resolveCliLoginConfig(args)
  const session = await readCliSession(args, config)
  const active = isCliSessionActive(session)

  if (getJsonFlag(args)) {
    console.log(JSON.stringify({
      active,
      project: config.project,
      server: config.server,
      session,
    }, null, 2))
    return
  }

  if (!session) {
    console.log(`No docs-ssh session for ${config.server}/${config.project}`)
    return
  }

  console.log(active ? 'docs-ssh session is active' : 'docs-ssh session is expired')
  console.log(`- server: ${session.server}`)
  console.log(`- project: ${session.project}`)
  console.log(`- username: ${session.username}`)
  console.log(`- expires: ${session.expiresAt}`)
  console.log(`- command: ${session.sshCommand}`)
}

async function cliLogout(args: ParsedArgs): Promise<void> {
  const config = await resolveCliLoginConfig(args)
  const sessionDirs = new Set([
    getCliSessionDir(args, config, 'server'),
    getCliSessionDir(args, config, 'project'),
  ])
  await Promise.all([...sessionDirs].map((sessionDir) => rm(sessionDir, { force: true, recursive: true })))

  if (getJsonFlag(args)) {
    console.log(JSON.stringify({
      removed: true,
      project: config.project,
      server: config.server,
    }, null, 2))
    return
  }

  console.log(`Removed local docs-ssh session for ${config.server}`)
  console.log('The server-side SSH session will stop working when it expires.')
}

function getAuthDbPath(args: ParsedArgs): string {
  const instanceConfig = loadInstanceConfig({
    stateDir: getFlagString(args, 'state-dir'),
  })
  return resolve(getFlagString(args, 'db-path') ?? instanceConfig.auth.dbPath)
}

async function authInit(args: ParsedArgs): Promise<void> {
  const authStore = createAuthStore({
    dbPath: getAuthDbPath(args),
  })

  try {
    const owner = authStore.ensureSingleTenantOwner({
      instanceName: getFlagString(args, 'tenant-name') ?? getFlagString(args, 'instance-name'),
      instanceSlug: getFlagString(args, 'tenant-slug') ?? getFlagString(args, 'instance-slug'),
      ownerLogin: getFlagString(args, 'owner-login'),
      ownerName: getFlagString(args, 'owner-name'),
    })

    console.log(`Initialized auth database at ${authStore.dbPath}`)
    console.log(`- tenant: ${owner.tenant.slug} (${owner.tenant.displayName})`)
    console.log(`- owner: ${owner.user.login} (${owner.user.displayName})`)
  } finally {
    authStore.close()
  }
}

async function authAddSshKey(args: ParsedArgs): Promise<void> {
  const publicKeyPath = args.positionals[2]
  if (!publicKeyPath) {
    throw new Error('Missing required public key path for auth add-ssh-key.')
  }

  const authStore = createAuthStore({
    dbPath: getAuthDbPath(args),
  })

  try {
    const publicKey = await readFile(resolve(publicKeyPath), 'utf8')
    const sshKey = authStore.addSshKey({
      name: getFlagString(args, 'name') ?? basename(publicKeyPath),
      publicKey,
      userLogin: getFlagString(args, 'user'),
    })
    const user = authStore.findUserBySshFingerprint(sshKey.fingerprint)

    console.log(`Added SSH key for ${user?.login ?? getFlagString(args, 'user') ?? 'owner'}`)
    console.log(`- fingerprint: ${sshKey.fingerprint}`)
    console.log(`- algorithm: ${sshKey.algorithm}`)
    console.log(`- stored as: ${sshKey.name ?? '(unnamed)'}`)
  } finally {
    authStore.close()
  }
}

async function resolveProjectSlugForCommand(args: ParsedArgs): Promise<string | undefined> {
  const explicitProject = getFlagString(args, 'project')
  if (explicitProject) return explicitProject

  const projectConfig = await findProjectConfig()
  return projectConfig?.project
}

function inferProjectWorkspaceLogin(authStore: AuthStore, args: ParsedArgs): string | undefined {
  const explicitUser = getFlagString(args, 'user')
  if (explicitUser) return explicitUser

  const projectManagers = authStore
    .listUsers({ tenantSlug: getFlagString(args, 'tenant-slug') })
    .filter((user) => user.role === 'owner' || user.role === 'admin')
  return projectManagers.length === 1 ? projectManagers[0].login : undefined
}

async function ensureCliProjectWorkspace(
  args: ParsedArgs,
  authStore: AuthStore,
  projectSlug: string,
): Promise<void> {
  const instanceConfig = loadInstanceConfig({
    docsDir: getFlagString(args, 'docs-dir'),
    stateDir: getFlagString(args, 'state-dir'),
    workspaceDir: getFlagString(args, 'workspace-dir'),
  })
  const userLogin = inferProjectWorkspaceLogin(authStore, args)
  const principalSession = userLogin ? authStore.findUserProjectSession(userLogin, projectSlug) : null
  const sourceStore = await loadSourceStore({
    registryPath: instanceConfig.statePaths.registryPath,
    fallbackDocsDir: instanceConfig.docsDir,
    principalId: principalSession?.principal.id,
    projectSlug,
    tenantSlug: principalSession?.tenant.slug ?? getFlagString(args, 'tenant-slug'),
    workspaceDir: instanceConfig.workspaceDir,
  })
  await ensureWorkspaceLayout(sourceStore.tenantRootPath, {
    homeRootPath: sourceStore.homeRootPath,
    projectRootPath: sourceStore.projectRootPath,
    projectSlug: sourceStore.projectSlug,
  })
}

async function projectCreate(args: ParsedArgs): Promise<void> {
  const authStore = createAuthStore({
    dbPath: getAuthDbPath(args),
  })

  try {
    const project = authStore.createProject({
      displayName: getFlagString(args, 'display-name'),
      slug: getRequiredFlagString(args, 'project'),
      tenantSlug: getFlagString(args, 'tenant-slug'),
      userLogin: getFlagString(args, 'user'),
    })
    await ensureCliProjectWorkspace(args, authStore, project.slug)

    console.log('Created project')
    console.log(`- slug: ${project.slug}`)
    console.log(`- name: ${project.displayName}`)
    console.log(`- tenant: ${project.tenantId}`)
  } finally {
    authStore.close()
  }
}

async function projectList(args: ParsedArgs): Promise<void> {
  const authStore = createAuthStore({
    dbPath: getAuthDbPath(args),
  })

  try {
    const projects = authStore.listProjects({
      includeArchived: getFlagBoolean(args, 'all') || getFlagBoolean(args, 'include-archived'),
      tenantSlug: getFlagString(args, 'tenant-slug'),
      userLogin: getFlagString(args, 'user'),
    })

    console.log(`Projects (${projects.length})`)
    for (const project of projects) {
      console.log(`- ${project.slug}`)
      console.log(`  name: ${project.displayName}`)
      console.log(`  tenant: ${project.tenantId}`)
      console.log(`  created: ${project.createdAt}`)
      if (project.archivedAt) console.log(`  archived: ${project.archivedAt}`)
    }
  } finally {
    authStore.close()
  }
}

async function projectUpdate(args: ParsedArgs): Promise<void> {
  const displayName = getFlagString(args, 'display-name')
  if (getFlagString(args, 'new-project') || getFlagString(args, 'new-slug')) {
    throw new Error('Project slugs cannot be changed.')
  }
  if (!displayName) {
    throw new Error('Pass --display-name to update a project.')
  }

  const authStore = createAuthStore({
    dbPath: getAuthDbPath(args),
  })

  try {
    const project = authStore.updateProject({
      displayName,
      slug: getRequiredFlagString(args, 'project'),
      tenantSlug: getFlagString(args, 'tenant-slug'),
      userLogin: getFlagString(args, 'user'),
    })
    await ensureCliProjectWorkspace(args, authStore, project.slug)

    console.log('Updated project')
    console.log(`- slug: ${project.slug}`)
    console.log(`- name: ${project.displayName}`)
    console.log(`- tenant: ${project.tenantId}`)
  } finally {
    authStore.close()
  }
}

async function projectArchive(args: ParsedArgs): Promise<void> {
  const authStore = createAuthStore({
    dbPath: getAuthDbPath(args),
  })

  try {
    const project = authStore.archiveProject({
      slug: getRequiredFlagString(args, 'project'),
      tenantSlug: getFlagString(args, 'tenant-slug'),
      userLogin: getFlagString(args, 'user'),
    })

    console.log('Archived project')
    console.log(`- slug: ${project.slug}`)
    console.log(`- name: ${project.displayName}`)
    console.log(`- tenant: ${project.tenantId}`)
    console.log(`- archived: ${project.archivedAt}`)
  } finally {
    authStore.close()
  }
}

async function authCreateProject(args: ParsedArgs): Promise<void> {
  await projectCreate(args)
}

async function authListProjects(args: ParsedArgs): Promise<void> {
  await projectList(args)
}

async function authCreateSshSession(args: ParsedArgs): Promise<void> {
  const publicKeyPath = args.positionals[2]
  if (!publicKeyPath) throw new Error('Missing required public key path.')

  const authStore = createAuthStore({
    dbPath: getAuthDbPath(args),
  })

  try {
    const session = authStore.createSshSession({
      projectSlug: await resolveProjectSlugForCommand(args),
      publicKey: await readFile(resolve(publicKeyPath), 'utf8'),
      scopes: getFlagString(args, 'scopes')?.split(','),
      tenantSlug: getFlagString(args, 'tenant-slug'),
      ttlSeconds: getOptionalIntegerFlag(args, 'ttl-seconds'),
      userLogin: getFlagString(args, 'user'),
      username: getFlagString(args, 'username'),
    })

    console.log('Created SSH session')
    console.log(`- username: ${session.username}`)
    console.log(`- project: ${session.currentProjectSlug}`)
    console.log(`- fingerprint: ${session.fingerprint}`)
    console.log(`- expires: ${session.expiresAt}`)
    console.log(`- scopes: ${session.scopes.join(',')}`)
  } finally {
    authStore.close()
  }
}

function getSshSessionStatus(session: {
  expiresAt: string
  revokedAt: string | null
}): string {
  if (session.revokedAt) return 'revoked'
  if (Date.parse(session.expiresAt) <= Date.now()) return 'expired'
  return 'active'
}

async function authListSshSessions(args: ParsedArgs): Promise<void> {
  const authStore = createAuthStore({
    dbPath: getAuthDbPath(args),
  })

  try {
    const includeAll = getFlagBoolean(args, 'all')
    const sessions = authStore.listSshSessions({
      includeExpired: includeAll || getFlagBoolean(args, 'include-expired'),
      includeRevoked: includeAll || getFlagBoolean(args, 'include-revoked'),
      tenantSlug: getFlagString(args, 'tenant-slug'),
      userLogin: getFlagString(args, 'user'),
    })

    console.log(`SSH sessions (${sessions.length})`)
    for (const session of sessions) {
      console.log(`- ${session.id}`)
      console.log(`  username: ${session.username}`)
      console.log(`  status: ${getSshSessionStatus(session)}`)
      console.log(`  tenant: ${session.tenantId}`)
      console.log(`  project: ${session.currentProjectSlug}`)
      console.log(`  fingerprint: ${session.fingerprint}`)
      console.log(`  expires: ${session.expiresAt}`)
      if (session.revokedAt) console.log(`  revoked: ${session.revokedAt}`)
      console.log(`  scopes: ${session.scopes.join(',')}`)
    }
  } finally {
    authStore.close()
  }
}

async function authRevokeSshSession(args: ParsedArgs): Promise<void> {
  const identifier = args.positionals[2]
  if (!identifier) throw new Error('Missing required SSH session id or username.')

  const authStore = createAuthStore({
    dbPath: getAuthDbPath(args),
  })

  try {
    const session = authStore.revokeSshSession({
      identifier,
      userLogin: getFlagString(args, 'user'),
    })

    console.log('Revoked SSH session')
    console.log(`- id: ${session.id}`)
    console.log(`- username: ${session.username}`)
    console.log(`- revoked: ${session.revokedAt}`)
  } finally {
    authStore.close()
  }
}

async function authAddWebIdentity(args: ParsedArgs): Promise<void> {
  const authStore = createAuthStore({
    dbPath: getAuthDbPath(args),
  })

  try {
    const identity = authStore.addAuthIdentity({
      email: getFlagString(args, 'email'),
      issuer: getRequiredFlagString(args, 'issuer'),
      provider: getFlagString(args, 'provider'),
      subject: getRequiredFlagString(args, 'subject'),
      userLogin: getFlagString(args, 'user'),
    })
    const user = authStore.findUserByAuthIdentity({
      issuer: identity.issuer,
      provider: identity.provider,
      subject: identity.subject,
    })

    console.log(`Added web identity for ${user?.login ?? getFlagString(args, 'user') ?? 'owner'}`)
    console.log(`- provider: ${identity.provider}`)
    console.log(`- issuer: ${identity.issuer}`)
    console.log(`- subject: ${identity.subject}`)
    if (identity.email) {
      console.log(`- email: ${identity.email}`)
    }
  } finally {
    authStore.close()
  }
}

type HelperTarget = 'agents' | 'setup' | 'skill'

async function loadHelperOptions(args: ParsedArgs) {
  const instanceConfig = loadInstanceConfig({
    docsDir: getFlagString(args, 'docs-dir'),
    docsName: getFlagString(args, 'docs-name'),
    sshConnectHost: getFlagString(args, 'ssh-host'),
    sshConnectPort: getOptionalIntegerFlag(args, 'ssh-port'),
    stateDir: getFlagString(args, 'state-dir'),
    workspaceDir: getFlagString(args, 'workspace-dir'),
  })
  const sourceStore = await loadSourceStore({
    registryPath: instanceConfig.statePaths.registryPath,
    fallbackDocsDir: instanceConfig.docsDir,
    projectSlug: (await findProjectConfig())?.project,
    workspaceDir: instanceConfig.workspaceDir,
  })

  return {
    docsName: instanceConfig.docsName,
    sourceStore,
    sshHost: instanceConfig.ssh.connectHost,
    sshPort: instanceConfig.ssh.connectPort,
  }
}

function renderHelperMarkdown(target: HelperTarget, args: ParsedArgs): Promise<string> {
  return loadHelperOptions(args).then((options) => {
    switch (target) {
      case 'agents':
        return createAgentsMarkdown(options)
      case 'setup':
        return createSetupMarkdown(options)
      case 'skill':
        return createSkillMarkdown(options)
    }
  })
}

async function writeHelperOutput(path: string, content: string, append: boolean): Promise<void> {
  const resolvedPath = resolve(path)
  await mkdir(dirname(resolvedPath), { recursive: true })
  if (append) {
    await appendFile(resolvedPath, content)
    return
  }
  await writeFile(resolvedPath, content)
}

async function outputHelper(target: HelperTarget, args: ParsedArgs): Promise<void> {
  const append = getFlagBoolean(args, 'append')
  const outputPath = getFlagString(args, 'output')
  const content = await renderHelperMarkdown(target, args)

  if (!outputPath) {
    if (append) {
      throw new Error('--append requires --output.')
    }
    process.stdout.write(content)
    return
  }

  await writeHelperOutput(outputPath, content, append)
  const action = append ? 'Appended' : 'Wrote'
  console.log(`${action} ${target} helper to ${resolve(outputPath)}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.positionals.length === 0 || getFlagBoolean(args, 'help')) {
    printUsage()
    return
  }

  const [command, subcommand] = args.positionals

  if (command === 'ingest') {
    if (!subcommand) {
      printUsage()
      return
    }

    if (subcommand === 'local-folder') {
      await ingestLocalFolder(args)
      return
    }

    if (subcommand === 'git-repo') {
      await ingestGitRepo(args)
      return
    }

    await ingestPreset(subcommand, args)
    return
  }

  if (command === 'sources' && subcommand === 'list') {
    await listSources(args)
    return
  }

  if (command === 'projects') {
    if (subcommand === 'list') {
      await projectList(args)
      return
    }

    if (subcommand === 'create') {
      await projectCreate(args)
      return
    }

    if (subcommand === 'update') {
      await projectUpdate(args)
      return
    }

    if (subcommand === 'archive' || subcommand === 'delete') {
      await projectArchive(args)
      return
    }

    printUsage()
    return
  }

  if (command === 'login') {
    await cliLogin(args)
    return
  }

  if (command === 'token') {
    if (subcommand === 'login') {
      await cliTokenLogin(args)
      return
    }

    printUsage()
    return
  }

  if (command === 'status') {
    await cliStatus(args)
    return
  }

  if (command === 'logout') {
    await cliLogout(args)
    return
  }

  if (command === 'auth') {
    if (subcommand === 'init') {
      await authInit(args)
      return
    }

    if (subcommand === 'add-ssh-key') {
      await authAddSshKey(args)
      return
    }

    if (subcommand === 'create-project') {
      await authCreateProject(args)
      return
    }

    if (subcommand === 'list-projects') {
      await authListProjects(args)
      return
    }

    if (subcommand === 'create-ssh-session') {
      await authCreateSshSession(args)
      return
    }

    if (subcommand === 'list-ssh-sessions') {
      await authListSshSessions(args)
      return
    }

    if (subcommand === 'revoke-ssh-session') {
      await authRevokeSshSession(args)
      return
    }

    if (subcommand === 'add-web-identity') {
      await authAddWebIdentity(args)
      return
    }

    printUsage()
    return
  }

  if (command === 'helper') {
    if (subcommand === 'agents' || subcommand === 'setup' || subcommand === 'skill') {
      await outputHelper(subcommand, args)
      return
    }
    printUsage()
    return
  }

  printUsage()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
