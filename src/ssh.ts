/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified to remove hosted-service concerns and serve generic local docs.
 */

import type { AddressInfo } from 'node:net'
import { Chalk } from 'chalk'
import ssh2, { type ServerChannel } from 'ssh2'
import { createBash } from './shell/bash.js'
import { createShellSession } from './shell/session.js'

const { Server } = ssh2

const chalkInstance = new Chalk({ level: 3 })
const blue = chalkInstance.rgb(89, 136, 255)
export interface SSHServerOptions {
  hostKey: Buffer
  host?: string
  port?: number
  idleTimeout?: number
  sessionTimeout?: number
  execTimeout?: number
  docsDir?: string
  docsName?: string
  registryPath?: string
}

function formatPrompt(cwd: string): string {
  return `docs-ssh:${cwd} $ `
}

function createBanner(docsName: string): string {
  return [
    `${blue('docs-ssh')}\r\n`,
    '\r\n',
    `${docsName} is mounted read-only for shell-based exploration.\r\n`,
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

export function createSSHServer(opts: SSHServerOptions) {
  const {
    hostKey,
    host = '127.0.0.1',
    port = 2222,
    idleTimeout = 60_000,
    sessionTimeout = 600_000,
    execTimeout = 10_000,
    docsDir,
    docsName = 'Documentation',
    registryPath,
  } = opts

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
        ctx.accept()
      })

      client.on('ready', () => {
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

            try {
              const { bash } = await createBash({
                docsDir,
                docsName,
                registryPath,
                sshHost: host,
                sshPort: port,
              })
              const result = await bash.exec(execInfo.command, {
                cwd: '/',
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
              registryPath,
              sshHost: host,
              sshPort: port,
            })
            let shellSession: ReturnType<typeof createShellSession> | null = null

            shellSession = createShellSession({
              bash,
              input: channel,
              output: channel,
              terminal: hasPty,
              execTimeout,
              banner: createBanner(docsName),
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
        server.close(() => resolve())
      })
    },
  }
}
