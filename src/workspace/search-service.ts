import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { Bash, ReadWriteFs } from 'just-bash'
import { WorkspaceFileError, type WorkspaceFileService } from './file-service.js'

export const DEFAULT_HTTP_SEARCH_LIMIT = 100
export const MAX_HTTP_SEARCH_LIMIT = 500
export const MAX_HTTP_SEARCH_QUERY_BYTES = 512
export const MAX_HTTP_SEARCH_GLOBS = 20
export const MAX_HTTP_SEARCH_GLOB_BYTES = 256

const DEFAULT_HTTP_SEARCH_TIMEOUT_MS = 3_000
const DEFAULT_HTTP_SEARCH_OUTPUT_BYTES = 1024 * 1024
const TEMPORARY_FILE_GLOBS = ['!.docs-ssh-upload-*', '!**/.docs-ssh-upload-*']

export type WorkspaceSearchCase = 'insensitive' | 'sensitive' | 'smart'
export type WorkspaceSearchMode = 'literal' | 'regex'

export interface WorkspaceSearchInput {
  caseSensitivity?: string
  globs?: string[]
  limit?: number
  mode?: string
  path?: string
  query: string
}

export interface WorkspaceSearchSubmatch {
  end: number
  start: number
  text: string
}

export interface WorkspaceSearchMatch {
  line: number
  path: string
  submatches: WorkspaceSearchSubmatch[]
  text: string
}

export interface WorkspaceSearchResult {
  caseSensitivity: WorkspaceSearchCase
  limit: number
  matches: WorkspaceSearchMatch[]
  mode: WorkspaceSearchMode
  path: string
  query: string
  truncated: boolean
}

export interface WorkspaceSearchProvider {
  search(input: WorkspaceSearchInput): Promise<WorkspaceSearchResult>
}

interface NormalizedWorkspaceSearchInput {
  caseSensitivity: WorkspaceSearchCase
  globs: string[]
  limit: number
  mode: WorkspaceSearchMode
  path: string
  query: string
}

interface RgJsonMatchEvent {
  data: {
    line_number: number
    lines: { text: string }
    path: { text: string }
    submatches: Array<{
      end: number
      match: { text: string }
      start: number
    }>
  }
  type: 'match'
}

interface RgWorkspaceSearchProviderOptions {
  maxOutputBytes?: number
  maxResults?: number
  timeoutMs?: number
}

function normalizeSearchInput(
  input: WorkspaceSearchInput,
  maxResults: number,
): NormalizedWorkspaceSearchInput {
  if (!input.query || input.query.includes('\0')) {
    throw new WorkspaceFileError(400, 'invalid_query', 'Search query must not be empty.')
  }
  if (Buffer.byteLength(input.query, 'utf8') > MAX_HTTP_SEARCH_QUERY_BYTES) {
    throw new WorkspaceFileError(
      400,
      'invalid_query',
      `Search query exceeds ${MAX_HTTP_SEARCH_QUERY_BYTES} bytes.`,
    )
  }

  const mode = input.mode ?? 'literal'
  if (mode !== 'literal' && mode !== 'regex') {
    throw new WorkspaceFileError(400, 'invalid_mode', 'Search mode must be "literal" or "regex".')
  }

  const caseSensitivity = input.caseSensitivity ?? 'smart'
  if (
    caseSensitivity !== 'smart'
    && caseSensitivity !== 'sensitive'
    && caseSensitivity !== 'insensitive'
  ) {
    throw new WorkspaceFileError(
      400,
      'invalid_case',
      'Search case must be "smart", "sensitive", or "insensitive".',
    )
  }

  const limit = input.limit ?? Math.min(DEFAULT_HTTP_SEARCH_LIMIT, maxResults)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxResults) {
    throw new WorkspaceFileError(
      400,
      'invalid_limit',
      `Search limit must be an integer from 1 to ${maxResults}.`,
    )
  }

  const globs = input.globs ?? []
  if (globs.length > MAX_HTTP_SEARCH_GLOBS) {
    throw new WorkspaceFileError(
      400,
      'invalid_glob',
      `Search accepts at most ${MAX_HTTP_SEARCH_GLOBS} glob filters.`,
    )
  }
  for (const glob of globs) {
    if (!glob || glob.includes('\0') || Buffer.byteLength(glob, 'utf8') > MAX_HTTP_SEARCH_GLOB_BYTES) {
      throw new WorkspaceFileError(
        400,
        'invalid_glob',
        `Each search glob must contain 1 to ${MAX_HTTP_SEARCH_GLOB_BYTES} bytes.`,
      )
    }
  }

  return {
    caseSensitivity,
    globs,
    limit,
    mode,
    path: input.path ?? '',
    query: input.query,
  }
}

function isRgJsonMatchEvent(value: unknown): value is RgJsonMatchEvent {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'match') return false
  if (!('data' in value) || !value.data || typeof value.data !== 'object') return false
  const data = value.data as Record<string, unknown>
  if (!data.path || typeof data.path !== 'object' || typeof (data.path as { text?: unknown }).text !== 'string') {
    return false
  }
  if (!data.lines || typeof data.lines !== 'object' || typeof (data.lines as { text?: unknown }).text !== 'string') {
    return false
  }
  if (!Number.isSafeInteger(data.line_number) || (data.line_number as number) < 1) return false
  if (!Array.isArray(data.submatches)) return false
  return data.submatches.every((submatch) => {
    if (!submatch || typeof submatch !== 'object') return false
    const candidate = submatch as Record<string, unknown>
    if (!Number.isSafeInteger(candidate.start) || !Number.isSafeInteger(candidate.end)) return false
    if ((candidate.start as number) < 0 || (candidate.end as number) < (candidate.start as number)) return false
    return Boolean(
      candidate.match
      && typeof candidate.match === 'object'
      && typeof (candidate.match as { text?: unknown }).text === 'string',
    )
  })
}

function toWorkspaceMatchPath(searchPath: string, rgPath: string): string {
  const relativePath = rgPath.replace(/^\.\//u, '')
  const segments = relativePath.split('/')
  if (
    !relativePath
    || relativePath.startsWith('/')
    || relativePath.includes('\\')
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new WorkspaceFileError(500, 'invalid_search_result', 'Search returned an invalid file path.')
  }
  return searchPath ? posix.join(searchPath, relativePath) : relativePath
}

function parseRgMatches(stdout: string, path: string, limit: number) {
  const matches: WorkspaceSearchMatch[] = []
  let truncated = false

  for (const line of stdout.split('\n')) {
    if (!line) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new WorkspaceFileError(500, 'invalid_search_result', 'Search returned invalid JSON output.')
    }
    if (!event || typeof event !== 'object' || !('type' in event) || event.type !== 'match') continue
    if (!isRgJsonMatchEvent(event)) {
      throw new WorkspaceFileError(500, 'invalid_search_result', 'Search returned an invalid match event.')
    }
    if (matches.length >= limit) {
      truncated = true
      continue
    }

    matches.push({
      line: event.data.line_number,
      path: toWorkspaceMatchPath(path, event.data.path.text),
      submatches: event.data.submatches.map((submatch) => ({
        end: submatch.end,
        start: submatch.start,
        text: submatch.match.text,
      })),
      text: event.data.lines.text.replace(/\r?\n$/u, ''),
    })
  }

  return { matches, truncated }
}

export class RgWorkspaceSearchProvider implements WorkspaceSearchProvider {
  readonly #fileService: WorkspaceFileService
  readonly #maxOutputBytes: number
  readonly #maxResults: number
  readonly #timeoutMs: number

  constructor(
    fileService: WorkspaceFileService,
    opts: RgWorkspaceSearchProviderOptions = {},
  ) {
    this.#fileService = fileService
    this.#maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_HTTP_SEARCH_OUTPUT_BYTES
    this.#maxResults = opts.maxResults ?? MAX_HTTP_SEARCH_LIMIT
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_SEARCH_TIMEOUT_MS
  }

  async search(input: WorkspaceSearchInput): Promise<WorkspaceSearchResult> {
    const normalized = normalizeSearchInput(input, this.#maxResults)
    const directory = await this.#fileService.getReadableDirectory(normalized.path)
    const bash = new Bash({
      commands: ['rg'],
      cwd: '/',
      defenseInDepth: true,
      executionLimits: {
        maxArrayElements: 20_000,
        maxCommandCount: 10,
        maxFileDescriptors: 256,
        maxGlobOperations: 20_000,
        maxOutputSize: this.#maxOutputBytes,
        maxStringLength: this.#maxOutputBytes,
      },
      fs: new ReadWriteFs({ root: directory.absolutePath }),
    })
    const args = [
      '--json',
      '--sort',
      'path',
      '--hidden',
      '--no-ignore',
      '--max-count',
      String(normalized.limit + 1),
    ]
    if (normalized.mode === 'literal') args.push('--fixed-strings')
    switch (normalized.caseSensitivity) {
      case 'insensitive':
        args.push('--ignore-case')
        break
      case 'sensitive':
        args.push('--case-sensitive')
        break
      case 'smart':
        args.push('--smart-case')
        break
    }
    for (const glob of normalized.globs) args.push('--glob', glob)
    for (const glob of TEMPORARY_FILE_GLOBS) args.push('--glob', glob)
    args.push('--regexp', normalized.query, '.')

    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), this.#timeoutMs)
    let result: Awaited<ReturnType<Bash['exec']>>
    try {
      result = await bash.exec('rg', { args, signal: abortController.signal })
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new WorkspaceFileError(503, 'search_timeout', 'Search exceeded its execution time limit.')
      }
      const message = error instanceof Error ? error.message : String(error)
      if (/output.*(?:limit|exceed)/iu.test(message)) {
        throw new WorkspaceFileError(413, 'search_output_too_large', 'Search output exceeded its size limit.')
      }
      throw new WorkspaceFileError(500, 'search_failed', 'Search could not be completed.')
    } finally {
      clearTimeout(timeout)
    }

    if (abortController.signal.aborted) {
      throw new WorkspaceFileError(503, 'search_timeout', 'Search exceeded its execution time limit.')
    }
    if (result.exitCode !== 0 && !(result.exitCode === 1 && !result.stderr)) {
      if (/output.*(?:limit|exceed)/iu.test(result.stderr)) {
        throw new WorkspaceFileError(413, 'search_output_too_large', 'Search output exceeded its size limit.')
      }
      if (/invalid regex/iu.test(result.stderr)) {
        throw new WorkspaceFileError(400, 'invalid_pattern', 'Search pattern is not a valid regular expression.')
      }
      if (/glob/iu.test(result.stderr)) {
        throw new WorkspaceFileError(400, 'invalid_glob', 'Search glob is invalid.')
      }
      throw new WorkspaceFileError(500, 'search_failed', 'Search could not be completed.')
    }

    const parsed = parseRgMatches(result.stdout, normalized.path, normalized.limit)
    return {
      caseSensitivity: normalized.caseSensitivity,
      limit: normalized.limit,
      matches: parsed.matches,
      mode: normalized.mode,
      path: normalized.path,
      query: normalized.query,
      truncated: parsed.truncated,
    }
  }
}
