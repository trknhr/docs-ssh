import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ssh2 from 'ssh2'
import { createAuthStore } from './auth/store.js'
import { generateHostKeyPem } from './host-key.js'
import { createSSHServer } from './ssh.js'

const { utils: sshUtils } = ssh2
const HOST_KEY = Buffer.from(generateHostKeyPem())
const tempDirs: string[] = []
const activeClients: ssh2.Client[] = []
const activeServers: Array<ReturnType<typeof createSSHServer>> = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-server-'))
  tempDirs.push(dir)
  return dir
}

async function createTestServer() {
  const tempDir = await createTempDir()
  const docsDir = resolve(tempDir, 'docs')
  const stateDir = resolve(tempDir, 'state')
  const workspaceDir = resolve(tempDir, 'workspace')
  const authDbPath = resolve(stateDir, 'auth.sqlite')
  await mkdir(docsDir, { recursive: true })
  await writeFile(resolve(docsDir, 'README.md'), '# Project Docs\n')

  const authStore = createAuthStore({ dbPath: authDbPath })
  const owner = authStore.ensureSingleTenantOwner({
    ownerLogin: 'alice',
    ownerName: 'Alice Owner',
  })
  const allowedKey = sshUtils.generateKeyPairSync('ed25519')
  authStore.addSshKey({
    publicKey: allowedKey.public,
  })
  authStore.close()

  const server = createSSHServer({
    authDbPath,
    docsDir,
    docsName: 'Project Docs',
    host: '127.0.0.1',
    hostKey: HOST_KEY,
    port: 0,
    registryPath: resolve(stateDir, 'sources.json'),
    sshConnectHost: 'docs-ssh',
    sshConnectPort: 2222,
    workspaceDir,
  })
  activeServers.push(server)

  const port = await server.listen()
  return {
    allowedKey,
    owner,
    port,
  }
}

function connectClient(config: ssh2.ConnectConfig): Promise<ssh2.Client> {
  const client = new ssh2.Client()
  activeClients.push(client)

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      client.end()
      reject(new Error('Timed out while connecting SSH client.'))
    }, 5_000)

    const cleanup = () => {
      clearTimeout(timeout)
      client.off('ready', onReady)
      client.off('error', onError)
      client.off('close', onClose)
    }

    const onReady = () => {
      cleanup()
      resolve(client)
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    const onClose = () => {
      cleanup()
      reject(new Error('SSH connection closed before authentication completed.'))
    }

    client.once('ready', onReady)
    client.once('error', onError)
    client.once('close', onClose)
    client.connect(config)
  })
}

function connectExpectFailure(config: ssh2.ConnectConfig): Promise<Error> {
  const client = new ssh2.Client()
  activeClients.push(client)

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      client.end()
      reject(new Error('Timed out while waiting for SSH auth failure.'))
    }, 5_000)

    const cleanup = () => {
      clearTimeout(timeout)
      client.off('ready', onReady)
      client.off('error', onError)
      client.off('close', onClose)
    }

    const finish = (error: Error) => {
      cleanup()
      client.end()
      resolve(error)
    }

    const onReady = () => {
      cleanup()
      client.end()
      reject(new Error('Expected SSH authentication to fail.'))
    }

    const onError = (error: Error) => finish(error)
    const onClose = () => finish(new Error('SSH authentication failed.'))

    client.once('ready', onReady)
    client.once('error', onError)
    client.once('close', onClose)
    client.connect(config)
  })
}

function execCommand(client: ssh2.Client, command: string): Promise<{
  exitCode: number | null
  stderr: string
  stdout: string
}> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error)
        return
      }

      let stdout = ''
      let stderr = ''
      let exitCode: number | null = null

      stream.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString()
      })
      stream.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString()
      })
      stream.on('exit', (code?: number | null) => {
        exitCode = code ?? null
      })
      stream.on('close', () => {
        resolve({
          exitCode,
          stderr,
          stdout,
        })
      })
    })
  })
}

afterEach(async () => {
  for (const client of activeClients.splice(0)) {
    client.removeAllListeners()
    client.end()
  }
  await Promise.all(activeServers.splice(0).map((server) => server.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe('createSSHServer', () => {
  it('authenticates stored public keys and exposes the authenticated principal in the shell env', async () => {
    const { allowedKey, owner, port } = await createTestServer()
    const client = await connectClient({
      host: '127.0.0.1',
      port,
      privateKey: allowedKey.private,
      username: 'workstation-user',
    })

    const result = await execCommand(
      client,
      'printf \'%s\' "$DOCS_SSH_AUTH_LOGIN|$DOCS_SSH_REQUESTED_USERNAME|$USER|$LOGNAME"',
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(`${owner.user.login}|workstation-user|${owner.user.login}|${owner.user.login}`)
  })

  it('rejects public keys that are not stored in the auth database', async () => {
    const { port } = await createTestServer()
    const unknownKey = sshUtils.generateKeyPairSync('ed25519')

    const error = await connectExpectFailure({
      host: '127.0.0.1',
      port,
      privateKey: unknownKey.private,
      username: 'owner',
    })

    expect(error.message).toMatch(/authentication|configured authentication methods failed/i)
  })

  it('rejects non-publickey authentication methods', async () => {
    const { port } = await createTestServer()

    const passwordError = await connectExpectFailure({
      host: '127.0.0.1',
      password: 'not-allowed',
      port,
      username: 'owner',
    })
    const noneError = await connectExpectFailure({
      authHandler: ['none'],
      host: '127.0.0.1',
      port,
      username: 'owner',
    })

    expect(passwordError.message).toMatch(/authentication|configured authentication methods failed/i)
    expect(noneError.message).toMatch(/authentication|configured authentication methods failed/i)
  })
})
