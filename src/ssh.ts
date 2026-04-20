/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified to remove hosted-service concerns and serve generic local docs.
 */

import type { AddressInfo } from 'node:net'
import { Chalk } from 'chalk'
import ssh2, { type PublicKeyAuthContext, type ServerChannel } from 'ssh2'
import { createAuthStore, type AuthUser } from './auth/store.js'
import { normalizeSshPublicKey } from './auth/ssh-key.js'
import { createBash } from './shell/bash.js'
import { createShellSession } from './shell/session.js'

const { Server } = ssh2

const chalkInstance = new Chalk({ level: 3 })
const blue = chalkInstance.rgb(89, 136, 255)
const EXEC_STDIN_GRACE_MS = parseInt(process.env.EXEC_STDIN_GRACE_MS ?? '500', 10)
const MAX_EXEC_STDIN_BYTES = parseInt(process.env.MAX_EXEC_STDIN_BYTES ?? `${1024 * 1024}`, 10)
export interface SSHServerOptions {
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
  workspaceDir?: string
}

interface AuthenticatedPrincipal {
  fingerprint: string
  requestedUsername: string
  user: AuthUser
}

function formatPrompt(cwd: string): string {
  return `docs-ssh:${cwd} $ `
}

function createBanner(docsName: string, principal: AuthenticatedPrincipal): string {
  return [
    `${blue('docs-ssh')}\r\n`,
    '\r\n',
    `${docsName} is mounted read-only for shell-based exploration.\r\n`,
    '\r\n',
    `${chalkInstance.dim('Authenticated as:')} ${principal.user.login} (${principal.user.displayName})\r\n`,
    ...(principal.requestedUsername !== principal.user.login
      ? [`${chalkInstance.dim('Requested SSH user:')} ${principal.requestedUsername}\r\n`]
      : []),
    '\r\n',
    `${chalkInstance.dim('Useful paths:')}\r\n`,
    '  /docs\r\n',
    '  /sources/<name>\r\n',
    '  /workspace/README.md\r\n',
    '  /workspace/_policy.json\r\n',
    '\r\n',
    `${chalkInstance.dim('Examples:')}\r\n`,
    '  ls /docs\r\n',
    "  grep -R 'keyword' /docs\r\n",
    '  cat /workspace/README.md\r\n',
    '\r\n',
  ].join('')
}

async function collectExecStdin(
  channel: ServerChannel,
  opts: {
    graceMs?: number
    maxBytes?: number
    waitForEndMs?: number
  } = {},
): Promise<string | undefined> {
  const graceMs = opts.graceMs ?? EXEC_STDIN_GRACE_MS
  const maxBytes = opts.maxBytes ?? MAX_EXEC_STDIN_BYTES
  const waitForEndMs = opts.waitForEndMs ?? 10_000
  const input = channel.stdin ?? channel

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
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('eof', onEnd)
      input.off('close', onClose)
    }

    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(sawData ? Buffer.concat(chunks).toString('utf8') : undefined)
    }

    const fail = (message: string) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(message))
    }

    const onData = (chunk: Buffer | string) => {
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

    input.on('data', onData)
    input.on('end', onEnd)
    input.on('eof', onEnd)
    input.on('close', onClose)
  })
}

function createSessionEnv(principal: AuthenticatedPrincipal): Record<string, string> {
  return {
    DOCS_SSH_AUTH_DISPLAY_NAME: principal.user.displayName,
    DOCS_SSH_AUTH_FINGERPRINT: principal.fingerprint,
    DOCS_SSH_AUTH_LOGIN: principal.user.login,
    DOCS_SSH_AUTH_METHOD: 'publickey',
    DOCS_SSH_AUTH_USER_ID: principal.user.id,
    DOCS_SSH_REQUESTED_USERNAME: principal.requestedUsername,
    LOGNAME: principal.user.login,
    USER: principal.user.login,
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
  const user = authStore.findUserBySshFingerprint(normalizedKey.fingerprint)
  if (!user) return null

  if (ctx.signature && ctx.blob) {
    if (normalizedKey.parsedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
      return null
    }
  } else if (ctx.signature || ctx.blob) {
    return null
  }

  return {
    fingerprint: normalizedKey.fingerprint,
    requestedUsername: ctx.username,
    user,
  }
}

export function createSSHServer(opts: SSHServerOptions) {
  const {
    authDbPath,
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
    workspaceDir,
  } = opts

  const authStore = createAuthStore({
    dbPath: authDbPath,
  })
  const activeClients = new Map<ssh2.Connection, Set<ServerChannel>>()

  const server = new Server(
    {
      ident: `docs-ssh_${process.env.VERSION ?? 'dev'}`,
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
            channel.stdin.on('data', () => resetIdle())

            try {
              const { bash } = await createBash({
                docsDir,
                docsName,
                env: sessionEnv,
                registryPath,
                sshHost: sshConnectHost,
                sshPort: sshConnectPort,
                workspaceDir,
              })
              const stdin = await collectExecStdin(channel, {
                waitForEndMs: execTimeout,
              })
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
              docsDir,
              docsName,
              env: sessionEnv,
              registryPath,
              sshHost: sshConnectHost,
              sshPort: sshConnectPort,
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
          authStore.close()
          resolve()
        })
      })
    },
  }
}
