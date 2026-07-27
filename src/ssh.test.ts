import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import ssh2 from 'ssh2'
import { createAuthStore } from './auth/store.js'
import { createArtifactStore } from './artifacts/store.js'
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
  const artifactDbPath = resolve(stateDir, 'artifacts.sqlite')
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
  const sessionKey = sshUtils.generateKeyPairSync('ed25519')
  authStore.createProject({
    displayName: 'Product Docs',
    slug: 'product-docs',
    userLogin: owner.user.login,
  })
  const sshSession = authStore.createSshSession({
    projectSlug: 'product-docs',
    publicKey: sessionKey.public,
    scopes: ['bootstrap:read', 'project:read'],
    userLogin: owner.user.login,
    username: 'sess_product',
  })
  authStore.close()

  const server = createSSHServer({
    artifactDbPath,
    authDbPath,
    docsDir,
    docsName: 'Project Docs',
    host: '127.0.0.1',
    hostKey: HOST_KEY,
    port: 0,
    registryPath: resolve(stateDir, 'sources.json'),
    sshConnectHost: 'docs-ssh',
    sshConnectPort: 2222,
    viewerOrigin: 'https://docs.example.com',
    workspaceDir,
  })
  activeServers.push(server)

  const port = await server.listen()
  return {
    allowedKey,
    artifactDbPath,
    authDbPath,
    owner,
    port,
    sessionKey,
    sshSession,
    workspaceDir,
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

function execCommandWithInput(client: ssh2.Client, command: string, input: string | Buffer): Promise<{
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

      stream.write(input)
      stream.end()
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
      'printf \'%s\' "$DOCS_SSH_AUTH_LOGIN|$DOCS_SSH_AUTH_PRINCIPAL_KIND|$DOCS_SSH_AUTH_TENANT_SLUG|$DOCS_SSH_REQUESTED_USERNAME|$USER|$LOGNAME"',
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(
      `${owner.user.login}|user|default|workstation-user|${owner.user.login}|${owner.user.login}`,
    )
  })

  it('authenticates scoped SSH sessions and exposes project context', async () => {
    const { port, sessionKey, sshSession } = await createTestServer()
    const client = await connectClient({
      host: '127.0.0.1',
      port,
      privateKey: sessionKey.private,
      username: sshSession.username,
    })

    const result = await execCommand(
      client,
      'printf \'%s\' "$DOCS_SSH_SESSION_ID|$DOCS_SSH_PROJECT_SLUG|$DOCS_SSH_SCOPES" && printf "\\n" && bootstrap --json',
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const newlineIndex = result.stdout.indexOf('\n')
    const envLine = result.stdout.slice(0, newlineIndex)
    const bootstrapJson = result.stdout.slice(newlineIndex + 1)
    expect(envLine).toBe(`${sshSession.id}|product-docs|bootstrap:read,project:read`)
    expect(JSON.parse(bootstrapJson)).toMatchObject({
      project: { slug: 'product-docs' },
      scopes: ['bootstrap:read', 'project:read'],
    })
    const bootstrapPayload = JSON.parse(bootstrapJson) as {
      projects: Array<{ slug: string }>
    }
    expect(bootstrapPayload.projects.map((project) => project.slug).sort()).toEqual([
      'default',
      'product-docs',
    ])

    const crossProject = await execCommand(client, 'ls /projects/default/tasks')
    expect(crossProject.exitCode).toBe(0)
    expect(crossProject.stderr).toBe('')

    await expect(
      connectExpectFailure({
        host: '127.0.0.1',
        port,
        privateKey: sessionKey.private,
        username: 'wrong-session-user',
      }),
    ).resolves.toHaveProperty('message')
  })

  it('checks current project membership for existing SSH sessions', async () => {
    const { authDbPath, owner, port, sessionKey, sshSession } = await createTestServer()
    const client = await connectClient({
      host: '127.0.0.1',
      port,
      privateKey: sessionKey.private,
      username: sshSession.username,
    })

    const beforeRevoke = await execCommand(client, 'ls /projects/product-docs/tasks')
    expect(beforeRevoke.exitCode).toBe(0)
    expect(beforeRevoke.stderr).toBe('')

    const database = new Database(authDbPath)
    database
      .prepare(
        `DELETE FROM project_memberships
         WHERE principal_id = ?
           AND project_id = (
             SELECT id FROM projects WHERE slug = 'product-docs'
           )`,
      )
      .run(owner.principal.id)
    database.close()

    const afterRevoke = await execCommand(client, 'ls /projects/product-docs/tasks')
    expect(afterRevoke.exitCode).not.toBe(0)
  })

  it('checks source API token status for existing SSH sessions', async () => {
    const { authDbPath, port } = await createTestServer()
    const tokenSessionKey = sshUtils.generateKeyPairSync('ed25519')
    const authStore = createAuthStore({ dbPath: authDbPath })
    const apiToken = authStore.createApiToken({
      label: 'agent token',
      projectSlug: 'product-docs',
      scopes: ['bootstrap:read', 'project:read', 'ssh-session:create'],
      userLogin: 'alice',
    })
    const apiSshSession = authStore.createSshSession({
      projectSlug: 'product-docs',
      publicKey: tokenSessionKey.public,
      scopes: apiToken.scopes,
      sourceApiTokenId: apiToken.id,
      userLogin: 'alice',
      username: 'sess_token',
    })
    authStore.close()

    const client = await connectClient({
      host: '127.0.0.1',
      port,
      privateKey: tokenSessionKey.private,
      username: apiSshSession.username,
    })

    const beforeRevoke = await execCommand(client, 'ls /projects/product-docs/tasks')
    expect(beforeRevoke.exitCode).toBe(0)
    expect(beforeRevoke.stderr).toBe('')

    const revokeStore = createAuthStore({ dbPath: authDbPath })
    revokeStore.revokeApiToken({
      id: apiToken.id,
      userLogin: 'alice',
    })
    revokeStore.close()

    const afterRevoke = await execCommand(client, 'ls /projects/product-docs/tasks')
    expect(afterRevoke.exitCode).not.toBe(0)
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

  it('runs multiple commands through batch over one SSH exec', async () => {
    const { allowedKey, port } = await createTestServer()
    const client = await connectClient({
      host: '127.0.0.1',
      port,
      privateKey: allowedKey.private,
      username: 'workstation-user',
    })

    const result = await execCommandWithInput(
      client,
      'batch',
      [
        'printf one',
        'read-range -n /README.md 1 2',
        'find /projects/default -maxdepth 1 -type d | sort',
        '',
      ].join('\n'),
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as {
      command: string
      exitCode: number
      stderr: string
      stdout: string
    })
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      command: 'printf one',
      exitCode: 0,
      stdout: 'one',
    })
    expect(rows[1]).toMatchObject({
      command: 'read-range -n /README.md 1 2',
      exitCode: 0,
      stdout: expect.stringContaining('1:# docs-ssh'),
    })
    expect(rows[2]).toMatchObject({
      command: 'find /projects/default -maxdepth 1 -type d | sort',
      exitCode: 0,
      stdout: expect.stringContaining('/projects/default/tasks'),
    })
  })

  it('publishes versioned HTML artifacts over SSH', async () => {
    const { allowedKey, artifactDbPath, port, workspaceDir } = await createTestServer()
    const artifactPath = resolve(
      workspaceDir,
      'tenants/default/projects/product-docs/tasks/demo/artifacts/index.html',
    )
    await mkdir(resolve(artifactPath, '..'), { recursive: true })
    await writeFile(artifactPath, '<!doctype html><title>SSH artifact</title>')
    const client = await connectClient({
      host: '127.0.0.1',
      port,
      privateKey: allowedKey.private,
      username: 'workstation-user',
    })

    const result = await execCommand(
      client,
      'artifact publish /projects/product-docs/tasks/demo/artifacts/index.html --share project --json',
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const payload = JSON.parse(result.stdout) as {
      artifact: {
        latestVersion: number
        publicId: string
        url: string
        visibility: string
      }
    }
    expect(payload.artifact).toMatchObject({
      latestVersion: 1,
      url: expect.stringMatching(/^https:\/\/docs\.example\.com\/artifacts\//u),
      visibility: 'project',
    })

    const artifactStore = createArtifactStore({ dbPath: artifactDbPath })
    expect(artifactStore.getArtifactContent(payload.artifact.publicId)?.content).toContain('SSH artifact')
    artifactStore.close()
  })
})
