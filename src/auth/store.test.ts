import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ssh2 from 'ssh2'
import { createAuthStore } from './store.js'

const tempDirs: string[] = []
const { utils: sshUtils } = ssh2

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-auth-store-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe('createAuthStore', () => {
  it('bootstraps a single-tenant owner idempotently', async () => {
    const tempDir = await createTempDir()
    const authStore = createAuthStore({
      dbPath: resolve(tempDir, 'auth.sqlite'),
    })

    const first = authStore.ensureSingleTenantOwner()
    const second = authStore.ensureSingleTenantOwner()

    expect(first.instance.slug).toBe('default')
    expect(first.user.login).toBe('owner')
    expect(first.membership.role).toBe('owner')
    expect(second.instance.id).toBe(first.instance.id)
    expect(second.user.id).toBe(first.user.id)

    authStore.close()
  })

  it('stores ssh keys and web identities against the same owner', async () => {
    const tempDir = await createTempDir()
    const authStore = createAuthStore({
      dbPath: resolve(tempDir, 'auth.sqlite'),
    })
    const owner = authStore.ensureSingleTenantOwner()
    const keys = sshUtils.generateKeyPairSync('ed25519')

    const sshKey = authStore.addSshKey({
      name: 'laptop',
      publicKey: keys.public,
    })
    const identity = authStore.addAuthIdentity({
      email: 'owner@example.com',
      issuer: 'https://accounts.example.com',
      provider: 'oidc',
      subject: 'user-123',
    })

    expect(sshKey.algorithm).toBe('ssh-ed25519')
    expect(sshKey.fingerprint.startsWith('SHA256:')).toBe(true)
    expect(identity.userId).toBe(owner.user.id)
    expect(authStore.findUserBySshFingerprint(sshKey.fingerprint)?.id).toBe(owner.user.id)
    expect(
      authStore.findUserByAuthIdentity({
        issuer: identity.issuer,
        provider: identity.provider,
        subject: identity.subject,
      })?.id,
    ).toBe(owner.user.id)
    expect(authStore.listSshKeys().map((entry) => entry.fingerprint)).toEqual([sshKey.fingerprint])
    expect(authStore.listAuthIdentities().map((entry) => entry.subject)).toEqual(['user-123'])

    authStore.close()
  })

  it('uses the sole owner when the bootstrap login is customized', async () => {
    const tempDir = await createTempDir()
    const authStore = createAuthStore({
      dbPath: resolve(tempDir, 'auth.sqlite'),
    })
    authStore.ensureSingleTenantOwner({
      ownerLogin: 'alice',
      ownerName: 'Alice',
    })
    const keys = sshUtils.generateKeyPairSync('ed25519')

    const sshKey = authStore.addSshKey({
      publicKey: keys.public,
    })
    const identity = authStore.addAuthIdentity({
      issuer: 'https://accounts.example.com',
      subject: 'alice-123',
    })

    expect(authStore.findUserBySshFingerprint(sshKey.fingerprint)?.login).toBe('alice')
    expect(
      authStore.findUserByAuthIdentity({
        issuer: identity.issuer,
        provider: identity.provider,
        subject: identity.subject,
      })?.login,
    ).toBe('alice')

    authStore.close()
  })

  it('rejects duplicate ssh keys across users', async () => {
    const tempDir = await createTempDir()
    const authStore = createAuthStore({
      dbPath: resolve(tempDir, 'auth.sqlite'),
    })
    authStore.ensureSingleTenantOwner()
    authStore.ensureSingleTenantOwner({
      ownerLogin: 'backup-owner',
      ownerName: 'Backup Owner',
    })
    const keys = sshUtils.generateKeyPairSync('ed25519')

    authStore.addSshKey({
      publicKey: keys.public,
    })

    expect(() =>
      authStore.addSshKey({
        publicKey: keys.public,
        userLogin: 'backup-owner',
      }),
    ).toThrow('already linked to another user')

    authStore.close()
  })
})
