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
    const principalSession = authStore.findPrincipalBySshFingerprint(sshKey.fingerprint)
    expect(principalSession).toMatchObject({
      login: 'owner',
      principal: { id: owner.principal.id, kind: 'user' },
      tenant: { id: owner.tenant.id, slug: 'default' },
    })
    expect(principalSession?.scopes).toContain('project:write')
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
    expect(migratedDatabase.pragma('user_version', { simple: true })).toBe(5)
    expect(
      migratedDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenants'").get(),
    ).toBeTruthy()
    expect(
      migratedDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_memberships'").get(),
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

  it('adds tenant users with web identities and project access', async () => {
    const tempDir = await createTempDir()
    const authStore = createAuthStore({
      dbPath: resolve(tempDir, 'auth.sqlite'),
    })
    authStore.ensureSingleTenantOwner({
      ownerLogin: 'alice',
      ownerName: 'Alice',
    })
    authStore.createProject({
      displayName: 'Product Docs',
      slug: 'product-docs',
      userLogin: 'alice',
    })

    const user = authStore.addUser({
      displayName: 'Bob Member',
      identity: {
        email: 'bob@example.com',
        issuer: 'https://accounts.example.com',
        provider: 'google',
        subject: 'bob-google-sub',
      },
      login: 'bob',
    })

    expect(user).toMatchObject({
      displayName: 'Bob Member',
      login: 'bob',
      role: 'member',
    })
    expect(user.identities).toEqual([
      expect.objectContaining({
        email: 'bob@example.com',
        issuer: 'https://accounts.example.com',
        provider: 'google',
        subject: 'bob-google-sub',
      }),
    ])
    expect(authStore.listUsers().map((entry) => [entry.login, entry.role])).toEqual([
      ['alice', 'owner'],
      ['bob', 'member'],
    ])
    expect(
      authStore.findUserByAuthIdentity({
        issuer: 'https://accounts.example.com',
        provider: 'google',
        subject: 'bob-google-sub',
      })?.login,
    ).toBe('bob')
    expect(authStore.listProjects({ userLogin: 'bob' }).map((entry) => entry.slug)).toEqual([
      'default',
      'product-docs',
    ])

    authStore.close()
  })

  it('updates and archives projects without allowing slug changes', async () => {
    const tempDir = await createTempDir()
    const authStore = createAuthStore({
      dbPath: resolve(tempDir, 'auth.sqlite'),
    })
    authStore.ensureSingleTenantOwner({
      ownerLogin: 'alice',
      ownerName: 'Alice',
    })
    authStore.createProject({
      displayName: 'Product Docs',
      slug: 'product-docs',
      userLogin: 'alice',
    })

    const updated = authStore.updateProject({
      displayName: 'Product Knowledge',
      slug: 'product-docs',
      userLogin: 'alice',
    })
    expect(updated).toMatchObject({
      archivedAt: null,
      displayName: 'Product Knowledge',
      slug: 'product-docs',
    })
    expect(authStore.listProjects({ userLogin: 'alice' }).map((entry) => entry.slug)).toEqual([
      'default',
      'product-docs',
    ])
    expect(() =>
      authStore.updateProject({
        newSlug: 'product-knowledge',
        slug: 'product-docs',
        userLogin: 'alice',
      }),
    ).toThrow(/Project slugs cannot be changed/)

    const keys = sshUtils.generateKeyPairSync('ed25519')
    const session = authStore.createSshSession({
      projectSlug: 'product-docs',
      publicKey: keys.public,
      ttlSeconds: 60,
      userLogin: 'alice',
      username: 'sess_project_crud',
    })

    expect(() =>
      authStore.updateProject({
        newSlug: 'project-v2',
        slug: 'product-docs',
        userLogin: 'alice',
      }),
    ).toThrow(/Project slugs cannot be changed/)
    expect(() =>
      authStore.archiveProject({
        slug: 'product-docs',
        userLogin: 'alice',
      }),
    ).toThrow(/active SSH sessions/)

    authStore.revokeSshSession({
      identifier: session.username,
      userLogin: 'alice',
    })
    const archived = authStore.archiveProject({
      slug: 'product-docs',
      userLogin: 'alice',
    })
    expect(archived.archivedAt).toEqual(expect.any(String))
    expect(authStore.listProjects({ userLogin: 'alice' }).map((entry) => entry.slug)).toEqual(['default'])
    expect(authStore.listProjects({ includeArchived: true, userLogin: 'alice' }).map((entry) => entry.slug)).toEqual([
      'default',
      'product-docs',
    ])
    expect(() =>
      authStore.createSshSession({
        projectSlug: 'product-docs',
        publicKey: keys.public,
        ttlSeconds: 60,
        userLogin: 'alice',
      }),
    ).toThrow(/Project "product-docs" was not found/)
    expect(() =>
      authStore.archiveProject({
        slug: 'default',
        userLogin: 'alice',
      }),
    ).toThrow(/default project cannot be archived/)

    authStore.close()
  })

  it('creates scoped SSH sessions with project context', async () => {
    const tempDir = await createTempDir()
    const authStore = createAuthStore({
      dbPath: resolve(tempDir, 'auth.sqlite'),
    })
    const owner = authStore.ensureSingleTenantOwner({
      ownerLogin: 'alice',
      ownerName: 'Alice',
    })
    const project = authStore.createProject({
      displayName: 'Product Docs',
      slug: 'product-docs',
      userLogin: 'alice',
    })
    const keys = sshUtils.generateKeyPairSync('ed25519')

    const session = authStore.createSshSession({
      projectSlug: 'product-docs',
      publicKey: keys.public,
      scopes: ['bootstrap:read', 'project:read'],
      ttlSeconds: 60,
      userLogin: 'alice',
      username: 'sess_test',
    })
    const principalSession = authStore.findPrincipalBySshFingerprint(session.fingerprint, session.username)

    expect(session.username).toBe('sess_test')
    expect(session.currentProjectSlug).toBe(project.slug)
    expect(authStore.findPrincipalBySshFingerprint(session.fingerprint, 'wrong-user')).toBeNull()
    expect(principalSession).toMatchObject({
      login: 'alice',
      principal: { id: owner.principal.id },
      project: { slug: 'product-docs' },
      scopes: ['bootstrap:read', 'project:read'],
      sshSession: { id: session.id },
      tenant: { slug: 'default' },
    })
    expect(authStore.listSshSessions({ userLogin: 'alice' }).map((entry) => entry.id)).toEqual([session.id])
    const revoked = authStore.revokeSshSession({
      identifier: session.username,
      userLogin: 'alice',
    })
    expect(revoked.id).toBe(session.id)
    expect(revoked.revokedAt).toEqual(expect.any(String))
    expect(authStore.findPrincipalBySshFingerprint(session.fingerprint, session.username)).toBeNull()
    expect(authStore.listSshSessions({ userLogin: 'alice' })).toEqual([])
    expect(authStore.listSshSessions({ includeRevoked: true, userLogin: 'alice' })).toMatchObject([
      {
        id: session.id,
        revokedAt: revoked.revokedAt,
      },
    ])
    expect(authStore.listProjects({ userLogin: 'alice' }).map((entry) => entry.slug)).toEqual([
      'default',
      'product-docs',
    ])
    expect(() =>
      authStore.createSshSession({
        projectSlug: 'missing-project',
        publicKey: keys.public,
        ttlSeconds: 60,
        userLogin: 'alice',
      }),
    ).toThrow(/Project "missing-project" was not found/)
    expect(() =>
      authStore.createSshSession({
        publicKey: keys.public,
        ttlSeconds: 0,
        userLogin: 'alice',
      }),
    ).toThrow(/ttlSeconds must be positive/)

    authStore.close()
  })

  it('creates and authenticates project-scoped API tokens', async () => {
    const tempDir = await createTempDir()
    const authStore = createAuthStore({
      dbPath: resolve(tempDir, 'auth.sqlite'),
    })
    authStore.ensureSingleTenantOwner({
      ownerLogin: 'alice',
      ownerName: 'Alice',
    })
    authStore.createProject({
      displayName: 'Product Docs',
      slug: 'product-docs',
      userLogin: 'alice',
    })

    const created = authStore.createApiToken({
      label: 'agent token',
      projectSlug: 'product-docs',
      scopes: ['bootstrap:read', 'project:read', 'sources:read', 'ssh-session:create'],
      userLogin: 'alice',
    })

    expect(created.token).toMatch(/^dssh_/)
    expect(created).toMatchObject({
      label: 'agent token',
      lastUsedAt: null,
      projectSlug: 'product-docs',
      revokedAt: null,
      scopes: ['bootstrap:read', 'project:read', 'sources:read', 'ssh-session:create'],
    })

    const listed = authStore.listApiTokens({
      projectSlug: 'product-docs',
      userLogin: 'alice',
    })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: created.id,
      label: 'agent token',
      lastUsedAt: null,
      projectSlug: 'product-docs',
      revokedAt: null,
    })
    expect('token' in listed[0]).toBe(false)

    const authenticated = authStore.authenticateApiToken(created.token, {
      projectSlug: 'product-docs',
      requiredScopes: ['ssh-session:create'],
    })
    expect(authenticated?.token.id).toBe(created.id)
    expect(authenticated?.principalSession).toMatchObject({
      login: 'alice',
      project: { slug: 'product-docs' },
      tenant: { slug: 'default' },
    })

    const afterUse = authStore.listApiTokens({
      projectSlug: 'product-docs',
      userLogin: 'alice',
    })[0]
    expect(afterUse.lastUsedAt).toEqual(expect.any(String))

    expect(() =>
      authStore.authenticateApiToken(created.token, {
        projectSlug: 'default',
      }),
    ).toThrow('API token is not valid for project "default".')
    expect(() =>
      authStore.authenticateApiToken(created.token, {
        projectSlug: 'product-docs',
        requiredScopes: ['project:write'],
      }),
    ).toThrow('API token is missing required scope "project:write".')

    const revoked = authStore.revokeApiToken({
      id: created.id,
      userLogin: 'alice',
    })
    expect(revoked.revokedAt).toEqual(expect.any(String))
    expect(authStore.authenticateApiToken(created.token, { projectSlug: 'product-docs' })).toBeNull()

    authStore.close()
  })

  it('excludes expired API tokens from the active token list', async () => {
    const tempDir = await createTempDir()
    const dbPath = resolve(tempDir, 'auth.sqlite')
    const authStore = createAuthStore({
      dbPath,
    })
    authStore.ensureSingleTenantOwner({
      ownerLogin: 'alice',
      ownerName: 'Alice',
    })
    authStore.createProject({
      displayName: 'Product Docs',
      slug: 'product-docs',
      userLogin: 'alice',
    })

    const active = authStore.createApiToken({
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      label: 'active token',
      projectSlug: 'product-docs',
      scopes: ['project:read'],
      userLogin: 'alice',
    })
    const expired = authStore.createApiToken({
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      label: 'expired token',
      projectSlug: 'product-docs',
      scopes: ['project:read'],
      userLogin: 'alice',
    })
    const database = new Database(dbPath)
    database
      .prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60 * 1000).toISOString(), expired.id)
    database.close()

    expect(authStore.listApiTokens({
      projectSlug: 'product-docs',
      userLogin: 'alice',
    }).map((token) => token.id)).toEqual([active.id])
    expect(new Set(authStore.listApiTokens({
      includeExpired: true,
      projectSlug: 'product-docs',
      userLogin: 'alice',
    }).map((token) => token.id))).toEqual(new Set([expired.id, active.id]))

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
