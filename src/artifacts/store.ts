import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'

const ARTIFACT_SCHEMA_VERSION = 1
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
const PUBLIC_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
const PUBLIC_ID_LENGTH = 16

export type ArtifactFormat = 'html'
export type ArtifactVisibility = 'private' | 'project'

export interface ArtifactVersion {
  contentHash: string
  createdAt: string
  createdByLogin: string
  createdByPrincipalId: string
  sizeBytes: number
  version: number
}

export interface Artifact {
  createdAt: string
  creatorDisplayName: string
  creatorLogin: string
  creatorPrincipalId: string
  format: ArtifactFormat
  latestVersion: number
  projectDisplayName: string
  projectId: string
  projectPublicId: string
  projectSlug: string
  publicId: string
  sourcePath: string
  tenantId: string
  tenantPublicId: string
  title: string
  updatedAt: string
  visibility: ArtifactVisibility
}

export interface ArtifactWithVersions extends Artifact {
  versions: ArtifactVersion[]
}

export interface ArtifactContent {
  artifact: ArtifactWithVersions
  content: string
  version: ArtifactVersion
}

export interface PublishArtifactInput {
  content: string
  creatorDisplayName: string
  creatorLogin: string
  creatorPrincipalId: string
  format: ArtifactFormat
  projectDisplayName: string
  projectId: string
  projectPublicId: string
  projectSlug: string
  sourcePath: string
  tenantId: string
  tenantPublicId: string
  title: string
  visibility?: ArtifactVisibility
}

interface ArtifactRow {
  createdAt: string
  creatorDisplayName: string
  creatorLogin: string
  creatorPrincipalId: string
  format: ArtifactFormat
  id: string
  latestVersion: number
  projectDisplayName: string
  projectId: string
  projectPublicId: string
  projectSlug: string
  publicId: string
  sourcePath: string
  tenantId: string
  tenantPublicId: string
  title: string
  updatedAt: string
  visibility: ArtifactVisibility
}

interface ArtifactVersionRow {
  content?: string
  contentHash: string
  createdAt: string
  createdByLogin: string
  createdByPrincipalId: string
  sizeBytes: number
  version: number
}

export interface ArtifactStore {
  close(): void
  dbPath: string
  getArtifact(publicId: string): ArtifactWithVersions | null
  getArtifactContent(publicId: string, version?: number): ArtifactContent | null
  listArtifacts(input: {
    principalId: string
    projectId: string
    tenantId: string
  }): ArtifactWithVersions[]
  publishArtifact(input: PublishArtifactInput): ArtifactContent
  updateArtifactVisibility(input: {
    principalId: string
    publicId: string
    visibility: ArtifactVisibility
  }): ArtifactWithVersions
}

function createTimestamp(): string {
  return new Date().toISOString()
}

function createPublicId(): string {
  let value = ''

  while (value.length < PUBLIC_ID_LENGTH) {
    for (const byte of randomBytes(PUBLIC_ID_LENGTH)) {
      const unbiasedLimit = Math.floor(256 / PUBLIC_ID_ALPHABET.length) * PUBLIC_ID_ALPHABET.length
      if (byte >= unbiasedLimit) continue
      value += PUBLIC_ID_ALPHABET[byte % PUBLIC_ID_ALPHABET.length]
      if (value.length === PUBLIC_ID_LENGTH) return value
    }
  }

  return value
}

function openDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const database = new Database(dbPath)
  database.pragma('foreign_keys = ON')
  database.pragma('journal_mode = WAL')
  database.pragma('busy_timeout = 5000')

  const currentVersion = database.pragma('user_version', { simple: true }) as number
  if (currentVersion > ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`Unsupported artifact schema version: ${currentVersion}`)
  }

  if (currentVersion === 0) {
    database.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        public_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        tenant_public_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_public_id TEXT NOT NULL,
        project_slug TEXT NOT NULL,
        project_display_name TEXT NOT NULL,
        creator_principal_id TEXT NOT NULL,
        creator_login TEXT NOT NULL,
        creator_display_name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        title TEXT NOT NULL,
        format TEXT NOT NULL CHECK(format IN ('html')),
        visibility TEXT NOT NULL CHECK(visibility IN ('private', 'project')),
        latest_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, creator_principal_id, source_path)
      );

      CREATE TABLE artifact_versions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_by_principal_id TEXT NOT NULL,
        created_by_login TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(artifact_id, version)
      );

      CREATE INDEX idx_artifacts_project_updated
        ON artifacts(tenant_id, project_id, updated_at DESC);
      CREATE INDEX idx_artifact_versions_artifact_version
        ON artifact_versions(artifact_id, version DESC);
    `)
    database.pragma(`user_version = ${ARTIFACT_SCHEMA_VERSION}`)
  }

  return database
}

function parseArtifact(row: ArtifactRow): Artifact {
  return {
    createdAt: row.createdAt,
    creatorDisplayName: row.creatorDisplayName,
    creatorLogin: row.creatorLogin,
    creatorPrincipalId: row.creatorPrincipalId,
    format: row.format,
    latestVersion: row.latestVersion,
    projectDisplayName: row.projectDisplayName,
    projectId: row.projectId,
    projectPublicId: row.projectPublicId,
    projectSlug: row.projectSlug,
    publicId: row.publicId,
    sourcePath: row.sourcePath,
    tenantId: row.tenantId,
    tenantPublicId: row.tenantPublicId,
    title: row.title,
    updatedAt: row.updatedAt,
    visibility: row.visibility,
  }
}

function parseVersion(row: ArtifactVersionRow): ArtifactVersion {
  return {
    contentHash: row.contentHash,
    createdAt: row.createdAt,
    createdByLogin: row.createdByLogin,
    createdByPrincipalId: row.createdByPrincipalId,
    sizeBytes: row.sizeBytes,
    version: row.version,
  }
}

const artifactSelect = `
  SELECT id, public_id AS publicId, tenant_id AS tenantId, tenant_public_id AS tenantPublicId,
         project_id AS projectId, project_public_id AS projectPublicId, project_slug AS projectSlug,
         project_display_name AS projectDisplayName, creator_principal_id AS creatorPrincipalId,
         creator_login AS creatorLogin, creator_display_name AS creatorDisplayName,
         source_path AS sourcePath, title, format, visibility, latest_version AS latestVersion,
         created_at AS createdAt, updated_at AS updatedAt
  FROM artifacts
`

const versionSelect = `
  SELECT version, content_hash AS contentHash, size_bytes AS sizeBytes,
         created_by_principal_id AS createdByPrincipalId,
         created_by_login AS createdByLogin, created_at AS createdAt
  FROM artifact_versions
`

function getArtifactRow(database: Database.Database, publicId: string): ArtifactRow | null {
  const row = database
    .prepare(`${artifactSelect} WHERE public_id = ?`)
    .get(publicId.trim()) as ArtifactRow | undefined
  return row ?? null
}

function getArtifactVersions(database: Database.Database, artifactId: string): ArtifactVersion[] {
  return database
    .prepare(`${versionSelect} WHERE artifact_id = ? ORDER BY version DESC`)
    .all(artifactId)
    .map((row) => parseVersion(row as ArtifactVersionRow))
}

function getArtifactWithVersions(
  database: Database.Database,
  row: ArtifactRow,
): ArtifactWithVersions {
  return {
    ...parseArtifact(row),
    versions: getArtifactVersions(database, row.id),
  }
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`Missing required ${label}.`)
  return trimmed
}

function validatePublishInput(input: PublishArtifactInput): PublishArtifactInput {
  const sizeBytes = Buffer.byteLength(input.content, 'utf8')
  if (sizeBytes > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact exceeds the ${MAX_ARTIFACT_BYTES} byte publish limit.`)
  }
  if (input.format !== 'html') {
    throw new Error(`Unsupported artifact format: ${input.format}`)
  }

  return {
    ...input,
    creatorDisplayName: requireText(input.creatorDisplayName, 'creator display name'),
    creatorLogin: requireText(input.creatorLogin, 'creator login'),
    creatorPrincipalId: requireText(input.creatorPrincipalId, 'creator principal id'),
    projectDisplayName: requireText(input.projectDisplayName, 'project display name'),
    projectId: requireText(input.projectId, 'project id'),
    projectPublicId: requireText(input.projectPublicId, 'project public id'),
    projectSlug: requireText(input.projectSlug, 'project slug'),
    sourcePath: requireText(input.sourcePath, 'source path'),
    tenantId: requireText(input.tenantId, 'tenant id'),
    tenantPublicId: requireText(input.tenantPublicId, 'tenant public id'),
    title: requireText(input.title, 'artifact title').slice(0, 240),
  }
}

export function createArtifactStore(opts: { dbPath: string }): ArtifactStore {
  const dbPath = resolve(opts.dbPath)
  const database = openDatabase(dbPath)

  const publishTx = database.transaction((rawInput: PublishArtifactInput): ArtifactContent => {
    const input = validatePublishInput(rawInput)
    const now = createTimestamp()
    let row = database
      .prepare(
        `${artifactSelect}
         WHERE project_id = ? AND creator_principal_id = ? AND source_path = ?`,
      )
      .get(input.projectId, input.creatorPrincipalId, input.sourcePath) as ArtifactRow | undefined

    if (!row) {
      row = {
        createdAt: now,
        creatorDisplayName: input.creatorDisplayName,
        creatorLogin: input.creatorLogin,
        creatorPrincipalId: input.creatorPrincipalId,
        format: input.format,
        id: randomUUID(),
        latestVersion: 0,
        projectDisplayName: input.projectDisplayName,
        projectId: input.projectId,
        projectPublicId: input.projectPublicId,
        projectSlug: input.projectSlug,
        publicId: createPublicId(),
        sourcePath: input.sourcePath,
        tenantId: input.tenantId,
        tenantPublicId: input.tenantPublicId,
        title: input.title,
        updatedAt: now,
        visibility: input.visibility ?? 'private',
      }
      database
        .prepare(
          `INSERT INTO artifacts (
             id, public_id, tenant_id, tenant_public_id, project_id, project_public_id,
             project_slug, project_display_name, creator_principal_id, creator_login,
             creator_display_name, source_path, title, format, visibility, latest_version,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.publicId,
          row.tenantId,
          row.tenantPublicId,
          row.projectId,
          row.projectPublicId,
          row.projectSlug,
          row.projectDisplayName,
          row.creatorPrincipalId,
          row.creatorLogin,
          row.creatorDisplayName,
          row.sourcePath,
          row.title,
          row.format,
          row.visibility,
          row.latestVersion,
          row.createdAt,
          row.updatedAt,
        )
    }

    const versionNumber = row.latestVersion + 1
    const contentHash = createHash('sha256').update(input.content).digest('hex')
    const sizeBytes = Buffer.byteLength(input.content, 'utf8')
    database
      .prepare(
        `INSERT INTO artifact_versions (
           id, artifact_id, version, content, content_hash, size_bytes,
           created_by_principal_id, created_by_login, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        row.id,
        versionNumber,
        input.content,
        contentHash,
        sizeBytes,
        input.creatorPrincipalId,
        input.creatorLogin,
        now,
      )

    database
      .prepare(
        `UPDATE artifacts
         SET title = ?, visibility = ?, latest_version = ?, updated_at = ?,
             project_slug = ?, project_display_name = ?, project_public_id = ?,
             creator_login = ?, creator_display_name = ?
         WHERE id = ?`,
      )
      .run(
        input.title,
        input.visibility ?? row.visibility,
        versionNumber,
        now,
        input.projectSlug,
        input.projectDisplayName,
        input.projectPublicId,
        input.creatorLogin,
        input.creatorDisplayName,
        row.id,
      )

    const published = getArtifactRow(database, row.publicId)
    if (!published) throw new Error('Artifact was not found after publish.')
    const artifact = getArtifactWithVersions(database, published)
    const version = artifact.versions.find((entry) => entry.version === versionNumber)
    if (!version) throw new Error('Artifact version was not found after publish.')

    return {
      artifact,
      content: input.content,
      version,
    }
  })

  return {
    close(): void {
      database.close()
    },
    dbPath,
    getArtifact(publicId: string): ArtifactWithVersions | null {
      const row = getArtifactRow(database, publicId)
      return row ? getArtifactWithVersions(database, row) : null
    },
    getArtifactContent(publicId: string, version?: number): ArtifactContent | null {
      const row = getArtifactRow(database, publicId)
      if (!row) return null
      const requestedVersion = version ?? row.latestVersion
      if (!Number.isSafeInteger(requestedVersion) || requestedVersion <= 0) return null

      const versionRow = database
        .prepare(
          `SELECT version, content, content_hash AS contentHash, size_bytes AS sizeBytes,
                  created_by_principal_id AS createdByPrincipalId,
                  created_by_login AS createdByLogin, created_at AS createdAt
           FROM artifact_versions
           WHERE artifact_id = ? AND version = ?`,
        )
        .get(row.id, requestedVersion) as ArtifactVersionRow | undefined
      if (!versionRow || versionRow.content === undefined) return null

      return {
        artifact: getArtifactWithVersions(database, row),
        content: versionRow.content,
        version: parseVersion(versionRow),
      }
    },
    listArtifacts(input): ArtifactWithVersions[] {
      return database
        .prepare(
          `${artifactSelect}
           WHERE tenant_id = ? AND project_id = ?
             AND (creator_principal_id = ? OR visibility = 'project')
           ORDER BY updated_at DESC`,
        )
        .all(input.tenantId, input.projectId, input.principalId)
        .map((row) => getArtifactWithVersions(database, row as ArtifactRow))
    },
    publishArtifact(input: PublishArtifactInput): ArtifactContent {
      return publishTx(input)
    },
    updateArtifactVisibility(input): ArtifactWithVersions {
      const row = getArtifactRow(database, input.publicId)
      if (!row || row.creatorPrincipalId !== input.principalId) {
        throw new Error(`Artifact "${input.publicId}" was not found or is not owned by this principal.`)
      }
      if (input.visibility !== 'private' && input.visibility !== 'project') {
        throw new Error(`Unsupported artifact visibility: ${input.visibility}`)
      }

      database
        .prepare('UPDATE artifacts SET visibility = ?, updated_at = ? WHERE id = ?')
        .run(input.visibility, createTimestamp(), row.id)

      const updated = getArtifactRow(database, row.publicId)
      if (!updated) throw new Error('Artifact was not found after visibility update.')
      return getArtifactWithVersions(database, updated)
    },
  }
}
