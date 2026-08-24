import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, posix, resolve, sep } from 'node:path'

export const DEFAULT_MAX_HTTP_FILE_BYTES = 16 * 1024 * 1024
const TEMPORARY_FILE_PREFIX = '.docs-ssh-upload-'

export type WorkspaceEntryType = 'directory' | 'file'

export interface WorkspaceEntry {
  modifiedAt: string
  name: string
  path: string
  size: number | null
  type: WorkspaceEntryType
}

export class WorkspaceFileError extends Error {
  readonly code: string
  readonly statusCode: number

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.name = 'WorkspaceFileError'
    this.code = code
    this.statusCode = statusCode
  }
}

interface InspectedPath {
  absolutePath: string
  entry: WorkspaceEntry | null
  exists: boolean
  relativePath: string
  stats: Stats | null
}

interface WorkspaceFileServiceOptions {
  maxFileBytes?: number
  readOnlyPaths?: string[]
  writableDirectories?: string[]
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

function normalizeRelativePath(value: string, opts: { allowRoot?: boolean } = {}): string {
  if (value.includes('\0')) {
    throw new WorkspaceFileError(400, 'invalid_path', 'Path must not contain a null byte.')
  }
  if (value.includes('\\')) {
    throw new WorkspaceFileError(400, 'invalid_path', 'Path must use forward slashes.')
  }
  if (value === '' && opts.allowRoot) return ''
  if (!value || value.startsWith('/')) {
    throw new WorkspaceFileError(400, 'invalid_path', 'Path must be relative to the project root.')
  }

  const segments = value.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new WorkspaceFileError(400, 'invalid_path', 'Path contains an invalid segment.')
  }

  const normalized = posix.normalize(value)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new WorkspaceFileError(400, 'invalid_path', 'Path escapes the project root.')
  }
  return normalized
}

function toWorkspaceEntry(relativePath: string, stats: Stats): WorkspaceEntry {
  const type = stats.isDirectory() ? 'directory' : 'file'
  return {
    modifiedAt: stats.mtime.toISOString(),
    name: relativePath ? basename(relativePath) : '',
    path: relativePath,
    size: type === 'file' ? stats.size : null,
    type,
  }
}

export class WorkspaceFileService {
  readonly maxFileBytes: number
  readonly rootPath: string
  readonly #readOnlyPaths: Set<string>
  readonly #writableDirectories: string[]

  private constructor(rootPath: string, opts: WorkspaceFileServiceOptions) {
    this.rootPath = rootPath
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_HTTP_FILE_BYTES
    this.#readOnlyPaths = new Set(
      (opts.readOnlyPaths ?? []).map((path) => normalizeRelativePath(path)),
    )
    this.#writableDirectories = (opts.writableDirectories ?? [])
      .map((path) => normalizeRelativePath(path))
      .sort()
  }

  static async create(
    rootPath: string,
    opts: WorkspaceFileServiceOptions = {},
  ): Promise<WorkspaceFileService> {
    const resolvedRootPath = await realpath(resolve(rootPath))
    const rootStats = await lstat(resolvedRootPath)
    if (!rootStats.isDirectory()) {
      throw new WorkspaceFileError(500, 'invalid_root', 'Workspace root is not a directory.')
    }
    return new WorkspaceFileService(resolvedRootPath, opts)
  }

  async list(path = ''): Promise<WorkspaceEntry[]> {
    const inspected = await this.#inspect(path, { allowRoot: true })
    if (!inspected.stats?.isDirectory()) {
      throw new WorkspaceFileError(409, 'not_a_directory', `Path "${inspected.relativePath}" is not a directory.`)
    }

    const entries = await readdir(inspected.absolutePath, { withFileTypes: true })
    const result: WorkspaceEntry[] = []
    for (const entry of entries) {
      if (entry.name.startsWith(TEMPORARY_FILE_PREFIX)) continue
      if (!entry.isDirectory() && !entry.isFile()) continue
      const childPath = inspected.relativePath
        ? posix.join(inspected.relativePath, entry.name)
        : entry.name
      try {
        const child = await this.#inspect(childPath)
        if (child.entry) result.push(child.entry)
      } catch (error) {
        if (error instanceof WorkspaceFileError && error.code === 'path_not_found') continue
        throw error
      }
    }

    return result.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name)
    })
  }

  async stat(path = ''): Promise<WorkspaceEntry> {
    const inspected = await this.#inspect(path, { allowRoot: true })
    return inspected.entry!
  }

  async getReadableFile(path: string): Promise<{ absolutePath: string, entry: WorkspaceEntry }> {
    const inspected = await this.#inspect(path)
    if (!inspected.stats?.isFile()) {
      throw new WorkspaceFileError(404, 'file_not_found', `File "${inspected.relativePath}" was not found.`)
    }
    return {
      absolutePath: inspected.absolutePath,
      entry: inspected.entry!,
    }
  }

  async getReadableDirectory(path = ''): Promise<{ absolutePath: string, entry: WorkspaceEntry }> {
    const inspected = await this.#inspect(path, { allowRoot: true })
    if (!inspected.stats?.isDirectory()) {
      throw new WorkspaceFileError(409, 'not_a_directory', `Path "${inspected.relativePath}" is not a directory.`)
    }
    return {
      absolutePath: inspected.absolutePath,
      entry: inspected.entry!,
    }
  }

  async createDirectory(path: string): Promise<{ created: boolean, entry: WorkspaceEntry }> {
    const relativePath = normalizeRelativePath(path)
    this.#assertWritable(relativePath)

    let currentPath = this.rootPath
    let currentRelativePath = ''
    let created = false
    for (const segment of relativePath.split('/')) {
      currentRelativePath = currentRelativePath ? posix.join(currentRelativePath, segment) : segment
      currentPath = resolve(currentPath, segment)

      let stats: Stats
      try {
        stats = await lstat(currentPath)
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
        try {
          await mkdir(currentPath)
          created = true
        } catch (mkdirError) {
          if (!isNodeError(mkdirError, 'EEXIST')) throw mkdirError
        }
        stats = await lstat(currentPath)
      }

      this.#assertSafeStats(stats, currentRelativePath)
      if (!stats.isDirectory()) {
        throw new WorkspaceFileError(409, 'path_conflict', `Path "${currentRelativePath}" is not a directory.`)
      }
    }

    return {
      created,
      entry: await this.stat(relativePath),
    }
  }

  async writeFile(
    path: string,
    source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  ): Promise<{ created: boolean, entry: WorkspaceEntry }> {
    const relativePath = normalizeRelativePath(path)
    this.#assertWritable(relativePath)

    const target = await this.#inspect(relativePath, { allowMissingLeaf: true })
    if (target.stats && !target.stats.isFile()) {
      throw new WorkspaceFileError(409, 'path_conflict', `Path "${relativePath}" is not a file.`)
    }

    const parentRelativePath = posix.dirname(relativePath) === '.' ? '' : posix.dirname(relativePath)
    const parent = await this.#inspect(parentRelativePath, { allowRoot: true })
    if (!parent.stats?.isDirectory()) {
      throw new WorkspaceFileError(409, 'not_a_directory', `Parent path "${parentRelativePath}" is not a directory.`)
    }

    const temporaryPath = resolve(
      dirname(target.absolutePath),
      `${TEMPORARY_FILE_PREFIX}${randomUUID()}`,
    )
    let handle: Awaited<ReturnType<typeof open>> | null = await open(temporaryPath, 'wx', 0o600)
    let totalBytes = 0

    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        totalBytes += buffer.length
        if (totalBytes > this.maxFileBytes) {
          throw new WorkspaceFileError(
            413,
            'file_too_large',
            `File exceeds the ${this.maxFileBytes} byte limit.`,
          )
        }
        await handle.write(buffer)
      }
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temporaryPath, target.absolutePath)
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }

    return {
      created: !target.exists,
      entry: await this.stat(relativePath),
    }
  }

  #assertWritable(relativePath: string): void {
    const writable = this.#writableDirectories.some(
      (directory) => relativePath.startsWith(`${directory}/`),
    )
    const readOnly = [...this.#readOnlyPaths].some(
      (path) => relativePath === path || relativePath.startsWith(`${path}/`),
    )
    if (!writable || readOnly) {
      throw new WorkspaceFileError(403, 'path_is_read_only', `Path "${relativePath}" is read-only.`)
    }
  }

  #assertSafeStats(stats: Stats, relativePath: string): void {
    if (stats.isSymbolicLink()) {
      throw new WorkspaceFileError(409, 'symlink_not_allowed', `Symbolic links are not supported at "${relativePath}".`)
    }
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new WorkspaceFileError(409, 'unsupported_entry', `Path "${relativePath}" is not a regular file or directory.`)
    }
  }

  async #inspect(
    path: string,
    opts: { allowMissingLeaf?: boolean, allowRoot?: boolean } = {},
  ): Promise<InspectedPath> {
    const relativePath = normalizeRelativePath(path, { allowRoot: opts.allowRoot })
    if (relativePath === '') {
      const stats = await lstat(this.rootPath)
      this.#assertSafeStats(stats, '')
      return {
        absolutePath: this.rootPath,
        entry: toWorkspaceEntry('', stats),
        exists: true,
        relativePath,
        stats,
      }
    }

    let currentPath = this.rootPath
    const segments = relativePath.split('/')
    for (const [index, segment] of segments.entries()) {
      currentPath = resolve(currentPath, segment)
      if (currentPath !== this.rootPath && !currentPath.startsWith(`${this.rootPath}${sep}`)) {
        throw new WorkspaceFileError(400, 'invalid_path', 'Path escapes the project root.')
      }

      let stats: Stats
      try {
        stats = await lstat(currentPath)
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
          if (opts.allowMissingLeaf && index === segments.length - 1) {
            return {
              absolutePath: currentPath,
              entry: null,
              exists: false,
              relativePath,
              stats: null,
            }
          }
          throw new WorkspaceFileError(404, 'path_not_found', `Path "${relativePath}" was not found.`)
        }
        throw error
      }

      this.#assertSafeStats(stats, segments.slice(0, index + 1).join('/'))
      if (index < segments.length - 1 && !stats.isDirectory()) {
        throw new WorkspaceFileError(409, 'path_conflict', `Path "${segments.slice(0, index + 1).join('/')}" is not a directory.`)
      }
      if (index === segments.length - 1) {
        return {
          absolutePath: currentPath,
          entry: toWorkspaceEntry(relativePath, stats),
          exists: true,
          relativePath,
          stats,
        }
      }
    }

    throw new WorkspaceFileError(500, 'invalid_path', 'Could not resolve workspace path.')
  }
}
