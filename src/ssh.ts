/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified to remove hosted-service concerns and serve generic local docs.
 */

import type { AddressInfo } from 'node:net'
import { dirname, posix, resolve } from 'node:path'
import { Chalk } from 'chalk'
import ssh2, { type PublicKeyAuthContext, type ServerChannel } from 'ssh2'
import {
  createArtifactStore,
  type ArtifactStore,
} from './artifacts/store.js'
import type { ArtifactCommandService } from './artifacts/command.js'
import { createAuthStore, type AuthPrincipalSession } from './auth/store.js'
import { normalizeSshPublicKey } from './auth/ssh-key.js'
import { createBash } from './shell/bash.js'
import { createShellSession } from './shell/session.js'

const { Server } = ssh2

const chalkInstance = new Chalk({ level: 3 })
const blue = chalkInstance.rgb(89, 136, 255)
export interface SSHServerOptions {
  artifactDbPath?: string
  authDbPath: string
  hostKey: Buffer
  host?: string
  port?: number
  idleTimeout?: number
  sessionTimeout?: number
  execTimeout?: number
  docsDir?: string
  docsName?: string
  registryPath?: string
  sshConnectHost?: string
  sshConnectPort?: number
  viewerOrigin?: string
  workspaceDir?: string
}

interface AuthenticatedPrincipal {
  auth: AuthPrincipalSession
  fingerprint: string
  requestedUsername: string
}

function getExecStdinGraceMs(): number {
  return parseInt(process.env.EXEC_STDIN_GRACE_MS ?? '500', 10)
}

function getMaxExecStdinBytes(): number {
  return parseInt(process.env.MAX_EXEC_STDIN_BYTES ?? `${1024 * 1024}`, 10)
}

function getServerIdent(): string {
  return `docs-ssh_${process.env.VERSION ?? 'dev'}`
}

function formatPrompt(cwd: string): string {
  return `docs-ssh:${cwd} $ `
}

function createBanner(docsName: string, principal: AuthenticatedPrincipal): string {
  const projectPath = `/projects/${principal.auth.project.slug}`

  return [
    `${blue('docs-ssh')}\r\n`,
    '\r\n',
    `${docsName} is available through the current project filesystem.\r\n`,
    '\r\n',
    `${chalkInstance.dim('Authenticated as:')} ${principal.auth.login} (${principal.auth.displayName})\r\n`,
    `${chalkInstance.dim('Tenant:')} ${principal.auth.tenant.slug}\r\n`,
    `${chalkInstance.dim('Project:')} ${principal.auth.project.slug}\r\n`,
    ...(principal.requestedUsername !== principal.auth.login
      ? [`${chalkInstance.dim('Requested SSH user:')} ${principal.requestedUsername}\r\n`]
      : []),
    '\r\n',
    `${chalkInstance.dim('Useful paths:')}\r\n`,
    '  /README.md\r\n',
    '  /home\r\n',
    `  ${projectPath}/issues\r\n`,
    `  ${projectPath}/tasks\r\n`,
    '\r\n',
    `${chalkInstance.dim('Examples:')}\r\n`,
    '  cat /README.md\r\n',
    `  ls ${projectPath}/issues\r\n`,
    `  mkdir -p ${projectPath}/tasks/example-task\r\n`,
    '\r\n',
  ].join('')
}

async function collectExecStdin(
  channel: ServerChannel,
  opts: {
    encoding?: BufferEncoding
    graceMs?: number
    maxBytes?: number
    onActivity?: () => void
    waitForEndMs?: number
  } = {},
): Promise<string | undefined> {
  const encoding = opts.encoding ?? 'utf8'
  const graceMs = opts.graceMs ?? getExecStdinGraceMs()
  const maxBytes = opts.maxBytes ?? getMaxExecStdinBytes()
  const waitForEndMs = opts.waitForEndMs ?? 10_000
  const inputs = channel.stdin && channel.stdin !== channel
    ? [channel.stdin, channel]
    : [channel]

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let sawData = false
    let settled = false
    let graceTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => finish(), graceMs)
    let endTimer: ReturnType<typeof setTimeout> | null = null

    const clearTimers = () => {
      if (graceTimer) clearTimeout(graceTimer)
      if (endTimer) clearTimeout(endTimer)
      graceTimer = null
      endTimer = null
    }

    const cleanup = () => {
      clearTimers()
      for (const input of inputs) {
        input.off('data', onData)
        input.off('end', onEnd)
        input.off('eof', onEnd)
        input.off('close', onClose)
      }
    }

    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(sawData ? Buffer.concat(chunks).toString(encoding) : undefined)
    }

    const fail = (message: string) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(message))
    }

    const onData = (chunk: Buffer | string) => {
      opts.onActivity?.()
      sawData = true
      if (graceTimer) {
        clearTimeout(graceTimer)
        graceTimer = null
      }

      if (endTimer) clearTimeout(endTimer)
      endTimer = setTimeout(() => fail('Timed out while reading stdin.'), waitForEndMs)

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buffer.length
      if (totalBytes > maxBytes) {
        fail(`stdin exceeded ${maxBytes} bytes.`)
        return
      }

      chunks.push(buffer)
    }

    const onEnd = () => finish()
    const onClose = () => finish()

    for (const input of inputs) {
      input.on('data', onData)
      input.on('end', onEnd)
      input.on('eof', onEnd)
      input.on('close', onClose)
    }
  })
}

function getExecStdinEncoding(command: string): BufferEncoding {
  // just-bash binary stdin consumers reconstruct bytes from charCodeAt().
  if (/^\s*(?:base64|gzip|gunzip|tar|zcat)(?:$|[\s;&|()])/.test(command)) {
    return 'latin1'
  }

  return 'utf8'
}

function createSessionEnv(principal: AuthenticatedPrincipal): Record<string, string> {
  return {
    DOCS_SSH_AUTH_DISPLAY_NAME: principal.auth.displayName,
    DOCS_SSH_AUTH_FINGERPRINT: principal.fingerprint,
    DOCS_SSH_AUTH_LOGIN: principal.auth.login,
    DOCS_SSH_AUTH_METHOD: 'publickey',
    DOCS_SSH_AUTH_PRINCIPAL_ID: principal.auth.principal.id,
    DOCS_SSH_AUTH_PRINCIPAL_KIND: principal.auth.principal.kind,
    DOCS_SSH_AUTH_TENANT_ID: principal.auth.tenant.id,
    DOCS_SSH_AUTH_TENANT_SLUG: principal.auth.tenant.slug,
    DOCS_SSH_AUTH_USER_ID: principal.auth.user?.id ?? '',
    DOCS_SSH_PROJECT_ID: principal.auth.project.id,
    DOCS_SSH_PROJECT_ROLE: principal.auth.projectMembership.role,
    DOCS_SSH_PROJECT_SLUG: principal.auth.project.slug,
    DOCS_SSH_REQUESTED_USERNAME: principal.requestedUsername,
    DOCS_SSH_SCOPES: principal.auth.scopes.join(','),
    DOCS_SSH_SESSION_ID: principal.auth.sshSession?.id ?? '',
    LOGNAME: principal.auth.login,
    USER: principal.auth.login,
  }
}

function getProjectSlugFromPath(path: string): string | null {
  const normalized = posix.normalize(path.startsWith('/') ? path : `/${path}`)
  const match = /^\/projects\/([^/]+)(?:\/|$)/u.exec(normalized)
  return match ? match[1] : null
}

function createSshAccessGuard(
  authStore: ReturnType<typeof createAuthStore>,
  principal: AuthenticatedPrincipal,
) {
  return async (path: string, operation: 'read' | 'write') => {
    const projectSlug = getProjectSlugFromPath(path)
    if (!projectSlug) return

    const result = authStore.authorizeSshProjectAccess({
      operation,
      principalId: principal.auth.principal.id,
      projectSlug,
      scopes: principal.auth.scopes,
      sshSessionId: principal.auth.sshSession?.id,
      tenantId: principal.auth.tenant.id,
    })
    if (!result.allowed) {
      throw new Error(`EACCES: ${result.reason ?? `Project access denied for "${projectSlug}".`}`)
    }
  }
}

function createBashSessionContext(
  principal: AuthenticatedPrincipal,
  authStore: ReturnType<typeof createAuthStore>,
) {
  const accessibleProjects = (() => {
    if (!principal.auth.sshSession?.sourceApiTokenId) {
      return authStore.listPrincipalProjects({
        principalId: principal.auth.principal.id,
        tenantId: principal.auth.tenant.id,
      })
    }

    const result = authStore.authorizeSshProjectAccess({
      operation: 'read',
      principalId: principal.auth.principal.id,
      projectSlug: principal.auth.project.slug,
      sshSessionId: principal.auth.sshSession.id,
      tenantId: principal.auth.tenant.id,
    })
    return result.allowed ? [principal.auth.project] : []
  })().map((project) => ({
    displayName: project.displayName,
    slug: project.slug,
  }))

  return {
    accessibleProjects,
    displayName: principal.auth.displayName,
    login: principal.auth.login,
    principalId: principal.auth.principal.id,
    principalKind: principal.auth.principal.kind,
    projectSlug: principal.auth.project.slug,
    scopes: principal.auth.scopes,
    tenantId: principal.auth.tenant.id,
    tenantSlug: principal.auth.tenant.slug,
  }
}

function createSshArtifactService(
  authStore: ReturnType<typeof createAuthStore>,
  artifactStore: ArtifactStore,
  principal: AuthenticatedPrincipal,
): ArtifactCommandService {
  const requireProject = (projectSlug: string, operation: 'read' | 'write') => {
    const access = authStore.authorizeSshProjectAccess({
      operation,
      principalId: principal.auth.principal.id,
      projectSlug,
      scopes: principal.auth.scopes,
      sshSessionId: principal.auth.sshSession?.id,
      tenantId: principal.auth.tenant.id,
    })
    if (!access.allowed) {
      throw new Error(`EACCES: ${access.reason ?? `Project access denied for "${projectSlug}".`}`)
    }

    const project = authStore
      .listPrincipalProjects({
        principalId: principal.auth.principal.id,
        tenantId: principal.auth.tenant.id,
      })
      .find((entry) => entry.slug === projectSlug)
    if (!project) throw new Error(`Project "${projectSlug}" was not found.`)
    return project
  }

  const requireArtifact = (publicId: string, operation: 'read' | 'write') => {
    const artifact = artifactStore.getArtifact(publicId)
    if (!artifact || artifact.tenantId !== principal.auth.tenant.id) {
      throw new Error(`Artifact "${publicId}" was not found.`)
    }
    requireProject(artifact.projectSlug, operation)
    if (
      artifact.visibility === 'private'
      && artifact.creatorPrincipalId !== principal.auth.principal.id
    ) {
      throw new Error(`Artifact "${publicId}" was not found.`)
    }
    return artifact
  }

  return {
    getArtifact(publicId) {
      return requireArtifact(publicId, 'read')
    },
    listArtifacts(projectSlug) {
      const project = requireProject(projectSlug, 'read')
      return artifactStore.listArtifacts({
        principalId: principal.auth.principal.id,
        projectId: project.id,
        tenantId: principal.auth.tenant.id,
      })
    },
    publishArtifact(input) {
      const project = requireProject(input.projectSlug, 'write')
      return artifactStore.publishArtifact({
        ...input,
        creatorDisplayName: principal.auth.displayName,
        creatorLogin: principal.auth.login,
        creatorPrincipalId: principal.auth.principal.id,
        projectDisplayName: project.displayName,
        projectId: project.id,
        projectPublicId: project.publicId,
        tenantId: principal.auth.tenant.id,
        tenantPublicId: principal.auth.tenant.publicId,
      }).artifact
    },
    updateArtifactVisibility(publicId, visibility) {
      const artifact = requireArtifact(publicId, 'write')
      if (artifact.creatorPrincipalId !== principal.auth.principal.id) {
        throw new Error('Only the artifact creator can change its visibility.')
      }
      return artifactStore.updateArtifactVisibility({
        principalId: principal.auth.principal.id,
        publicId,
        visibility,
      })
    },
  }
}

function authenticateWithPublicKey(
  ctx: PublicKeyAuthContext,
  authStore: ReturnType<typeof createAuthStore>,
): AuthenticatedPrincipal | null {
  const normalizedKey = normalizeSshPublicKey({
    algo: ctx.key.algo,
    data: ctx.key.data,
  })
  const auth = authStore.findPrincipalBySshFingerprint(normalizedKey.fingerprint, ctx.username)
  if (!auth) return null

  if (ctx.signature && ctx.blob) {
    if (normalizedKey.parsedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
      return null
    }
  } else if (ctx.signature || ctx.blob) {
    return null
  }

  return {
    auth,
    fingerprint: normalizedKey.fingerprint,
    requestedUsername: ctx.username,
  }
}

export function createSSHServer(opts: SSHServerOptions) {
  const {
    authDbPath,
    artifactDbPath = resolve(dirname(authDbPath), 'artifacts.sqlite'),
    hostKey,
    host = '127.0.0.1',
    port = 2222,
    idleTimeout = 60_000,
    sessionTimeout = 600_000,
    execTimeout = 10_000,
    docsDir,
    docsName = 'Documentation',
    registryPath,
    sshConnectHost = '127.0.0.1',
    sshConnectPort = 2222,
    viewerOrigin,
    workspaceDir,
  } = opts

  const authStore = createAuthStore({
    dbPath: authDbPath,
  })
  const artifactStore = createArtifactStore({
    dbPath: artifactDbPath,
  })
  const activeClients = new Map<ssh2.Connection, Set<ServerChannel>>()

  const server = new Server(
    {
      ident: getServerIdent(),
      hostKeys: [hostKey],
    },
    (client) => {
      const channels = new Set<ServerChannel>()
      activeClients.set(client, channels)

      let activeChannel: ServerChannel | null = null
      let authenticatedPrincipal: AuthenticatedPrincipal | null = null

      const endSession = (reason: string) => {
        if (activeChannel) {
          activeChannel.write(`\r\n\r\n${reason}\r\n\r\n`)
        }
        setTimeout(() => client.end(), 250)
      }

      const idleTimer = setTimeout(() => endSession('Session timed out due to inactivity.'), idleTimeout)
      const sessionTimer = setTimeout(() => endSession('Session reached the maximum duration.'), sessionTimeout)
      const resetIdle = () => idleTimer.refresh()

      client.on('authentication', (ctx) => {
        if (ctx.method !== 'publickey') {
          ctx.reject(['publickey'])
          return
        }

        try {
          const principal = authenticateWithPublicKey(ctx, authStore)
          if (!principal) {
            ctx.reject(['publickey'])
            return
          }

          authenticatedPrincipal = principal
          ctx.accept()
        } catch {
          ctx.reject(['publickey'])
        }
      })

      client.on('ready', () => {
        if (!authenticatedPrincipal) {
          client.end()
          return
        }

        const principal = authenticatedPrincipal
        const sessionEnv = createSessionEnv(principal)
        const accessGuard = createSshAccessGuard(authStore, principal)
        const artifactService = createSshArtifactService(authStore, artifactStore, principal)

        client.on('session', (accept) => {
          const session = accept()

          let hasPty = false
          session.on('pty', (acceptPty) => {
            hasPty = true
            acceptPty()
          })

          session.on('exec', async (acceptExec, _reject, execInfo) => {
            resetIdle()
            const channel = acceptExec()
            channels.add(channel)
            channel.on('close', () => channels.delete(channel))
            const stdinPromise = collectExecStdin(channel, {
              encoding: getExecStdinEncoding(execInfo.command),
              onActivity: resetIdle,
              waitForEndMs: execTimeout,
            })

            try {
              const { bash } = await createBash({
                artifactService,
                docsDir,
                docsName,
                env: sessionEnv,
                accessGuard,
                registryPath,
                session: createBashSessionContext(principal, authStore),
                sshHost: sshConnectHost,
                sshPort: sshConnectPort,
                viewerOrigin,
                workspaceDir,
              })
              const stdin = await stdinPromise
              const result = await bash.exec(execInfo.command, {
                cwd: '/',
                stdin,
                signal: AbortSignal.timeout(execTimeout),
              })

              if (result.stdout) channel.write(result.stdout)
              if (result.stderr) channel.stderr.write(result.stderr)
              channel.exit(result.exitCode ?? 0)
            } catch (error) {
              channel.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
              channel.exit(1)
            }

            channel.end()
          })

          session.on('shell', async (acceptShell) => {
            const channel = acceptShell()
            activeChannel = channel
            channels.add(channel)
            channel.on('close', () => channels.delete(channel))
            channel.on('data', () => resetIdle())

            const { bash } = await createBash({
              artifactService,
              docsDir,
              docsName,
              env: sessionEnv,
              accessGuard,
              registryPath,
              session: createBashSessionContext(principal, authStore),
              sshHost: sshConnectHost,
              sshPort: sshConnectPort,
              viewerOrigin,
              workspaceDir,
            })
            let shellSession: ReturnType<typeof createShellSession> | null = null

            shellSession = createShellSession({
              bash,
              input: channel,
              output: channel,
              terminal: hasPty,
              execTimeout,
              banner: createBanner(docsName, principal),
              prompt: formatPrompt,
              beforeExec: (command) => {
                if (command === 'exit') {
                  shellSession?.close()
                  channel.end()
                  return false
                }
              },
              onExit: () => channel.end(),
            })
          })
        })
      })

      client.on('end', () => {
        clearTimeout(idleTimer)
        clearTimeout(sessionTimer)
        activeClients.delete(client)
      })

      client.on('error', (error) => {
        console.error('Client error:', error.message)
      })
    },
  )

  return {
    get activeConnectionCount() {
      return activeClients.size
    },

    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        const handleError = (error: Error) => {
          server.off('listening', handleListening)
          reject(error)
        }

        const handleListening = () => {
          server.off('error', handleError)
          const address = server.address() as AddressInfo
          console.log(`SSH server listening on ${host}:${address.port}`)
          console.log(`Connect: ssh ${host} -p ${address.port}`)
          resolve(address.port)
        }

        server.once('error', handleError)
        server.once('listening', handleListening)
        server.listen(port, host)
      })
    },

    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const client of activeClients.keys()) {
          client.end()
        }
        server.close(() => {
          artifactStore.close()
          authStore.close()
          resolve()
        })
      })
    },
  }
}
