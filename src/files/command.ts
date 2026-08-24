import { Buffer } from 'node:buffer'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { findProjectConfig } from '../project-config.js'
import type { WorkspaceEntry } from '../workspace/file-service.js'
import type {
  WorkspaceSearchCase,
  WorkspaceSearchMatch,
  WorkspaceSearchMode,
} from '../workspace/search-service.js'

interface WritableOutput {
  write(chunk: string | Uint8Array): unknown
}

interface FilesCommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
  stdin?: AsyncIterable<string | Uint8Array>
  stderr?: WritableOutput
  stdout?: WritableOutput
}

interface ParsedFilesArgs {
  flags: Map<string, string[]>
  positionals: string[]
  switches: Set<string>
}

interface FilesCommandConfig {
  project: string
  token: string
  viewerOrigin: string
}

interface EntryPayload {
  entry: WorkspaceEntry
  project: string
}

interface EntriesPayload {
  entries: WorkspaceEntry[]
  path: string
  project: string
}

interface SearchPayload {
  case: WorkspaceSearchCase
  limit: number
  matches: WorkspaceSearchMatch[]
  mode: WorkspaceSearchMode
  path: string
  project: string
  query: string
  truncated: boolean
}

const VALUE_FLAGS = new Set([
  'case',
  'glob',
  'input',
  'limit',
  'mode',
  'output',
  'path',
  'project',
  'viewer-origin',
])

const SWITCH_FLAGS = new Set(['force', 'help', 'json'])
const COMMON_FLAGS = ['project', 'viewer-origin']

function usage(): string {
  return `docs-ssh files

Usage:
  docs-ssh files list [path] [--json] [--project <slug>] [--viewer-origin <url>]
  docs-ssh files stat [path] [--json] [--project <slug>] [--viewer-origin <url>]
  docs-ssh files search <query> [--path <path>] [--glob <glob>]... [--limit <n>] [--mode literal|regex] [--case smart|sensitive|insensitive] [--json]
  docs-ssh files read <path> [--output <local-path>] [--force] [--project <slug>] [--viewer-origin <url>]
  docs-ssh files write <path> --input <local-path|-> [--json] [--project <slug>] [--viewer-origin <url>]
  docs-ssh files mkdir <path> [--json] [--project <slug>] [--viewer-origin <url>]

Configuration is read from the nearest .docs-ssh.toml. DOCS_SSH_TOKEN must contain
the project API token. Use --project and --viewer-origin to override the file.
`
}

function addFlag(flags: Map<string, string[]>, name: string, value: string): void {
  const values = flags.get(name) ?? []
  values.push(value)
  flags.set(name, values)
}

function parseFilesArgs(argv: string[]): ParsedFilesArgs {
  const parsed: ParsedFilesArgs = {
    flags: new Map(),
    positionals: [],
    switches: new Set(),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') {
      parsed.positionals.push(...argv.slice(index + 1))
      break
    }
    if (argument === '-h') {
      parsed.switches.add('help')
      continue
    }
    if (!argument.startsWith('--')) {
      parsed.positionals.push(argument)
      continue
    }

    const separator = argument.indexOf('=')
    const name = argument.slice(2, separator === -1 ? undefined : separator)
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1)

    if (SWITCH_FLAGS.has(name)) {
      if (inlineValue !== undefined) throw new Error(`--${name} does not accept a value.`)
      parsed.switches.add(name)
      continue
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown flag --${name}.`)

    const value = inlineValue ?? argv[index + 1]
    if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) {
      throw new Error(`--${name} requires a value.`)
    }
    addFlag(parsed.flags, name, value)
    if (inlineValue === undefined) index += 1
  }

  return parsed
}

function assertAllowedFlags(parsed: ParsedFilesArgs, allowed: string[]): void {
  const allowedSet = new Set([...allowed, 'help'])
  for (const name of [...parsed.flags.keys(), ...parsed.switches]) {
    if (!allowedSet.has(name)) throw new Error(`Unknown flag --${name}.`)
  }
}

function getFlagValues(parsed: ParsedFilesArgs, name: string): string[] {
  return parsed.flags.get(name) ?? []
}

function getFlagString(parsed: ParsedFilesArgs, name: string): string | undefined {
  const values = getFlagValues(parsed, name)
  if (values.length > 1) throw new Error(`--${name} may only be specified once.`)
  return values[0]
}

function getOptionalInteger(parsed: ParsedFilesArgs, name: string): number | undefined {
  const value = getFlagString(parsed, name)
  if (value === undefined) return undefined
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new Error(`--${name} must be an integer.`)
  return result
}

function assertPositionalCount(
  parsed: ParsedFilesArgs,
  command: string,
  minimum: number,
  maximum: number,
): void {
  if (parsed.positionals.length < minimum) {
    throw new Error(`${command} requires ${minimum === 1 ? 'an argument' : `${minimum} arguments`}.`)
  }
  if (parsed.positionals.length > maximum) {
    throw new Error(`${command} accepts at most ${maximum === 1 ? 'one argument' : `${maximum} arguments`}.`)
  }
}

function normalizeViewerOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid viewer origin: ${value}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Viewer origin must use http or https.')
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Viewer origin must be an origin without credentials, a path, a query, or a fragment.')
  }
  return url.origin
}

async function resolveFilesCommandConfig(
  parsed: ParsedFilesArgs,
  options: FilesCommandOptions,
): Promise<FilesCommandConfig> {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const projectConfig = await findProjectConfig(cwd)
  const project = getFlagString(parsed, 'project') ?? projectConfig?.project
  const viewerOrigin = getFlagString(parsed, 'viewer-origin')
    ?? projectConfig?.viewerOrigin
    ?? env.DOCS_SSH_VIEWER_ORIGIN
  const token = env.DOCS_SSH_TOKEN?.trim()

  if (!project) {
    throw new Error('Project is not configured. Add project to .docs-ssh.toml or pass --project.')
  }
  if (!viewerOrigin) {
    throw new Error('Viewer origin is not configured. Add viewer_origin to .docs-ssh.toml or pass --viewer-origin.')
  }
  if (!token) {
    throw new Error('DOCS_SSH_TOKEN is required for HTTP file access.')
  }

  return {
    project,
    token,
    viewerOrigin: normalizeViewerOrigin(viewerOrigin),
  }
}

function createProjectUrl(config: FilesCommandConfig, suffix: string): URL {
  return new URL(
    `/api/v1/projects/${encodeURIComponent(config.project)}/${suffix}`,
    `${config.viewerOrigin}/`,
  )
}

function getErrorDetails(payload: unknown): { code?: string, message?: string } {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return {}
  const error = payload.error
  if (typeof error === 'string') return { message: error }
  if (!error || typeof error !== 'object') return {}
  return {
    code: 'code' in error && typeof error.code === 'string' ? error.code : undefined,
    message: 'message' in error && typeof error.message === 'string' ? error.message : undefined,
  }
}

async function throwResponseError(response: Response): Promise<never> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  const details = getErrorDetails(payload)
  const code = details.code ? ` ${details.code}` : ''
  const message = details.message ? `: ${details.message}` : ''
  throw new Error(`HTTP ${response.status}${code}${message}`)
}

async function request(
  config: FilesCommandConfig,
  url: URL,
  options: FilesCommandOptions,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${config.token}`)
  const fetchImplementation = options.fetch ?? globalThis.fetch

  let response: Response
  try {
    response = await fetchImplementation(url, { ...init, headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not reach ${config.viewerOrigin}: ${message}`)
  }
  if (!response.ok) await throwResponseError(response)
  return response
}

async function requestJson<T>(
  config: FilesCommandConfig,
  url: URL,
  options: FilesCommandOptions,
  init: RequestInit = {},
): Promise<T> {
  const response = await request(config, url, options, init)
  try {
    return await response.json() as T
  } catch {
    throw new Error(`HTTP ${response.status}: Server returned invalid JSON.`)
  }
}

function writeJson(output: WritableOutput, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`)
}

function formatEntry(entry: WorkspaceEntry): string {
  const type = entry.type === 'directory' ? 'dir' : 'file'
  const size = entry.size === null ? '-' : String(entry.size)
  return `${type}\t${size}\t${entry.path || '.'}`
}

async function readStdin(input: AsyncIterable<string | Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of input) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export async function runFilesCommand(
  argv: string[],
  options: FilesCommandOptions = {},
): Promise<void> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    stdout.write(usage())
    return
  }

  const subcommand = argv[0]
  const parsed = parseFilesArgs(argv.slice(1))
  if (parsed.switches.has('help')) {
    stdout.write(usage())
    return
  }

  if (subcommand === 'list') {
    assertAllowedFlags(parsed, [...COMMON_FLAGS, 'json'])
    assertPositionalCount(parsed, 'list', 0, 1)
    const config = await resolveFilesCommandConfig(parsed, options)
    const url = createProjectUrl(config, 'entries')
    const path = parsed.positionals[0] ?? ''
    if (path) url.searchParams.set('path', path)
    const result = await requestJson<EntriesPayload>(config, url, options)
    if (parsed.switches.has('json')) writeJson(stdout, result)
    else if (result.entries.length === 0) stdout.write('No entries.\n')
    else stdout.write(`${result.entries.map(formatEntry).join('\n')}\n`)
    return
  }

  if (subcommand === 'stat') {
    assertAllowedFlags(parsed, [...COMMON_FLAGS, 'json'])
    assertPositionalCount(parsed, 'stat', 0, 1)
    const config = await resolveFilesCommandConfig(parsed, options)
    const url = createProjectUrl(config, 'stat')
    const path = parsed.positionals[0] ?? ''
    if (path) url.searchParams.set('path', path)
    const result = await requestJson<EntryPayload>(config, url, options)
    if (parsed.switches.has('json')) writeJson(stdout, result)
    else stdout.write(`${formatEntry(result.entry)}\n`)
    return
  }

  if (subcommand === 'search') {
    assertAllowedFlags(parsed, [
      ...COMMON_FLAGS,
      'case',
      'glob',
      'json',
      'limit',
      'mode',
      'path',
    ])
    assertPositionalCount(parsed, 'search', 1, 1)
    const path = getFlagString(parsed, 'path')
    const limit = getOptionalInteger(parsed, 'limit')
    const mode = getFlagString(parsed, 'mode')
    const caseSensitivity = getFlagString(parsed, 'case')
    if (mode !== undefined && mode !== 'literal' && mode !== 'regex') {
      throw new Error('--mode must be literal or regex.')
    }
    if (
      caseSensitivity !== undefined
      && caseSensitivity !== 'smart'
      && caseSensitivity !== 'sensitive'
      && caseSensitivity !== 'insensitive'
    ) {
      throw new Error('--case must be smart, sensitive, or insensitive.')
    }
    const config = await resolveFilesCommandConfig(parsed, options)
    const url = createProjectUrl(config, 'search')
    url.searchParams.set('q', parsed.positionals[0])
    if (path !== undefined) url.searchParams.set('path', path)
    if (limit !== undefined) url.searchParams.set('limit', String(limit))
    if (mode !== undefined) url.searchParams.set('mode', mode)
    if (caseSensitivity !== undefined) url.searchParams.set('case', caseSensitivity)
    for (const glob of getFlagValues(parsed, 'glob')) url.searchParams.append('glob', glob)

    const result = await requestJson<SearchPayload>(config, url, options)
    if (parsed.switches.has('json')) writeJson(stdout, result)
    else if (result.matches.length > 0) {
      stdout.write(`${result.matches.map((match) => `${match.path}:${match.line}:${match.text}`).join('\n')}\n`)
    }
    if (result.truncated && !parsed.switches.has('json')) {
      stderr.write(`docs-ssh files: results truncated at ${result.limit} matches.\n`)
    }
    return
  }

  if (subcommand === 'read') {
    assertAllowedFlags(parsed, [...COMMON_FLAGS, 'force', 'output'])
    assertPositionalCount(parsed, 'read', 1, 1)
    const outputPath = getFlagString(parsed, 'output')
    if (parsed.switches.has('force') && (!outputPath || outputPath === '-')) {
      throw new Error('--force requires --output <local-path>.')
    }
    const config = await resolveFilesCommandConfig(parsed, options)
    const url = createProjectUrl(config, `files/${encodeURIComponent(parsed.positionals[0])}`)
    const response = await request(config, url, options)
    const content = Buffer.from(await response.arrayBuffer())
    if (!outputPath || outputPath === '-') {
      stdout.write(content)
      return
    }

    const resolvedOutputPath = resolve(options.cwd ?? process.cwd(), outputPath)
    try {
      await writeFile(resolvedOutputPath, content, {
        flag: parsed.switches.has('force') ? 'w' : 'wx',
      })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw new Error(`Output file already exists: ${resolvedOutputPath}. Pass --force to replace it.`)
      }
      throw error
    }
    stdout.write(`Wrote ${content.length} bytes to ${resolvedOutputPath}.\n`)
    return
  }

  if (subcommand === 'write') {
    assertAllowedFlags(parsed, [...COMMON_FLAGS, 'input', 'json'])
    assertPositionalCount(parsed, 'write', 1, 1)
    const inputPath = getFlagString(parsed, 'input')
    if (!inputPath) throw new Error('write requires --input <local-path|->.')
    const config = await resolveFilesCommandConfig(parsed, options)
    const content = inputPath === '-'
      ? await readStdin(options.stdin ?? process.stdin)
      : await readFile(resolve(options.cwd ?? process.cwd(), inputPath))
    const url = createProjectUrl(config, `files/${encodeURIComponent(parsed.positionals[0])}`)
    const result = await requestJson<EntryPayload>(config, url, options, {
      body: new Uint8Array(content),
      headers: { 'Content-Type': 'application/octet-stream' },
      method: 'PUT',
    })
    if (parsed.switches.has('json')) writeJson(stdout, result)
    else stdout.write(`Wrote ${result.entry.path} (${result.entry.size ?? content.length} bytes).\n`)
    return
  }

  if (subcommand === 'mkdir') {
    assertAllowedFlags(parsed, [...COMMON_FLAGS, 'json'])
    assertPositionalCount(parsed, 'mkdir', 1, 1)
    const config = await resolveFilesCommandConfig(parsed, options)
    const url = createProjectUrl(config, 'directories')
    const result = await requestJson<EntryPayload>(config, url, options, {
      body: JSON.stringify({ path: parsed.positionals[0] }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    if (parsed.switches.has('json')) writeJson(stdout, result)
    else stdout.write(`Directory ready: ${result.entry.path}.\n`)
    return
  }

  throw new Error(`Unknown files subcommand: ${subcommand}.`)
}
