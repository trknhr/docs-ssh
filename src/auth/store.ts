import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { normalizeSshPublicKey } from './ssh-key.js'

const AUTH_SCHEMA_VERSION = 2
const IDENTIFIER_PATTERN = /[^a-z0-9-]+/g
const DEFAULT_TENANT_SLUG = 'default'
const DEFAULT_TENANT_NAME = 'Personal docs-ssh'
const DEFAULT_OWNER_LOGIN = 'owner'
const DEFAULT_OWNER_NAME = 'Owner'

export type AuthMembershipRole = 'owner' | 'admin' | 'member'
export type AuthPrincipalKind = 'user' | 'service_account'

export interface AuthTenant {
  createdAt: string
  displayName: string
  id: string
  slug: string
}

export type AuthInstance = AuthTenant

export interface AuthPrincipal {
  createdAt: string
  displayName: string
  id: string
  kind: AuthPrincipalKind
}

export interface AuthUser {
  createdAt: string
  displayName: string
  id: string
  login: string
  principalId: string
}

export interface AuthMembership {
  createdAt: string
  instanceId: string
  principalId: string
  role: AuthMembershipRole
  tenantId: string
  userId: string | null
}

export interface AuthIdentity {
  createdAt: string
  email: string | null
  id: string
  issuer: string
  principalId: string
  provider: string
  subject: string
  userId: string | null
}

export interface AuthSshKey {
  algorithm: string
  createdAt: string
  fingerprint: string
  id: string
  name: string | null
  principalId: string
  publicKey: string
  userId: string | null
}

export interface AuthPrincipalSession {
  displayName: string
  login: string
  membership: AuthMembership
  principal: AuthPrincipal
  tenant: AuthTenant
  user: AuthUser | null
}

export interface SingleTenantOwner {
  instance: AuthInstance
  membership: AuthMembership
  principal: AuthPrincipal
  tenant: AuthTenant
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

interface TenantRow {
  createdAt: string
  displayName: string
  id: string
  slug: string
}

interface PrincipalRow {
  createdAt: string
  displayName: string
  id: string
  kind: AuthPrincipalKind
}

interface UserRow {
  createdAt: string
  displayName: string
  id: string
  login: string
  principalId: string
}

interface MembershipRow {
  createdAt: string
  principalId: string
  role: AuthMembershipRole
  tenantId: string
  userId: string | null
}

interface AuthIdentityRow {
  createdAt: string
  email: string | null
  id: string
  issuer: string
  principalId: string
  provider: string
  subject: string
  userId: string | null
}

interface AuthSshKeyRow {
  algorithm: string
  createdAt: string
  fingerprint: string
  id: string
  name: string | null
  principalId: string
  publicKey: string
  userId: string | null
}

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

  if (currentVersion === AUTH_SCHEMA_VERSION) {
    return
  }

  if (currentVersion === 0) {
    createSchemaV2(database)
    database.pragma(`user_version = ${AUTH_SCHEMA_VERSION}`)
    return
  }

  if (currentVersion === 1) {
    migrateSchemaV1ToV2(database)
    database.pragma(`user_version = ${AUTH_SCHEMA_VERSION}`)
    return
  }

  throw new Error(`Unsupported auth schema version: ${currentVersion}`)
}

function createSchemaV2(database: Database.Database): void {
  database.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE principals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('user', 'service_account')),
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      login TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      principal_id TEXT NOT NULL UNIQUE REFERENCES principals(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE memberships (
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, principal_id)
    );

    CREATE TABLE auth_identities (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      email TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (provider, issuer, subject)
    );

    CREATE TABLE ssh_keys (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
      name TEXT,
      algorithm TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE service_accounts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      principal_id TEXT NOT NULL UNIQUE REFERENCES principals(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, slug)
    );

    CREATE TABLE service_account_identities (
      id TEXT PRIMARY KEY,
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      issuer TEXT NOT NULL,
      audience TEXT NOT NULL,
      subject TEXT NOT NULL,
      claim_rules TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (provider, issuer, audience, subject)
    );

    CREATE TABLE api_tokens (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
      name TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, slug)
    );

    CREATE TABLE project_sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_name TEXT NOT NULL,
      mount_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (project_id, source_name)
    );

    CREATE TABLE tenant_shared_sources (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      source_name TEXT NOT NULL,
      mount_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, source_name)
    );

    CREATE TABLE ssh_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
      current_project_slug TEXT,
      username TEXT NOT NULL UNIQUE,
      algorithm TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      scopes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE INDEX idx_memberships_principal_id ON memberships(principal_id);
    CREATE INDEX idx_auth_identities_principal_id ON auth_identities(principal_id);
    CREATE INDEX idx_ssh_keys_principal_id ON ssh_keys(principal_id);
    CREATE INDEX idx_service_accounts_principal_id ON service_accounts(principal_id);
    CREATE INDEX idx_api_tokens_principal_id ON api_tokens(principal_id);
    CREATE INDEX idx_projects_tenant_id ON projects(tenant_id);
    CREATE INDEX idx_ssh_sessions_fingerprint ON ssh_sessions(fingerprint);
    CREATE INDEX idx_ssh_sessions_principal_id ON ssh_sessions(principal_id);
  `)
}

function migrateSchemaV1ToV2(database: Database.Database): void {
  const users = database
    .prepare(
      `SELECT id, login, display_name AS displayName, created_at AS createdAt
       FROM users`,
    )
    .all() as Array<Omit<UserRow, 'principalId'>>

  const tx = database.transaction(() => {
    database.exec(`
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      INSERT INTO tenants (id, slug, display_name, created_at)
      SELECT id, slug, display_name, created_at FROM instances;

      CREATE TABLE principals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('user', 'service_account')),
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)

    const insertPrincipal = database.prepare(
      `INSERT INTO principals (id, kind, display_name, created_at)
       VALUES (?, 'user', ?, ?)`,
    )
    for (const user of users) {
      insertPrincipal.run(user.id, user.displayName, user.createdAt)
    }

    database.exec(`
      ALTER TABLE users RENAME TO users_v1;

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        principal_id TEXT NOT NULL UNIQUE REFERENCES principals(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );

      INSERT INTO users (id, login, display_name, principal_id, created_at)
      SELECT id, login, display_name, id, created_at FROM users_v1;

      ALTER TABLE memberships RENAME TO memberships_v1;

      CREATE TABLE memberships (
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, principal_id)
      );

      INSERT INTO memberships (tenant_id, principal_id, role, created_at)
      SELECT m.instance_id, u.principal_id, m.role, m.created_at
      FROM memberships_v1 m
      INNER JOIN users u ON u.id = m.user_id;

      ALTER TABLE auth_identities RENAME TO auth_identities_v1;

      CREATE TABLE auth_identities (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        email TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (provider, issuer, subject)
      );

      INSERT INTO auth_identities (id, principal_id, provider, issuer, subject, email, created_at)
      SELECT ai.id, u.principal_id, ai.provider, ai.issuer, ai.subject, ai.email, ai.created_at
      FROM auth_identities_v1 ai
      INNER JOIN users u ON u.id = ai.user_id;

      ALTER TABLE ssh_keys RENAME TO ssh_keys_v1;

      CREATE TABLE ssh_keys (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        name TEXT,
        algorithm TEXT NOT NULL,
        public_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      INSERT INTO ssh_keys (id, principal_id, name, algorithm, public_key, fingerprint, created_at)
      SELECT sk.id, u.principal_id, sk.name, sk.algorithm, sk.public_key, sk.fingerprint, sk.created_at
      FROM ssh_keys_v1 sk
      INNER JOIN users u ON u.id = sk.user_id;

      DROP TABLE ssh_keys_v1;
      DROP TABLE auth_identities_v1;
      DROP TABLE memberships_v1;
      DROP TABLE users_v1;
      DROP TABLE instances;
    `)

    createSchemaV2Extensions(database)
  })

  tx()
}

function createSchemaV2Extensions(database: Database.Database): void {
  database.exec(`
    CREATE TABLE service_accounts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      principal_id TEXT NOT NULL UNIQUE REFERENCES principals(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, slug)
    );

    CREATE TABLE service_account_identities (
      id TEXT PRIMARY KEY,
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      issuer TEXT NOT NULL,
      audience TEXT NOT NULL,
      subject TEXT NOT NULL,
      claim_rules TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (provider, issuer, audience, subject)
    );

    CREATE TABLE api_tokens (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
      name TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, slug)
    );

    CREATE TABLE project_sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_name TEXT NOT NULL,
      mount_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (project_id, source_name)
    );

    CREATE TABLE tenant_shared_sources (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      source_name TEXT NOT NULL,
      mount_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, source_name)
    );

    CREATE TABLE ssh_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
      current_project_slug TEXT,
      username TEXT NOT NULL UNIQUE,
      algorithm TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      scopes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE INDEX idx_memberships_principal_id ON memberships(principal_id);
    CREATE INDEX idx_auth_identities_principal_id ON auth_identities(principal_id);
    CREATE INDEX idx_ssh_keys_principal_id ON ssh_keys(principal_id);
    CREATE INDEX idx_service_accounts_principal_id ON service_accounts(principal_id);
    CREATE INDEX idx_api_tokens_principal_id ON api_tokens(principal_id);
    CREATE INDEX idx_projects_tenant_id ON projects(tenant_id);
    CREATE INDEX idx_ssh_sessions_fingerprint ON ssh_sessions(fingerprint);
    CREATE INDEX idx_ssh_sessions_principal_id ON ssh_sessions(principal_id);
  `)
}

function parseTenant(row: TenantRow): AuthTenant {
  return {
    createdAt: row.createdAt,
    displayName: row.displayName,
    id: row.id,
    slug: row.slug,
  }
}

function parsePrincipal(row: PrincipalRow): AuthPrincipal {
  return {
    createdAt: row.createdAt,
    displayName: row.displayName,
    id: row.id,
    kind: row.kind,
  }
}

function parseMembership(row: MembershipRow): AuthMembership {
  return {
    createdAt: row.createdAt,
    instanceId: row.tenantId,
    principalId: row.principalId,
    role: row.role,
    tenantId: row.tenantId,
    userId: row.userId,
  }
}

function parseUser(row: UserRow): AuthUser {
  return {
    createdAt: row.createdAt,
    displayName: row.displayName,
    id: row.id,
    login: row.login,
    principalId: row.principalId,
  }
}

function parseAuthIdentity(row: AuthIdentityRow): AuthIdentity {
  return {
    createdAt: row.createdAt,
    email: row.email,
    id: row.id,
    issuer: row.issuer,
    principalId: row.principalId,
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
    principalId: row.principalId,
    publicKey: row.publicKey,
    userId: row.userId,
  }
}

function getTenantById(database: Database.Database, tenantId: string): AuthTenant | null {
  const row = database
    .prepare(
      `SELECT id, slug, display_name AS displayName, created_at AS createdAt
       FROM tenants
       WHERE id = ?`,
    )
    .get(tenantId) as TenantRow | undefined

  return row ? parseTenant(row) : null
}

function getTenantBySlug(database: Database.Database, slug: string): AuthTenant | null {
  const row = database
    .prepare(
      `SELECT id, slug, display_name AS displayName, created_at AS createdAt
       FROM tenants
       WHERE slug = ?`,
    )
    .get(slug) as TenantRow | undefined

  return row ? parseTenant(row) : null
}

function getPrincipalById(database: Database.Database, principalId: string): AuthPrincipal | null {
  const row = database
    .prepare(
      `SELECT id, kind, display_name AS displayName, created_at AS createdAt
       FROM principals
       WHERE id = ?`,
    )
    .get(principalId) as PrincipalRow | undefined

  return row ? parsePrincipal(row) : null
}

function getUserByLogin(database: Database.Database, login: string): AuthUser | null {
  const row = database
    .prepare(
      `SELECT id, login, display_name AS displayName, principal_id AS principalId, created_at AS createdAt
       FROM users
       WHERE login = ?`,
    )
    .get(login) as UserRow | undefined

  return row ? parseUser(row) : null
}

function getUserById(database: Database.Database, userId: string): AuthUser | null {
  const row = database
    .prepare(
      `SELECT id, login, display_name AS displayName, principal_id AS principalId, created_at AS createdAt
       FROM users
       WHERE id = ?`,
    )
    .get(userId) as UserRow | undefined

  return row ? parseUser(row) : null
}

function getUserByPrincipalId(database: Database.Database, principalId: string): AuthUser | null {
  const row = database
    .prepare(
      `SELECT id, login, display_name AS displayName, principal_id AS principalId, created_at AS createdAt
       FROM users
       WHERE principal_id = ?`,
    )
    .get(principalId) as UserRow | undefined

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
      `SELECT DISTINCT u.id, u.login, u.display_name AS displayName, u.principal_id AS principalId, u.created_at AS createdAt
       FROM users u
       INNER JOIN memberships m ON m.principal_id = u.principal_id
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
      `SELECT ai.id, ai.principal_id AS principalId, u.id AS userId, ai.provider, ai.issuer, ai.subject, ai.email, ai.created_at AS createdAt
       FROM auth_identities ai
       LEFT JOIN users u ON u.principal_id = ai.principal_id
       WHERE ai.provider = ? AND ai.issuer = ? AND ai.subject = ?`,
    )
    .get(params.provider, params.issuer, params.subject) as AuthIdentityRow | undefined

  return row ? parseAuthIdentity(row) : null
}

function getSshKeyByFingerprint(database: Database.Database, fingerprint: string): AuthSshKey | null {
  const row = database
    .prepare(
      `SELECT sk.id, sk.principal_id AS principalId, u.id AS userId, sk.name, sk.algorithm, sk.public_key AS publicKey, sk.fingerprint, sk.created_at AS createdAt
       FROM ssh_keys sk
       LEFT JOIN users u ON u.principal_id = sk.principal_id
       WHERE sk.fingerprint = ?`,
    )
    .get(fingerprint) as AuthSshKeyRow | undefined

  return row ? parseAuthSshKey(row) : null
}

function getPrimaryMembershipForPrincipal(
  database: Database.Database,
  principalId: string,
): AuthMembership | null {
  const row = database
    .prepare(
      `SELECT m.tenant_id AS tenantId, m.principal_id AS principalId, u.id AS userId, m.role, m.created_at AS createdAt
       FROM memberships m
       LEFT JOIN users u ON u.principal_id = m.principal_id
       WHERE m.principal_id = ?
       ORDER BY
         CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
         m.created_at ASC
       LIMIT 1`,
    )
    .get(principalId) as MembershipRow | undefined

  return row ? parseMembership(row) : null
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
  findPrincipalBySshFingerprint(fingerprint: string): AuthPrincipalSession | null
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
      let tenant = getTenantBySlug(database, input.instanceSlug)

      if (!tenant) {
        const tenantRow: TenantRow = {
          createdAt: now,
          displayName: input.instanceName,
          id: randomUUID(),
          slug: input.instanceSlug,
        }
        database
          .prepare(
            `INSERT INTO tenants (id, slug, display_name, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(tenantRow.id, tenantRow.slug, tenantRow.displayName, tenantRow.createdAt)
        tenant = parseTenant(tenantRow)
      }

      let user = getUserByLogin(database, input.ownerLogin)
      let principal: AuthPrincipal

      if (!user) {
        const principalRow: PrincipalRow = {
          createdAt: now,
          displayName: input.ownerName,
          id: randomUUID(),
          kind: 'user',
        }
        database
          .prepare(
            `INSERT INTO principals (id, kind, display_name, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(principalRow.id, principalRow.kind, principalRow.displayName, principalRow.createdAt)
        principal = parsePrincipal(principalRow)

        const userRow: UserRow = {
          createdAt: now,
          displayName: input.ownerName,
          id: randomUUID(),
          login: input.ownerLogin,
          principalId: principal.id,
        }
        database
          .prepare(
            `INSERT INTO users (id, login, display_name, principal_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(userRow.id, userRow.login, userRow.displayName, userRow.principalId, userRow.createdAt)
        user = parseUser(userRow)
      } else {
        const existingPrincipal = getPrincipalById(database, user.principalId)
        if (!existingPrincipal) {
          throw new Error(`Principal "${user.principalId}" for user "${user.login}" was not found.`)
        }
        principal = existingPrincipal
      }

      database
        .prepare(
          `INSERT OR IGNORE INTO memberships (tenant_id, principal_id, role, created_at)
           VALUES (?, ?, 'owner', ?)`,
        )
        .run(tenant.id, principal.id, now)

      const membership = database
        .prepare(
          `SELECT m.tenant_id AS tenantId, m.principal_id AS principalId, u.id AS userId, m.role, m.created_at AS createdAt
           FROM memberships m
           LEFT JOIN users u ON u.principal_id = m.principal_id
           WHERE m.tenant_id = ? AND m.principal_id = ?`,
        )
        .get(tenant.id, principal.id) as MembershipRow | undefined

      if (!membership) {
        throw new Error('Failed to create the default owner membership.')
      }

      return {
        instance: tenant,
        membership: parseMembership(membership),
        principal,
        tenant,
        user,
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
        instanceName: DEFAULT_TENANT_NAME,
        instanceSlug: DEFAULT_TENANT_SLUG,
        ownerLogin: input.ownerLogin,
        ownerName: input.ownerName,
      })

      const identity: AuthIdentityRow = {
        createdAt: createTimestamp(),
        email: input.email?.trim() || null,
        id: randomUUID(),
        issuer: input.issuer,
        principalId: owner.principal.id,
        provider: input.provider,
        subject: input.subject,
        userId: owner.user.id,
      }

      database
        .prepare(
          `INSERT INTO auth_identities (id, principal_id, provider, issuer, subject, email, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          identity.id,
          identity.principalId,
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
        instanceName: normalizeLabel(opts.instanceName, DEFAULT_TENANT_NAME),
        instanceSlug: normalizeIdentifier(opts.instanceSlug, DEFAULT_TENANT_SLUG),
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
        if (existing.principalId !== user.principalId) {
          throw new Error(
            `Auth identity "${provider}:${issuer}:${subject}" is already linked to another user or principal.`,
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
        principalId: user.principalId,
        provider,
        subject,
        userId: user.id,
      }

      database
        .prepare(
          `INSERT INTO auth_identities (id, principal_id, provider, issuer, subject, email, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          identity.id,
          identity.principalId,
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
        if (existing.principalId !== user.principalId) {
          throw new Error(
            `SSH key "${normalizedKey.fingerprint}" is already linked to another user or principal.`,
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
        principalId: user.principalId,
        publicKey: normalizedKey.publicKey,
        userId: user.id,
      }

      database
        .prepare(
          `INSERT INTO ssh_keys (id, principal_id, name, algorithm, public_key, fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sshKey.id,
          sshKey.principalId,
          sshKey.name,
          sshKey.algorithm,
          sshKey.publicKey,
          sshKey.fingerprint,
          sshKey.createdAt,
        )

      return parseAuthSshKey(sshKey)
    },
    findPrincipalBySshFingerprint(fingerprint: string): AuthPrincipalSession | null {
      const sshKey = getSshKeyByFingerprint(database, fingerprint)
      if (!sshKey) return null

      const principal = getPrincipalById(database, sshKey.principalId)
      if (!principal) return null

      const membership = getPrimaryMembershipForPrincipal(database, principal.id)
      if (!membership) return null

      const tenant = getTenantById(database, membership.tenantId)
      if (!tenant) return null

      const user = getUserByPrincipalId(database, principal.id)
      return {
        displayName: user?.displayName ?? principal.displayName,
        login: user?.login ?? principal.id,
        membership,
        principal,
        tenant,
        user,
      }
    },
    findUserByAuthIdentity(params: Pick<AuthIdentity, 'issuer' | 'provider' | 'subject'>): AuthUser | null {
      const identity = getIdentityByKey(database, {
        issuer: params.issuer,
        provider: normalizeProvider(params.provider),
        subject: params.subject,
      })
      if (!identity) return null
      return getUserByPrincipalId(database, identity.principalId)
    },
    findUserByLogin(login: string): AuthUser | null {
      return getUserByLogin(database, normalizeIdentifier(login, DEFAULT_OWNER_LOGIN))
    },
    findUserBySshFingerprint(fingerprint: string): AuthUser | null {
      return this.findPrincipalBySshFingerprint(fingerprint)?.user ?? null
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
          `SELECT ai.id, ai.principal_id AS principalId, u.id AS userId, ai.provider, ai.issuer, ai.subject, ai.email, ai.created_at AS createdAt
           FROM auth_identities ai
           LEFT JOIN users u ON u.principal_id = ai.principal_id
           WHERE ai.principal_id = ?
           ORDER BY ai.created_at ASC`,
        )
        .all(user.principalId)
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
          `SELECT sk.id, sk.principal_id AS principalId, u.id AS userId, sk.name, sk.algorithm, sk.public_key AS publicKey, sk.fingerprint, sk.created_at AS createdAt
           FROM ssh_keys sk
           LEFT JOIN users u ON u.principal_id = sk.principal_id
           WHERE sk.principal_id = ?
           ORDER BY sk.created_at ASC`,
        )
        .all(user.principalId)
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
