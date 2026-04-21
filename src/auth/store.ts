import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { normalizeSshPublicKey } from './ssh-key.js'

const AUTH_SCHEMA_VERSION = 1
const IDENTIFIER_PATTERN = /[^a-z0-9-]+/g
const DEFAULT_INSTANCE_SLUG = 'default'
const DEFAULT_INSTANCE_NAME = 'Personal docs-ssh'
const DEFAULT_OWNER_LOGIN = 'owner'
const DEFAULT_OWNER_NAME = 'Owner'

export type AuthMembershipRole = 'owner' | 'admin' | 'member'

export interface AuthInstance {
  createdAt: string
  displayName: string
  id: string
  slug: string
}

export interface AuthUser {
  createdAt: string
  displayName: string
  id: string
  login: string
}

export interface AuthMembership {
  createdAt: string
  instanceId: string
  role: AuthMembershipRole
  userId: string
}

export interface AuthIdentity {
  createdAt: string
  email: string | null
  id: string
  issuer: string
  provider: string
  subject: string
  userId: string
}

export interface AuthSshKey {
  algorithm: string
  createdAt: string
  fingerprint: string
  id: string
  name: string | null
  publicKey: string
  userId: string
}

export interface SingleTenantOwner {
  instance: AuthInstance
  membership: AuthMembership
  user: AuthUser
}

export interface EnsureSingleTenantOwnerOptions {
  instanceName?: string
  instanceSlug?: string
  ownerLogin?: string
  ownerName?: string
}

export interface AddAuthIdentityInput {
  email?: string
  issuer: string
  provider?: string
  subject: string
  userLogin?: string
}

export interface SignUpFirstUserWithAuthIdentityInput {
  email?: string
  issuer: string
  ownerLogin?: string
  ownerName?: string
  provider?: string
  subject: string
}

export interface AddSshKeyInput {
  name?: string
  publicKey: string
  userLogin?: string
}

interface InstanceRow extends AuthInstance {}
interface MembershipRow extends AuthMembership {}
interface UserRow extends AuthUser {}
interface AuthIdentityRow extends AuthIdentity {}
interface AuthSshKeyRow extends AuthSshKey {}

function normalizeIdentifier(value: string | undefined, fallback: string): string {
  return value
    ?.trim()
    .toLowerCase()
    .replace(IDENTIFIER_PATTERN, '-')
    .replace(/^-+|-+$/g, '') || fallback
}

function normalizeLabel(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback
}

function createTimestamp(): string {
  return new Date().toISOString()
}

function normalizeProvider(value: string | undefined): string {
  return value?.trim().toLowerCase() || 'oidc'
}

function openDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const database = new Database(dbPath)
  database.pragma('foreign_keys = ON')
  database.pragma('journal_mode = WAL')
  database.pragma('busy_timeout = 5000')
  migrateDatabase(database)
  return database
}

function migrateDatabase(database: Database.Database): void {
  const currentVersion = database.pragma('user_version', { simple: true }) as number
  if (currentVersion > AUTH_SCHEMA_VERSION) {
    throw new Error(`Unsupported auth schema version: ${currentVersion}`)
  }

  if (currentVersion >= 1) {
    return
  }

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

    CREATE INDEX idx_memberships_user_id ON memberships(user_id);
    CREATE INDEX idx_auth_identities_user_id ON auth_identities(user_id);
    CREATE INDEX idx_ssh_keys_user_id ON ssh_keys(user_id);
  `)

  database.pragma(`user_version = ${AUTH_SCHEMA_VERSION}`)
}

function parseInstance(row: InstanceRow): AuthInstance {
  return {
    createdAt: row.createdAt,
    displayName: row.displayName,
    id: row.id,
    slug: row.slug,
  }
}

function parseMembership(row: MembershipRow): AuthMembership {
  return {
    createdAt: row.createdAt,
    instanceId: row.instanceId,
    role: row.role,
    userId: row.userId,
  }
}

function parseUser(row: UserRow): AuthUser {
  return {
    createdAt: row.createdAt,
    displayName: row.displayName,
    id: row.id,
    login: row.login,
  }
}

function parseAuthIdentity(row: AuthIdentityRow): AuthIdentity {
  return {
    createdAt: row.createdAt,
    email: row.email,
    id: row.id,
    issuer: row.issuer,
    provider: row.provider,
    subject: row.subject,
    userId: row.userId,
  }
}

function parseAuthSshKey(row: AuthSshKeyRow): AuthSshKey {
  return {
    algorithm: row.algorithm,
    createdAt: row.createdAt,
    fingerprint: row.fingerprint,
    id: row.id,
    name: row.name,
    publicKey: row.publicKey,
    userId: row.userId,
  }
}

function getUserByLogin(database: Database.Database, login: string): AuthUser | null {
  const row = database
    .prepare(
      `SELECT id, login, display_name AS displayName, created_at AS createdAt
       FROM users
       WHERE login = ?`,
    )
    .get(login) as UserRow | undefined

  return row ? parseUser(row) : null
}

function getUserById(database: Database.Database, userId: string): AuthUser | null {
  const row = database
    .prepare(
      `SELECT id, login, display_name AS displayName, created_at AS createdAt
       FROM users
       WHERE id = ?`,
    )
    .get(userId) as UserRow | undefined

  return row ? parseUser(row) : null
}

function requireUserByLogin(database: Database.Database, login: string): AuthUser {
  const user = getUserByLogin(database, login)
  if (!user) {
    throw new Error(`User "${login}" was not found. Run "docs-ssh auth init" first.`)
  }
  return user
}

function listOwnerUsers(database: Database.Database): AuthUser[] {
  return database
    .prepare(
      `SELECT DISTINCT u.id, u.login, u.display_name AS displayName, u.created_at AS createdAt
       FROM users u
       INNER JOIN memberships m ON m.user_id = u.id
       WHERE m.role = 'owner'
       ORDER BY m.created_at ASC, u.created_at ASC`,
    )
    .all()
    .map((row) => parseUser(row as UserRow))
}

function requireImplicitUser(database: Database.Database): AuthUser {
  const defaultOwner = getUserByLogin(database, DEFAULT_OWNER_LOGIN)
  if (defaultOwner) return defaultOwner

  const owners = listOwnerUsers(database)
  if (owners.length === 1) return owners[0]
  if (owners.length === 0) {
    throw new Error('No owner user found. Run "docs-ssh auth init" first.')
  }

  throw new Error('Multiple owner users exist. Pass --user <login>.')
}

function resolveTargetUser(database: Database.Database, userLogin?: string): AuthUser {
  if (!userLogin) return requireImplicitUser(database)
  return requireUserByLogin(database, normalizeIdentifier(userLogin, DEFAULT_OWNER_LOGIN))
}

function getIdentityByKey(
  database: Database.Database,
  params: Pick<AuthIdentity, 'issuer' | 'provider' | 'subject'>,
): AuthIdentity | null {
  const row = database
    .prepare(
      `SELECT id, user_id AS userId, provider, issuer, subject, email, created_at AS createdAt
       FROM auth_identities
       WHERE provider = ? AND issuer = ? AND subject = ?`,
    )
    .get(params.provider, params.issuer, params.subject) as AuthIdentityRow | undefined

  return row ? parseAuthIdentity(row) : null
}

function getSshKeyByFingerprint(database: Database.Database, fingerprint: string): AuthSshKey | null {
  const row = database
    .prepare(
      `SELECT id, user_id AS userId, name, algorithm, public_key AS publicKey, fingerprint, created_at AS createdAt
       FROM ssh_keys
       WHERE fingerprint = ?`,
    )
    .get(fingerprint) as AuthSshKeyRow | undefined

  return row ? parseAuthSshKey(row) : null
}

function countUsers(database: Database.Database): number {
  const row = database
    .prepare('SELECT COUNT(*) AS count FROM users')
    .get() as { count: number }

  return row.count
}

export interface AuthStore {
  addAuthIdentity(input: AddAuthIdentityInput): AuthIdentity
  addSshKey(input: AddSshKeyInput): AuthSshKey
  close(): void
  dbPath: string
  ensureSingleTenantOwner(opts?: EnsureSingleTenantOwnerOptions): SingleTenantOwner
  findUserByAuthIdentity(params: Pick<AuthIdentity, 'issuer' | 'provider' | 'subject'>): AuthUser | null
  findUserByLogin(login: string): AuthUser | null
  findUserBySshFingerprint(fingerprint: string): AuthUser | null
  listAuthIdentities(userLogin?: string): AuthIdentity[]
  listSshKeys(userLogin?: string): AuthSshKey[]
  signUpFirstUserWithAuthIdentity(input: SignUpFirstUserWithAuthIdentityInput): {
    identity: AuthIdentity
    owner: SingleTenantOwner
  } | null
}

export function createAuthStore(opts: { dbPath: string }): AuthStore {
  const dbPath = resolve(opts.dbPath)
  const database = openDatabase(dbPath)

  const ensureSingleTenantOwnerTx = database.transaction(
    (input: Required<EnsureSingleTenantOwnerOptions>): SingleTenantOwner => {
      const now = createTimestamp()
      let instance = database
        .prepare(
          `SELECT id, slug, display_name AS displayName, created_at AS createdAt
           FROM instances
           WHERE slug = ?`,
        )
        .get(input.instanceSlug) as InstanceRow | undefined

      if (!instance) {
        instance = {
          createdAt: now,
          displayName: input.instanceName,
          id: randomUUID(),
          slug: input.instanceSlug,
        }
        database
          .prepare(
            `INSERT INTO instances (id, slug, display_name, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(instance.id, instance.slug, instance.displayName, instance.createdAt)
      }

      let user = database
        .prepare(
          `SELECT id, login, display_name AS displayName, created_at AS createdAt
           FROM users
           WHERE login = ?`,
        )
        .get(input.ownerLogin) as UserRow | undefined

      if (!user) {
        user = {
          createdAt: now,
          displayName: input.ownerName,
          id: randomUUID(),
          login: input.ownerLogin,
        }
        database
          .prepare(
            `INSERT INTO users (id, login, display_name, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(user.id, user.login, user.displayName, user.createdAt)
      }

      database
        .prepare(
          `INSERT OR IGNORE INTO memberships (instance_id, user_id, role, created_at)
           VALUES (?, ?, 'owner', ?)`,
        )
        .run(instance.id, user.id, now)

      const membership = database
        .prepare(
          `SELECT instance_id AS instanceId, user_id AS userId, role, created_at AS createdAt
           FROM memberships
           WHERE instance_id = ? AND user_id = ?`,
        )
        .get(instance.id, user.id) as MembershipRow | undefined

      if (!membership) {
        throw new Error('Failed to create the default owner membership.')
      }

      return {
        instance: parseInstance(instance),
        membership: parseMembership(membership),
        user: parseUser(user),
      }
    },
  )

  const signUpFirstUserWithAuthIdentityTx = database.transaction(
    (
      input: Required<Pick<SignUpFirstUserWithAuthIdentityInput, 'issuer' | 'provider' | 'subject'>> & {
        email?: string
        ownerLogin: string
        ownerName: string
      },
    ): {
      identity: AuthIdentity
      owner: SingleTenantOwner
    } | null => {
      if (countUsers(database) > 0) return null

      const owner = ensureSingleTenantOwnerTx({
        instanceName: DEFAULT_INSTANCE_NAME,
        instanceSlug: DEFAULT_INSTANCE_SLUG,
        ownerLogin: input.ownerLogin,
        ownerName: input.ownerName,
      })

      const identity: AuthIdentityRow = {
        createdAt: createTimestamp(),
        email: input.email?.trim() || null,
        id: randomUUID(),
        issuer: input.issuer,
        provider: input.provider,
        subject: input.subject,
        userId: owner.user.id,
      }

      database
        .prepare(
          `INSERT INTO auth_identities (id, user_id, provider, issuer, subject, email, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          identity.id,
          identity.userId,
          identity.provider,
          identity.issuer,
          identity.subject,
          identity.email,
          identity.createdAt,
        )

      return {
        identity: parseAuthIdentity(identity),
        owner,
      }
    },
  )

  return {
    dbPath,
    close(): void {
      database.close()
    },
    ensureSingleTenantOwner(opts: EnsureSingleTenantOwnerOptions = {}): SingleTenantOwner {
      return ensureSingleTenantOwnerTx({
        instanceName: normalizeLabel(opts.instanceName, DEFAULT_INSTANCE_NAME),
        instanceSlug: normalizeIdentifier(opts.instanceSlug, DEFAULT_INSTANCE_SLUG),
        ownerLogin: normalizeIdentifier(opts.ownerLogin, DEFAULT_OWNER_LOGIN),
        ownerName: normalizeLabel(opts.ownerName, DEFAULT_OWNER_NAME),
      })
    },
    addAuthIdentity(input: AddAuthIdentityInput): AuthIdentity {
      const user = resolveTargetUser(database, input.userLogin)
      const provider = normalizeProvider(input.provider)
      const issuer = input.issuer.trim()
      const subject = input.subject.trim()
      if (!issuer) throw new Error('Missing required issuer for auth identity.')
      if (!subject) throw new Error('Missing required subject for auth identity.')

      const existing = getIdentityByKey(database, {
        issuer,
        provider,
        subject,
      })
      if (existing) {
        if (existing.userId !== user.id) {
          throw new Error(
            `Auth identity "${provider}:${issuer}:${subject}" is already linked to another user.`,
          )
        }

        database
          .prepare(
            `UPDATE auth_identities
             SET email = ?
             WHERE id = ?`,
          )
          .run(input.email?.trim() || null, existing.id)

        return (
          getIdentityByKey(database, {
            issuer,
            provider,
            subject,
          }) ?? existing
        )
      }

      const identity: AuthIdentityRow = {
        createdAt: createTimestamp(),
        email: input.email?.trim() || null,
        id: randomUUID(),
        issuer,
        provider,
        subject,
        userId: user.id,
      }

      database
        .prepare(
          `INSERT INTO auth_identities (id, user_id, provider, issuer, subject, email, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          identity.id,
          identity.userId,
          identity.provider,
          identity.issuer,
          identity.subject,
          identity.email,
          identity.createdAt,
        )

      return parseAuthIdentity(identity)
    },
    addSshKey(input: AddSshKeyInput): AuthSshKey {
      const user = resolveTargetUser(database, input.userLogin)
      const normalizedKey = normalizeSshPublicKey(input.publicKey)
      const existing = getSshKeyByFingerprint(database, normalizedKey.fingerprint)

      if (existing) {
        if (existing.userId !== user.id) {
          throw new Error(
            `SSH key "${normalizedKey.fingerprint}" is already linked to another user.`,
          )
        }
        return existing
      }

      const sshKey: AuthSshKeyRow = {
        algorithm: normalizedKey.algorithm,
        createdAt: createTimestamp(),
        fingerprint: normalizedKey.fingerprint,
        id: randomUUID(),
        name: input.name?.trim() || null,
        publicKey: normalizedKey.publicKey,
        userId: user.id,
      }

      database
        .prepare(
          `INSERT INTO ssh_keys (id, user_id, name, algorithm, public_key, fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sshKey.id,
          sshKey.userId,
          sshKey.name,
          sshKey.algorithm,
          sshKey.publicKey,
          sshKey.fingerprint,
          sshKey.createdAt,
        )

      return parseAuthSshKey(sshKey)
    },
    findUserByAuthIdentity(params: Pick<AuthIdentity, 'issuer' | 'provider' | 'subject'>): AuthUser | null {
      const identity = getIdentityByKey(database, {
        issuer: params.issuer,
        provider: normalizeProvider(params.provider),
        subject: params.subject,
      })
      if (!identity) return null
      return getUserById(database, identity.userId)
    },
    findUserByLogin(login: string): AuthUser | null {
      return getUserByLogin(database, normalizeIdentifier(login, DEFAULT_OWNER_LOGIN))
    },
    findUserBySshFingerprint(fingerprint: string): AuthUser | null {
      const sshKey = getSshKeyByFingerprint(database, fingerprint)
      if (!sshKey) return null
      return getUserById(database, sshKey.userId)
    },
    listAuthIdentities(userLogin): AuthIdentity[] {
      const user = userLogin
        ? getUserByLogin(database, normalizeIdentifier(userLogin, DEFAULT_OWNER_LOGIN))
        : (() => {
            try {
              return requireImplicitUser(database)
            } catch {
              return null
            }
          })()
      if (!user) return []

      return database
        .prepare(
          `SELECT id, user_id AS userId, provider, issuer, subject, email, created_at AS createdAt
           FROM auth_identities
           WHERE user_id = ?
           ORDER BY created_at ASC`,
        )
        .all(user.id)
        .map((row) => parseAuthIdentity(row as AuthIdentityRow))
    },
    listSshKeys(userLogin): AuthSshKey[] {
      const user = userLogin
        ? getUserByLogin(database, normalizeIdentifier(userLogin, DEFAULT_OWNER_LOGIN))
        : (() => {
            try {
              return requireImplicitUser(database)
            } catch {
              return null
            }
          })()
      if (!user) return []

      return database
        .prepare(
          `SELECT id, user_id AS userId, name, algorithm, public_key AS publicKey, fingerprint, created_at AS createdAt
           FROM ssh_keys
           WHERE user_id = ?
           ORDER BY created_at ASC`,
        )
        .all(user.id)
        .map((row) => parseAuthSshKey(row as AuthSshKeyRow))
    },
    signUpFirstUserWithAuthIdentity(input: SignUpFirstUserWithAuthIdentityInput) {
      const issuer = input.issuer.trim()
      const provider = normalizeProvider(input.provider)
      const subject = input.subject.trim()
      if (!issuer) throw new Error('Missing required issuer for auth identity.')
      if (!subject) throw new Error('Missing required subject for auth identity.')

      return signUpFirstUserWithAuthIdentityTx({
        email: input.email?.trim(),
        issuer,
        ownerLogin: normalizeIdentifier(input.ownerLogin, DEFAULT_OWNER_LOGIN),
        ownerName: normalizeLabel(input.ownerName, DEFAULT_OWNER_NAME),
        provider,
        subject,
      })
    },
  }
}
