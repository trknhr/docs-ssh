import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { normalizeSshPublicKey } from './ssh-key.js'

const AUTH_SCHEMA_VERSION = 4
const IDENTIFIER_PATTERN = /[^a-z0-9-]+/g
const DEFAULT_TENANT_SLUG = 'default'
const DEFAULT_TENANT_NAME = 'Personal docs-ssh'
const DEFAULT_OWNER_LOGIN = 'owner'
const DEFAULT_OWNER_NAME = 'Owner'
const DEFAULT_PROJECT_SLUG = 'default'
const DEFAULT_PROJECT_NAME = 'Default project'
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60
const DEFAULT_SSH_SESSION_SCOPES = [
  'bootstrap:read',
  'home:read',
  'home:write',
  'project:read',
  'project:write',
  'projects:read',
] as const

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
  project: AuthProject
  projectMembership: AuthProjectMembership
  scopes: string[]
  sshSession: AuthSshSession | null
  tenant: AuthTenant
  user: AuthUser | null
}

export interface AuthProject {
  archivedAt: string | null
  createdAt: string
  displayName: string
  id: string
  slug: string
  tenantId: string
}

export interface AuthProjectMembership {
  createdAt: string
  principalId: string
  projectId: string
  role: AuthMembershipRole
}

export interface CreateProjectInput {
  displayName?: string
  slug: string
  tenantSlug?: string
  userLogin?: string
}

export interface UpdateProjectInput {
  displayName?: string
  newSlug?: string
  slug: string
  tenantSlug?: string
  userLogin?: string
}

export interface ArchiveProjectInput {
  slug: string
  tenantSlug?: string
  userLogin?: string
}

export interface AuthSshSession {
  algorithm: string
  createdAt: string
  currentProjectSlug: string
  expiresAt: string
  fingerprint: string
  id: string
  principalId: string
  publicKey: string
  revokedAt: string | null
  scopes: string[]
  tenantId: string
  username: string
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

export interface AddUserInput {
  displayName?: string
  identity?: Omit<AddAuthIdentityInput, 'userLogin'>
  login: string
  role?: AuthMembershipRole
  tenantSlug?: string
}

export interface AuthTenantUser extends AuthUser {
  identities: AuthIdentity[]
  role: AuthMembershipRole
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

export interface CreateSshSessionInput {
  expiresAt?: string
  projectSlug?: string
  publicKey: string
  scopes?: string[]
  tenantSlug?: string
  ttlSeconds?: number
  userLogin?: string
  username?: string
}

export interface ListSshSessionsOptions {
  includeExpired?: boolean
  includeRevoked?: boolean
  tenantSlug?: string
  userLogin?: string
}

export interface ListProjectsOptions {
  includeArchived?: boolean
  tenantSlug?: string
  userLogin?: string
}

export interface ListUsersOptions {
  tenantSlug?: string
}

export interface RevokeSshSessionInput {
  identifier: string
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

interface AuthProjectRow {
  archivedAt: string | null
  createdAt: string
  displayName: string
  id: string
  slug: string
  tenantId: string
}

interface AuthProjectMembershipRow {
  createdAt: string
  principalId: string
  projectId: string
  role: AuthMembershipRole
}

interface AuthSshSessionRow {
  algorithm: string
  createdAt: string
  currentProjectSlug: string | null
  expiresAt: string
  fingerprint: string
  id: string
  principalId: string
  publicKey: string
  revokedAt: string | null
  scopes: string
  tenantId: string
  username: string
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

function normalizeMembershipRole(role: AuthMembershipRole | undefined): AuthMembershipRole {
  if (!role) return 'member'
  if (role === 'owner' || role === 'admin' || role === 'member') return role
  throw new Error(`Unsupported membership role: ${role}`)
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
    migrateSchemaV2ToV3(database)
    migrateSchemaV3ToV4(database)
    database.pragma(`user_version = ${AUTH_SCHEMA_VERSION}`)
    return
  }

  if (currentVersion === 2) {
    migrateSchemaV2ToV3(database)
    migrateSchemaV3ToV4(database)
    database.pragma(`user_version = ${AUTH_SCHEMA_VERSION}`)
    return
  }

  if (currentVersion === 3) {
    migrateSchemaV3ToV4(database)
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
      archived_at TEXT,
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

    CREATE TABLE project_memberships (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, principal_id)
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
    CREATE INDEX idx_project_memberships_principal_id ON project_memberships(principal_id);
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
      archived_at TEXT,
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

function migrateSchemaV2ToV3(database: Database.Database): void {
  const tx = database.transaction(() => {
    database.exec(`
      CREATE TABLE project_memberships (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, principal_id)
      );

      CREATE INDEX idx_project_memberships_principal_id ON project_memberships(principal_id);
    `)

    const now = createTimestamp()
    const tenants = database
      .prepare(
        `SELECT id, slug, display_name AS displayName, created_at AS createdAt
         FROM tenants`,
      )
      .all() as TenantRow[]

    const getProject = database.prepare(
      `SELECT id, tenant_id AS tenantId, slug, display_name AS displayName, created_at AS createdAt, NULL AS archivedAt
       FROM projects
       WHERE tenant_id = ? AND slug = ?`,
    )
    const insertProject = database.prepare(
      `INSERT INTO projects (id, tenant_id, slug, display_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    const memberships = database.prepare(
      `SELECT tenant_id AS tenantId, principal_id AS principalId, role, created_at AS createdAt
       FROM memberships
       WHERE tenant_id = ?`,
    )
    const insertProjectMembership = database.prepare(
      `INSERT OR IGNORE INTO project_memberships (project_id, principal_id, role, created_at)
       VALUES (?, ?, ?, ?)`,
    )

    for (const tenant of tenants) {
      let project = getProject.get(tenant.id, DEFAULT_PROJECT_SLUG) as AuthProjectRow | undefined
      if (!project) {
        project = {
          archivedAt: null,
          createdAt: now,
          displayName: DEFAULT_PROJECT_NAME,
          id: randomUUID(),
          slug: DEFAULT_PROJECT_SLUG,
          tenantId: tenant.id,
        }
        insertProject.run(project.id, project.tenantId, project.slug, project.displayName, project.createdAt)
      }

      for (const membership of memberships.all(tenant.id) as MembershipRow[]) {
        insertProjectMembership.run(project.id, membership.principalId, membership.role, membership.createdAt)
      }
    }
  })

  tx()
}

function migrateSchemaV3ToV4(database: Database.Database): void {
  const columns = database.pragma('table_info(projects)') as Array<{ name: string }>
  if (columns.some((column) => column.name === 'archived_at')) return

  database.exec(`
    ALTER TABLE projects ADD COLUMN archived_at TEXT;
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

function parseProject(row: AuthProjectRow): AuthProject {
  return {
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    displayName: row.displayName,
    id: row.id,
    slug: row.slug,
    tenantId: row.tenantId,
  }
}

function parseProjectMembership(row: AuthProjectMembershipRow): AuthProjectMembership {
  return {
    createdAt: row.createdAt,
    principalId: row.principalId,
    projectId: row.projectId,
    role: row.role,
  }
}

function normalizeScopes(scopes: string[] | undefined): string[] {
  const normalized = (scopes && scopes.length > 0 ? scopes : [...DEFAULT_SSH_SESSION_SCOPES])
    .map((scope) => scope.trim())
    .filter(Boolean)

  return [...new Set(normalized)].sort()
}

function parseScopes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) return normalizeScopes(parsed.filter((entry): entry is string => typeof entry === 'string'))
  } catch {
    // Older hand-authored rows can still use a comma-separated scope list.
  }

  return normalizeScopes(value.split(','))
}

function parseSshSession(row: AuthSshSessionRow): AuthSshSession {
  return {
    algorithm: row.algorithm,
    createdAt: row.createdAt,
    currentProjectSlug: row.currentProjectSlug || DEFAULT_PROJECT_SLUG,
    expiresAt: row.expiresAt,
    fingerprint: row.fingerprint,
    id: row.id,
    principalId: row.principalId,
    publicKey: row.publicKey,
    revokedAt: row.revokedAt,
    scopes: parseScopes(row.scopes),
    tenantId: row.tenantId,
    username: row.username,
  }
}

function resolveSessionExpiresAt(input: Pick<CreateSshSessionInput, 'expiresAt' | 'ttlSeconds'>): string {
  const explicitExpiresAt = input.expiresAt?.trim()
  if (explicitExpiresAt) {
    const timestamp = Date.parse(explicitExpiresAt)
    if (Number.isNaN(timestamp)) {
      throw new Error(`Invalid SSH session expiration: ${input.expiresAt}`)
    }
    if (timestamp <= Date.now()) {
      throw new Error(`SSH session expiration must be in the future: ${input.expiresAt}`)
    }
    return new Date(timestamp).toISOString()
  }

  const ttlSeconds = input.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`SSH session ttlSeconds must be positive: ${ttlSeconds}`)
  }

  return new Date(Date.now() + ttlSeconds * 1000).toISOString()
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

function listAuthIdentitiesForPrincipal(database: Database.Database, principalId: string): AuthIdentity[] {
  return database
    .prepare(
      `SELECT ai.id, ai.principal_id AS principalId, u.id AS userId, ai.provider, ai.issuer, ai.subject, ai.email, ai.created_at AS createdAt
       FROM auth_identities ai
       LEFT JOIN users u ON u.principal_id = ai.principal_id
       WHERE ai.principal_id = ?
       ORDER BY ai.provider ASC, ai.created_at ASC`,
    )
    .all(principalId)
    .map((row) => parseAuthIdentity(row as AuthIdentityRow))
}

function listUsersForTenant(database: Database.Database, tenantId: string): AuthTenantUser[] {
  const rows = database
    .prepare(
      `SELECT u.id, u.login, u.display_name AS displayName, u.principal_id AS principalId, u.created_at AS createdAt, m.role
       FROM users u
       INNER JOIN memberships m ON m.principal_id = u.principal_id
       WHERE m.tenant_id = ?
       ORDER BY
         CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
         u.login ASC`,
    )
    .all(tenantId) as Array<UserRow & { role: AuthMembershipRole }>

  return rows.map((row) => ({
    ...parseUser(row),
    identities: listAuthIdentitiesForPrincipal(database, row.principalId),
    role: row.role,
  }))
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

function getMembershipForPrincipalInTenant(
  database: Database.Database,
  principalId: string,
  tenantId: string,
): AuthMembership | null {
  const row = database
    .prepare(
      `SELECT m.tenant_id AS tenantId, m.principal_id AS principalId, u.id AS userId, m.role, m.created_at AS createdAt
       FROM memberships m
       LEFT JOIN users u ON u.principal_id = m.principal_id
       WHERE m.principal_id = ? AND m.tenant_id = ?`,
    )
    .get(principalId, tenantId) as MembershipRow | undefined

  return row ? parseMembership(row) : null
}

function getProjectByTenantAndSlug(
  database: Database.Database,
  tenantId: string,
  slug: string,
  opts: { includeArchived?: boolean } = {},
): AuthProject | null {
  const row = database
    .prepare(
      `SELECT id, tenant_id AS tenantId, slug, display_name AS displayName,
              created_at AS createdAt, archived_at AS archivedAt
       FROM projects
       WHERE tenant_id = ? AND slug = ?
         ${opts.includeArchived ? '' : 'AND archived_at IS NULL'}`,
    )
    .get(tenantId, slug) as AuthProjectRow | undefined

  return row ? parseProject(row) : null
}

function getProjectMembership(
  database: Database.Database,
  projectId: string,
  principalId: string,
): AuthProjectMembership | null {
  const row = database
    .prepare(
      `SELECT project_id AS projectId, principal_id AS principalId, role, created_at AS createdAt
       FROM project_memberships
       WHERE project_id = ? AND principal_id = ?`,
    )
    .get(projectId, principalId) as AuthProjectMembershipRow | undefined

  return row ? parseProjectMembership(row) : null
}

function ensureProjectForTenant(
  database: Database.Database,
  tenantId: string,
  slug: string,
  displayName: string,
): AuthProject {
  const normalizedSlug = normalizeIdentifier(slug, DEFAULT_PROJECT_SLUG)
  const existing = getProjectByTenantAndSlug(database, tenantId, normalizedSlug)
  if (existing) return existing

  const projectRow: AuthProjectRow = {
    archivedAt: null,
    createdAt: createTimestamp(),
    displayName: normalizeLabel(displayName, DEFAULT_PROJECT_NAME),
    id: randomUUID(),
    slug: normalizedSlug,
    tenantId,
  }

  database
    .prepare(
      `INSERT INTO projects (id, tenant_id, slug, display_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(projectRow.id, projectRow.tenantId, projectRow.slug, projectRow.displayName, projectRow.createdAt)

  return parseProject(projectRow)
}

function createProjectForTenant(
  database: Database.Database,
  tenantId: string,
  slug: string,
  displayName: string,
): AuthProject {
  const normalizedSlug = normalizeIdentifier(slug, DEFAULT_PROJECT_SLUG)
  const existing = getProjectByTenantAndSlug(database, tenantId, normalizedSlug, { includeArchived: true })
  if (existing) {
    throw new Error(`Project "${normalizedSlug}" already exists.`)
  }

  const projectRow: AuthProjectRow = {
    archivedAt: null,
    createdAt: createTimestamp(),
    displayName: normalizeLabel(displayName, normalizedSlug),
    id: randomUUID(),
    slug: normalizedSlug,
    tenantId,
  }

  database
    .prepare(
      `INSERT INTO projects (id, tenant_id, slug, display_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(projectRow.id, projectRow.tenantId, projectRow.slug, projectRow.displayName, projectRow.createdAt)

  return parseProject(projectRow)
}

function ensureProjectMembership(
  database: Database.Database,
  projectId: string,
  principalId: string,
  role: AuthMembershipRole,
): AuthProjectMembership {
  database
    .prepare(
      `INSERT OR IGNORE INTO project_memberships (project_id, principal_id, role, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(projectId, principalId, role, createTimestamp())

  const membership = getProjectMembership(database, projectId, principalId)
  if (!membership) {
    throw new Error('Failed to create project membership.')
  }
  return membership
}

function upsertProjectMembership(
  database: Database.Database,
  projectId: string,
  principalId: string,
  role: AuthMembershipRole,
): AuthProjectMembership {
  database
    .prepare(
      `INSERT INTO project_memberships (project_id, principal_id, role, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, principal_id) DO UPDATE SET role = excluded.role`,
    )
    .run(projectId, principalId, role, createTimestamp())

  const membership = getProjectMembership(database, projectId, principalId)
  if (!membership) {
    throw new Error('Failed to create project membership.')
  }
  return membership
}

function requireProjectMembership(
  database: Database.Database,
  project: AuthProject,
  principalId: string,
): AuthProjectMembership {
  const projectMembership = getProjectMembership(database, project.id, principalId)
  if (!projectMembership) {
    throw new Error(`Principal "${principalId}" is not a member of project "${project.slug}".`)
  }
  return projectMembership
}

function getActiveSshSessionByFingerprint(
  database: Database.Database,
  fingerprint: string,
  username?: string,
): AuthSshSession | null {
  const trimmedUsername = username?.trim()
  const sql = `SELECT id, tenant_id AS tenantId, principal_id AS principalId, current_project_slug AS currentProjectSlug,
                      username, algorithm, public_key AS publicKey, fingerprint, scopes,
                      created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt
               FROM ssh_sessions
               WHERE fingerprint = ?
                 ${trimmedUsername ? 'AND username = ?' : ''}
                 AND revoked_at IS NULL
                 AND expires_at > ?
               ORDER BY expires_at DESC
               LIMIT 1`
  const params = trimmedUsername ? [fingerprint, trimmedUsername, createTimestamp()] : [fingerprint, createTimestamp()]
  const row = database.prepare(sql).get(...params) as AuthSshSessionRow | undefined

  return row ? parseSshSession(row) : null
}

function getSshSessionByIdentifier(database: Database.Database, identifier: string): AuthSshSession | null {
  const row = database
    .prepare(
      `SELECT id, tenant_id AS tenantId, principal_id AS principalId, current_project_slug AS currentProjectSlug,
              username, algorithm, public_key AS publicKey, fingerprint, scopes,
              created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt
       FROM ssh_sessions
       WHERE id = ? OR username = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(identifier, identifier) as AuthSshSessionRow | undefined

  return row ? parseSshSession(row) : null
}

function countActiveSshSessionsForProject(
  database: Database.Database,
  tenantId: string,
  projectSlug: string,
): number {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM ssh_sessions
       WHERE tenant_id = ?
         AND current_project_slug = ?
         AND revoked_at IS NULL
         AND expires_at > ?`,
    )
    .get(tenantId, projectSlug, createTimestamp()) as { count: number }

  return row.count
}

function resolveProjectMutator(
  database: Database.Database,
  input: { tenantSlug?: string, userLogin?: string },
): {
  membership: AuthMembership
  principal: AuthPrincipal
  tenant: AuthTenant
  user: AuthUser
} {
  const user = resolveTargetUser(database, input.userLogin)
  const principal = getPrincipalById(database, user.principalId)
  if (!principal) {
    throw new Error(`Principal "${user.principalId}" for user "${user.login}" was not found.`)
  }

  const tenant = input.tenantSlug
    ? getTenantBySlug(database, normalizeIdentifier(input.tenantSlug, DEFAULT_TENANT_SLUG))
    : (() => {
        const primaryMembership = getPrimaryMembershipForPrincipal(database, principal.id)
        return primaryMembership ? getTenantById(database, primaryMembership.tenantId) : null
      })()
  if (!tenant) {
    throw new Error(`Tenant "${input.tenantSlug ?? DEFAULT_TENANT_SLUG}" was not found.`)
  }

  const membership = getMembershipForPrincipalInTenant(database, principal.id, tenant.id)
  if (!membership) {
    throw new Error(`Principal "${principal.id}" is not a member of tenant "${tenant.slug}".`)
  }
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    throw new Error(`Principal "${principal.id}" cannot manage projects in tenant "${tenant.slug}".`)
  }

  return {
    membership,
    principal,
    tenant,
    user,
  }
}

function countUsers(database: Database.Database): number {
  const row = database
    .prepare('SELECT COUNT(*) AS count FROM users')
    .get() as { count: number }

  return row.count
}

function buildPrincipalSession(
  database: Database.Database,
  params: {
    membership: AuthMembership
    principal: AuthPrincipal
    projectSlug?: string
    scopes?: string[]
    sshSession?: AuthSshSession | null
    tenant: AuthTenant
  },
): AuthPrincipalSession | null {
  const project = getProjectByTenantAndSlug(
    database,
    params.tenant.id,
    normalizeIdentifier(params.projectSlug, DEFAULT_PROJECT_SLUG),
  )
  if (!project) return null

  const projectMembership = getProjectMembership(database, project.id, params.principal.id)
  if (!projectMembership) return null

  const user = getUserByPrincipalId(database, params.principal.id)
  return {
    displayName: user?.displayName ?? params.principal.displayName,
    login: user?.login ?? params.principal.id,
    membership: params.membership,
    principal: params.principal,
    project,
    projectMembership,
    scopes: normalizeScopes(params.scopes),
    sshSession: params.sshSession ?? null,
    tenant: params.tenant,
    user,
  }
}

export interface AuthStore {
  addAuthIdentity(input: AddAuthIdentityInput): AuthIdentity
  addSshKey(input: AddSshKeyInput): AuthSshKey
  addUser(input: AddUserInput): AuthTenantUser
  archiveProject(input: ArchiveProjectInput): AuthProject
  close(): void
  createProject(input: CreateProjectInput): AuthProject
  createSshSession(input: CreateSshSessionInput): AuthSshSession
  dbPath: string
  ensureSingleTenantOwner(opts?: EnsureSingleTenantOwnerOptions): SingleTenantOwner
  findPrincipalBySshFingerprint(fingerprint: string, username?: string): AuthPrincipalSession | null
  findUserProjectSession(userLogin: string, projectSlug?: string): AuthPrincipalSession | null
  findUserByAuthIdentity(params: Pick<AuthIdentity, 'issuer' | 'provider' | 'subject'>): AuthUser | null
  findUserByLogin(login: string): AuthUser | null
  findUserBySshFingerprint(fingerprint: string): AuthUser | null
  hasUsers(): boolean
  listAuthIdentities(userLogin?: string): AuthIdentity[]
  listProjects(opts?: ListProjectsOptions): AuthProject[]
  listSshSessions(opts?: ListSshSessionsOptions): AuthSshSession[]
  listSshKeys(userLogin?: string): AuthSshKey[]
  listUsers(opts?: ListUsersOptions): AuthTenantUser[]
  revokeSshSession(input: RevokeSshSessionInput): AuthSshSession
  signUpFirstUserWithAuthIdentity(input: SignUpFirstUserWithAuthIdentityInput): {
    identity: AuthIdentity
    owner: SingleTenantOwner
  } | null
  updateProject(input: UpdateProjectInput): AuthProject
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

      const project = ensureProjectForTenant(database, tenant.id, DEFAULT_PROJECT_SLUG, DEFAULT_PROJECT_NAME)
      ensureProjectMembership(database, project.id, principal.id, parseMembership(membership).role)

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

  const addUserTx = database.transaction((input: AddUserInput): AuthTenantUser => {
    const tenant = input.tenantSlug
      ? getTenantBySlug(database, normalizeIdentifier(input.tenantSlug, DEFAULT_TENANT_SLUG))
      : getTenantBySlug(database, DEFAULT_TENANT_SLUG)
    if (!tenant) {
      throw new Error(`Tenant "${input.tenantSlug ?? DEFAULT_TENANT_SLUG}" was not found.`)
    }

    const login = normalizeIdentifier(input.login, '')
    if (!login) throw new Error('Missing required user login.')
    const role = normalizeMembershipRole(input.role)
    const now = createTimestamp()

    let user = getUserByLogin(database, login)
    let principal: AuthPrincipal
    if (user) {
      const existingPrincipal = getPrincipalById(database, user.principalId)
      if (!existingPrincipal) {
        throw new Error(`Principal "${user.principalId}" for user "${user.login}" was not found.`)
      }
      principal = existingPrincipal
    } else {
      const displayName = normalizeLabel(input.displayName, login)
      const principalRow: PrincipalRow = {
        createdAt: now,
        displayName,
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
        displayName,
        id: randomUUID(),
        login,
        principalId: principal.id,
      }
      database
        .prepare(
          `INSERT INTO users (id, login, display_name, principal_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(userRow.id, userRow.login, userRow.displayName, userRow.principalId, userRow.createdAt)
      user = parseUser(userRow)
    }

    database
      .prepare(
        `INSERT INTO memberships (tenant_id, principal_id, role, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, principal_id) DO UPDATE SET role = excluded.role`,
      )
      .run(tenant.id, principal.id, role, now)

    ensureProjectForTenant(database, tenant.id, DEFAULT_PROJECT_SLUG, DEFAULT_PROJECT_NAME)
    const projects = database
      .prepare(
        `SELECT id, tenant_id AS tenantId, slug, display_name AS displayName,
                created_at AS createdAt, archived_at AS archivedAt
         FROM projects
         WHERE tenant_id = ?
           AND archived_at IS NULL`,
      )
      .all(tenant.id) as AuthProjectRow[]
    for (const project of projects) {
      upsertProjectMembership(database, project.id, principal.id, role)
    }

    if (input.identity) {
      const provider = normalizeProvider(input.identity.provider)
      const issuer = input.identity.issuer.trim()
      const subject = input.identity.subject.trim()
      if (!issuer) throw new Error('Missing required issuer for auth identity.')
      if (!subject) throw new Error('Missing required subject for auth identity.')

      const existing = getIdentityByKey(database, {
        issuer,
        provider,
        subject,
      })
      if (existing && existing.principalId !== user.principalId) {
        throw new Error(
          `Auth identity "${provider}:${issuer}:${subject}" is already linked to another user or principal.`,
        )
      }

      if (existing) {
        database
          .prepare(
            `UPDATE auth_identities
             SET email = ?
             WHERE id = ?`,
          )
          .run(input.identity.email?.trim() || null, existing.id)
      } else {
        database
          .prepare(
            `INSERT INTO auth_identities (id, principal_id, provider, issuer, subject, email, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            user.principalId,
            provider,
            issuer,
            subject,
            input.identity.email?.trim() || null,
            createTimestamp(),
          )
      }
    }

    return listUsersForTenant(database, tenant.id).find((entry) => entry.id === user.id)
      ?? {
        ...user,
        identities: listAuthIdentitiesForPrincipal(database, user.principalId),
        role,
      }
  })

  return {
    dbPath,
    close(): void {
      database.close()
    },
    addUser(input: AddUserInput): AuthTenantUser {
      return addUserTx(input)
    },
    archiveProject(input: ArchiveProjectInput): AuthProject {
      const actor = resolveProjectMutator(database, input)
      const slug = normalizeIdentifier(input.slug, '')
      if (!slug) throw new Error('Missing required project slug.')
      if (slug === DEFAULT_PROJECT_SLUG) {
        throw new Error('The default project cannot be archived.')
      }

      const project = getProjectByTenantAndSlug(database, actor.tenant.id, slug)
      if (!project) {
        throw new Error(`Project "${slug}" was not found.`)
      }

      if (countActiveSshSessionsForProject(database, actor.tenant.id, project.slug) > 0) {
        throw new Error(`Project "${project.slug}" has active SSH sessions. Revoke them before archiving the project.`)
      }

      const archivedAt = createTimestamp()
      database
        .prepare(
          `UPDATE projects
           SET archived_at = ?
           WHERE id = ?`,
        )
        .run(archivedAt, project.id)

      const archivedProject = getProjectByTenantAndSlug(database, actor.tenant.id, project.slug, { includeArchived: true })
      if (!archivedProject) {
        throw new Error(`Project "${project.slug}" was not found after archive.`)
      }
      return archivedProject
    },
    createProject(input: CreateProjectInput): AuthProject {
      const actor = resolveProjectMutator(database, input)
      const project = createProjectForTenant(database, actor.tenant.id, input.slug, input.displayName ?? input.slug)
      ensureProjectMembership(database, project.id, actor.principal.id, actor.membership.role)
      return project
    },
    updateProject(input: UpdateProjectInput): AuthProject {
      const actor = resolveProjectMutator(database, input)
      const slug = normalizeIdentifier(input.slug, '')
      if (!slug) throw new Error('Missing required project slug.')

      const project = getProjectByTenantAndSlug(database, actor.tenant.id, slug)
      if (!project) {
        throw new Error(`Project "${slug}" was not found.`)
      }

      if (input.newSlug !== undefined && input.newSlug !== null) {
        const requestedSlug = normalizeIdentifier(input.newSlug, '')
        if (!requestedSlug) throw new Error('Missing required new project slug.')
        if (requestedSlug !== project.slug) {
          throw new Error('Project slugs cannot be changed.')
        }
      }

      const nextDisplayName = input.displayName === undefined || input.displayName === null
        ? project.displayName
        : normalizeLabel(input.displayName, project.slug)

      database
        .prepare(
          `UPDATE projects
           SET display_name = ?
           WHERE id = ?`,
        )
        .run(nextDisplayName, project.id)

      const updatedProject = getProjectByTenantAndSlug(database, actor.tenant.id, project.slug)
      if (!updatedProject) {
        throw new Error(`Project "${project.slug}" was not found after update.`)
      }
      return updatedProject
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
    createSshSession(input: CreateSshSessionInput): AuthSshSession {
      const user = resolveTargetUser(database, input.userLogin)
      const principal = getPrincipalById(database, user.principalId)
      if (!principal) {
        throw new Error(`Principal "${user.principalId}" for user "${user.login}" was not found.`)
      }

      const tenant = input.tenantSlug
        ? getTenantBySlug(database, normalizeIdentifier(input.tenantSlug, DEFAULT_TENANT_SLUG))
        : (() => {
            const primaryMembership = getPrimaryMembershipForPrincipal(database, principal.id)
            return primaryMembership ? getTenantById(database, primaryMembership.tenantId) : null
          })()
      if (!tenant) {
        throw new Error(`Tenant "${input.tenantSlug ?? DEFAULT_TENANT_SLUG}" was not found.`)
      }

      const membership = getMembershipForPrincipalInTenant(database, principal.id, tenant.id)
      if (!membership) {
        throw new Error(`Principal "${principal.id}" is not a member of tenant "${tenant.slug}".`)
      }

      const projectSlug = normalizeIdentifier(input.projectSlug, DEFAULT_PROJECT_SLUG)
      const project = getProjectByTenantAndSlug(database, tenant.id, projectSlug)
      if (!project) {
        throw new Error(`Project "${projectSlug}" was not found.`)
      }
      requireProjectMembership(database, project, principal.id)

      const normalizedKey = normalizeSshPublicKey(input.publicKey)
      const scopes = normalizeScopes(input.scopes)
      const now = createTimestamp()
      const expiresAt = resolveSessionExpiresAt(input)
      const sessionRow: AuthSshSessionRow = {
        algorithm: normalizedKey.algorithm,
        createdAt: now,
        currentProjectSlug: project.slug,
        expiresAt,
        fingerprint: normalizedKey.fingerprint,
        id: randomUUID(),
        principalId: principal.id,
        publicKey: normalizedKey.publicKey,
        revokedAt: null,
        scopes: JSON.stringify(scopes),
        tenantId: tenant.id,
        username: input.username?.trim() || `sess_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      }

      database
        .prepare(
          `INSERT INTO ssh_sessions (id, tenant_id, principal_id, current_project_slug, username,
                                    algorithm, public_key, fingerprint, scopes, created_at, expires_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionRow.id,
          sessionRow.tenantId,
          sessionRow.principalId,
          sessionRow.currentProjectSlug,
          sessionRow.username,
          sessionRow.algorithm,
          sessionRow.publicKey,
          sessionRow.fingerprint,
          sessionRow.scopes,
          sessionRow.createdAt,
          sessionRow.expiresAt,
          sessionRow.revokedAt,
        )

      return parseSshSession(sessionRow)
    },
    findPrincipalBySshFingerprint(fingerprint: string, username?: string): AuthPrincipalSession | null {
      const sshSession = getActiveSshSessionByFingerprint(database, fingerprint, username)
      if (sshSession) {
        const principal = getPrincipalById(database, sshSession.principalId)
        if (!principal) return null

        const tenant = getTenantById(database, sshSession.tenantId)
        if (!tenant) return null

        const membership = getMembershipForPrincipalInTenant(database, principal.id, tenant.id)
        if (!membership) return null

        return buildPrincipalSession(database, {
          membership,
          principal,
          projectSlug: sshSession.currentProjectSlug,
          scopes: sshSession.scopes,
          sshSession,
          tenant,
        })
      }

      const sshKey = getSshKeyByFingerprint(database, fingerprint)
      if (!sshKey) return null

      const principal = getPrincipalById(database, sshKey.principalId)
      if (!principal) return null

      const membership = getPrimaryMembershipForPrincipal(database, principal.id)
      if (!membership) return null

      const tenant = getTenantById(database, membership.tenantId)
      if (!tenant) return null

      return buildPrincipalSession(database, {
        membership,
        principal,
        projectSlug: DEFAULT_PROJECT_SLUG,
        scopes: [...DEFAULT_SSH_SESSION_SCOPES],
        sshSession: null,
        tenant,
      })
    },
    findUserProjectSession(userLogin: string, projectSlug?: string): AuthPrincipalSession | null {
      const user = getUserByLogin(database, normalizeIdentifier(userLogin, DEFAULT_OWNER_LOGIN))
      if (!user) return null

      const principal = getPrincipalById(database, user.principalId)
      if (!principal) return null

      const membership = getPrimaryMembershipForPrincipal(database, principal.id)
      if (!membership) return null

      const tenant = getTenantById(database, membership.tenantId)
      if (!tenant) return null

      return buildPrincipalSession(database, {
        membership,
        principal,
        projectSlug: projectSlug ?? DEFAULT_PROJECT_SLUG,
        scopes: [...DEFAULT_SSH_SESSION_SCOPES],
        sshSession: null,
        tenant,
      })
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
    hasUsers(): boolean {
      return countUsers(database) > 0
    },
    listUsers(opts: ListUsersOptions = {}): AuthTenantUser[] {
      const tenant = opts.tenantSlug
        ? getTenantBySlug(database, normalizeIdentifier(opts.tenantSlug, DEFAULT_TENANT_SLUG))
        : getTenantBySlug(database, DEFAULT_TENANT_SLUG)
      if (!tenant) return []
      return listUsersForTenant(database, tenant.id)
    },
    listProjects(opts: ListProjectsOptions = {}): AuthProject[] {
      const user = opts.userLogin
        ? getUserByLogin(database, normalizeIdentifier(opts.userLogin, DEFAULT_OWNER_LOGIN))
        : (() => {
            try {
              return requireImplicitUser(database)
            } catch {
              return null
            }
          })()
      if (!user) return []

      const conditions = ['pm.principal_id = ?']
      const params: unknown[] = [user.principalId]

      if (opts.tenantSlug) {
        const tenant = getTenantBySlug(database, normalizeIdentifier(opts.tenantSlug, DEFAULT_TENANT_SLUG))
        if (!tenant) return []
        conditions.push('p.tenant_id = ?')
        params.push(tenant.id)
      }
      if (!opts.includeArchived) {
        conditions.push('p.archived_at IS NULL')
      }

      return database
        .prepare(
          `SELECT p.id, p.tenant_id AS tenantId, p.slug, p.display_name AS displayName,
                  p.created_at AS createdAt, p.archived_at AS archivedAt
           FROM projects p
           INNER JOIN project_memberships pm ON pm.project_id = p.id
           WHERE ${conditions.join(' AND ')}
           ORDER BY p.slug ASC`,
        )
        .all(...params)
        .map((row) => parseProject(row as AuthProjectRow))
    },
    listSshSessions(opts: ListSshSessionsOptions = {}): AuthSshSession[] {
      const user = opts.userLogin
        ? getUserByLogin(database, normalizeIdentifier(opts.userLogin, DEFAULT_OWNER_LOGIN))
        : (() => {
            try {
              return requireImplicitUser(database)
            } catch {
              return null
            }
          })()
      if (!user) return []

      const conditions = ['ss.principal_id = ?']
      const params: unknown[] = [user.principalId]

      if (opts.tenantSlug) {
        const tenant = getTenantBySlug(database, normalizeIdentifier(opts.tenantSlug, DEFAULT_TENANT_SLUG))
        if (!tenant) return []
        conditions.push('ss.tenant_id = ?')
        params.push(tenant.id)
      }

      if (!opts.includeExpired) {
        conditions.push('ss.expires_at > ?')
        params.push(createTimestamp())
      }

      if (!opts.includeRevoked) {
        conditions.push('ss.revoked_at IS NULL')
      }

      return database
        .prepare(
          `SELECT ss.id, ss.tenant_id AS tenantId, ss.principal_id AS principalId,
                  ss.current_project_slug AS currentProjectSlug, ss.username, ss.algorithm,
                  ss.public_key AS publicKey, ss.fingerprint, ss.scopes,
                  ss.created_at AS createdAt, ss.expires_at AS expiresAt, ss.revoked_at AS revokedAt
           FROM ssh_sessions ss
           WHERE ${conditions.join(' AND ')}
           ORDER BY ss.created_at DESC`,
        )
        .all(...params)
        .map((row) => parseSshSession(row as AuthSshSessionRow))
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
    revokeSshSession(input: RevokeSshSessionInput): AuthSshSession {
      const identifier = input.identifier.trim()
      if (!identifier) throw new Error('Missing required SSH session id or username.')

      const user = resolveTargetUser(database, input.userLogin)
      const session = getSshSessionByIdentifier(database, identifier)
      if (!session || session.principalId !== user.principalId) {
        throw new Error(`SSH session "${identifier}" was not found.`)
      }

      if (!session.revokedAt) {
        database
          .prepare(
            `UPDATE ssh_sessions
             SET revoked_at = ?
             WHERE id = ?`,
          )
          .run(createTimestamp(), session.id)
      }

      const revoked = getSshSessionByIdentifier(database, session.id)
      if (!revoked) {
        throw new Error(`SSH session "${identifier}" was not found after revoke.`)
      }
      return revoked
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
