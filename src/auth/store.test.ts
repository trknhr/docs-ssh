import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
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

    expect(first.tenant.slug).toBe('default')
    expect(first.instance.id).toBe(first.tenant.id)
    expect(first.principal.kind).toBe('user')
    expect(first.user.principalId).toBe(first.principal.id)
    expect(first.user.login).toBe('owner')
    expect(first.membership.role).toBe('owner')
    expect(first.membership.tenantId).toBe(first.tenant.id)
    expect(first.membership.principalId).toBe(first.principal.id)
    expect(second.tenant.id).toBe(first.tenant.id)
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
    expect(sshKey.principalId).toBe(owner.principal.id)
    expect(sshKey.userId).toBe(owner.user.id)
    expect(identity.principalId).toBe(owner.principal.id)
    expect(identity.userId).toBe(owner.user.id)
    expect(authStore.findUserBySshFingerprint(sshKey.fingerprint)?.id).toBe(owner.user.id)
    expect(authStore.findPrincipalBySshFingerprint(sshKey.fingerprint)).toMatchObject({
      login: 'owner',
      principal: { id: owner.principal.id, kind: 'user' },
      tenant: { id: owner.tenant.id, slug: 'default' },
    })
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

  it('migrates legacy instance-scoped auth databases to tenant and principal scope', async () => {
    const tempDir = await createTempDir()
    const dbPath = resolve(tempDir, 'auth.sqlite')
    const database = new Database(dbPath)
    database.exec(`
      CREATE TABLE instances (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE memberships (
        instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (instance_id, user_id)
      );

      CREATE TABLE auth_identities (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        email TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (provider, issuer, subject)
      );

      CREATE TABLE ssh_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT,
        algorithm TEXT NOT NULL,
        public_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      INSERT INTO instances (id, slug, display_name, created_at)
      VALUES ('tenant-1', 'legacy', 'Legacy Tenant', '2026-04-01T00:00:00.000Z');
      INSERT INTO users (id, login, display_name, created_at)
      VALUES ('user-1', 'legacy-owner', 'Legacy Owner', '2026-04-01T00:00:00.000Z');
      INSERT INTO memberships (instance_id, user_id, role, created_at)
      VALUES ('tenant-1', 'user-1', 'owner', '2026-04-01T00:00:00.000Z');
      INSERT INTO auth_identities (id, user_id, provider, issuer, subject, email, created_at)
      VALUES ('identity-1', 'user-1', 'oidc', 'https://accounts.example.com', 'legacy-sub', 'legacy@example.com', '2026-04-01T00:00:00.000Z');
      PRAGMA user_version = 1;
    `)
    database.close()

    const authStore = createAuthStore({ dbPath })
    const user = authStore.findUserByLogin('legacy-owner')
    const identityUser = authStore.findUserByAuthIdentity({
      issuer: 'https://accounts.example.com',
      provider: 'oidc',
      subject: 'legacy-sub',
    })
    const keys = sshUtils.generateKeyPairSync('ed25519')
    const sshKey = authStore.addSshKey({
      publicKey: keys.public,
      userLogin: 'legacy-owner',
    })

    expect(user?.principalId).toBe('user-1')
    expect(identityUser?.id).toBe('user-1')
    expect(sshKey.principalId).toBe('user-1')
    expect(authStore.findPrincipalBySshFingerprint(sshKey.fingerprint)).toMatchObject({
      login: 'legacy-owner',
      tenant: { slug: 'legacy' },
    })
    authStore.close()

    const migratedDatabase = new Database(dbPath)
    expect(migratedDatabase.pragma('user_version', { simple: true })).toBe(2)
    expect(
      migratedDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenants'").get(),
    ).toBeTruthy()
    migratedDatabase.close()
  })

  it('can sign up the first web user into an empty auth store', async () => {
    const tempDir = await createTempDir()
    const authStore = createAuthStore({
      dbPath: resolve(tempDir, 'auth.sqlite'),
    })

    const signedUp = authStore.signUpFirstUserWithAuthIdentity({
      email: 'first.owner@example.com',
      issuer: 'https://accounts.example.com',
      ownerLogin: 'first-owner',
      ownerName: 'First Owner',
      provider: 'google',
      subject: 'google-sub-123',
    })

    expect(signedUp?.owner.user.login).toBe('first-owner')
    expect(signedUp?.owner.membership.role).toBe('owner')
    expect(signedUp?.identity.provider).toBe('google')
    expect(
      authStore.findUserByAuthIdentity({
        issuer: 'https://accounts.example.com',
        provider: 'google',
        subject: 'google-sub-123',
      })?.login,
    ).toBe('first-owner')

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
