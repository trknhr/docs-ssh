import { execFile } from 'node:child_process'
import { access, appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  addSourceToRegistry,
  createEmptyRegistry,
  createFallbackRegistry,
  createSourceSpec,
  makeRootPathPortable,
  getSourceMountPath,
  getStatePaths,
  normalizeSourceName,
  readSourceRegistry,
  writeSourceRegistry,
  loadSourceStore,
} from './sources/source-store.js'
import type { SourceRegistry, SourceSpec } from './sources/types.js'
import { getGitRepoPreset } from './ingest/presets.js'
import {
  createAgentsMarkdown,
  createSetupMarkdown,
  createSkillMarkdown,
} from './shell/helper-content.js'

const execFileAsync = promisify(execFile)

interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | boolean>
}

function printUsage(): void {
  console.log(`docs-ssh CLI

Usage:
  docs-ssh ingest local-folder <path> [--name <name>] [--default]
  docs-ssh ingest git-repo <repo-url> [--name <name>] [--subdir <path>] [--ref <ref>] [--default]
  docs-ssh ingest <preset> [--name <name>] [--default]
  docs-ssh sources list
  docs-ssh helper agents [--output <path>] [--append]
  docs-ssh helper skill [--output <path>]
  docs-ssh helper setup [--output <path>]

Initial presets:
  github
  supabase
  neon
  cloudflare
`)
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | boolean>()

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--') continue
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }

    const key = token.slice(2)
    const next = argv[index + 1]

    if (!next || next.startsWith('--')) {
      flags.set(key, true)
      continue
    }

    flags.set(key, next)
    index += 1
  }

  return { positionals, flags }
}

function getFlagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

function getFlagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true
}

function deriveRepoName(repoUrl: string): string {
  return basename(repoUrl).replace(/\.git$/u, '')
}

async function ensureDirectoryExists(path: string, label: string): Promise<void> {
  const info = await stat(path).catch(() => null)
  if (!info || !info.isDirectory()) {
    throw new Error(`${label} must be an existing directory: ${path}`)
  }
}

function resolveSubdirPath(rootPath: string, subdir?: string): string {
  if (!subdir) return rootPath

  const resolvedPath = resolve(rootPath, subdir)
  const relativePath = relative(rootPath, resolvedPath)

  if (relativePath.startsWith('..') || relativePath === '') {
    throw new Error(`subdir must stay within the source root: ${subdir}`)
  }

  return resolvedPath
}

async function loadWritableRegistry(registryPath: string): Promise<SourceRegistry> {
  const existing = await readSourceRegistry(registryPath)
  return existing ?? createEmptyRegistry()
}

function printIngestSummary(source: SourceSpec, makeDefault: boolean): void {
  console.log(`Ingested source "${source.name}"`)
  console.log(`- type: ${source.type}`)
  console.log(`- root: ${source.rootPath}`)
  console.log(`- mount: ${getSourceMountPath(source.name)}`)
  if (makeDefault) console.log('- alias: /docs')
  if (source.repoUrl) console.log(`- repo: ${source.repoUrl}`)
  if (source.subdir) console.log(`- subdir: ${source.subdir}`)
  console.log('')
  console.log('New exec commands and new SSH sessions will see the updated registry immediately.')
}

async function ingestLocalFolder(args: ParsedArgs): Promise<void> {
  const sourcePathArg = args.positionals[2]
  if (!sourcePathArg) throw new Error('Missing required path for local-folder ingest.')

  const sourcePath = resolve(sourcePathArg)
  await ensureDirectoryExists(sourcePath, 'Source path')

  const statePaths = getStatePaths(getFlagString(args, 'state-dir'))
  const registry = await loadWritableRegistry(statePaths.registryPath)
  const name = normalizeSourceName(getFlagString(args, 'name') ?? basename(sourcePath))
  const makeDefault = getFlagBoolean(args, 'default') || registry.sources.length === 0

  const source = createSourceSpec({
    name,
    type: 'local-folder',
    rootPath: makeRootPathPortable(statePaths.registryPath, sourcePath),
  })

  const nextRegistry = addSourceToRegistry(registry, source, { makeDefault })
  await writeSourceRegistry(statePaths.registryPath, nextRegistry)
  printIngestSummary(source, makeDefault)
}

async function ingestGitRepoFromConfig(config: {
  repoUrl: string
  name: string
  subdir?: string
  ref?: string
  makeDefault: boolean
  stateDir?: string
}): Promise<void> {
  const statePaths = getStatePaths(config.stateDir)
  const registry = await loadWritableRegistry(statePaths.registryPath)
  const name = normalizeSourceName(config.name)
  const targetRoot = resolve(statePaths.sourcesDir, name)
  const checkoutRoot = resolve(targetRoot, 'repo')

  if (registry.sources.some((source) => source.name === name)) {
    throw new Error(`Source "${name}" already exists in the registry.`)
  }

  await access(targetRoot).then(
    () => {
      throw new Error(`Managed source directory already exists: ${targetRoot}`)
    },
    () => undefined,
  )

  await mkdir(targetRoot, { recursive: true })

  const cloneArgs = ['clone', '--depth', '1']
  if (config.ref) cloneArgs.push('--branch', config.ref)
  cloneArgs.push(config.repoUrl, checkoutRoot)

  try {
    await execFileAsync('git', cloneArgs)
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr.trim()
        : ''
    throw new Error(stderr ? `git clone failed: ${stderr}` : 'git clone failed.')
  }

  const mountedRoot = resolveSubdirPath(checkoutRoot, config.subdir)
  await ensureDirectoryExists(mountedRoot, 'Mounted repo path')

  const source = createSourceSpec({
    name,
    type: 'git-repo',
    rootPath: makeRootPathPortable(statePaths.registryPath, mountedRoot),
    managed: true,
    repoUrl: config.repoUrl,
    ref: config.ref,
    subdir: config.subdir,
  })

  const nextRegistry = addSourceToRegistry(registry, source, {
    makeDefault: config.makeDefault,
  })
  await writeSourceRegistry(statePaths.registryPath, nextRegistry)
  printIngestSummary(source, config.makeDefault)
}

async function ingestGitRepo(args: ParsedArgs): Promise<void> {
  const repoUrl = args.positionals[2]
  if (!repoUrl) throw new Error('Missing required repo URL for git-repo ingest.')

  const name = getFlagString(args, 'name') ?? deriveRepoName(repoUrl)
  await ingestGitRepoFromConfig({
    repoUrl,
    name,
    ref: getFlagString(args, 'ref'),
    subdir: getFlagString(args, 'subdir'),
    makeDefault: getFlagBoolean(args, 'default'),
    stateDir: getFlagString(args, 'state-dir'),
  })
}

async function ingestPreset(presetName: string, args: ParsedArgs): Promise<void> {
  const preset = getGitRepoPreset(presetName)
  if (!preset) throw new Error(`Unknown ingest target: ${presetName}`)

  await ingestGitRepoFromConfig({
    repoUrl: preset.repoUrl,
    name: getFlagString(args, 'name') ?? preset.name,
    subdir: preset.subdir,
    makeDefault: getFlagBoolean(args, 'default'),
    stateDir: getFlagString(args, 'state-dir'),
  })
}

async function listSources(args: ParsedArgs): Promise<void> {
  const statePaths = getStatePaths(getFlagString(args, 'state-dir'))
  const registry = (await readSourceRegistry(statePaths.registryPath)) ?? createFallbackRegistry(resolve('./docs'))

  console.log(`Registry: ${statePaths.registryPath}`)
  console.log('')

  for (const source of registry.sources) {
    const defaultMark = source.name === registry.defaultSourceName ? ' (default -> /docs)' : ''
    console.log(`- ${source.name}${defaultMark}`)
    console.log(`  type: ${source.type}`)
    console.log(`  root: ${source.rootPath}`)
    console.log(`  mount: ${getSourceMountPath(source.name)}`)
  }
}

type HelperTarget = 'agents' | 'setup' | 'skill'

async function loadHelperOptions(args: ParsedArgs) {
  const statePaths = getStatePaths(getFlagString(args, 'state-dir'))
  const docsDir = resolve(getFlagString(args, 'docs-dir') ?? process.env.DOCS_DIR ?? './docs')
  const docsName = getFlagString(args, 'docs-name') ?? process.env.DOCS_NAME ?? 'Documentation'
  const workspaceDir = resolve(
    getFlagString(args, 'workspace-dir') ?? process.env.WORKSPACE_DIR ?? `${statePaths.stateDir}/workspace`,
  )
  const sourceStore = await loadSourceStore({
    registryPath: statePaths.registryPath,
    fallbackDocsDir: docsDir,
    workspaceDir,
  })
  const sshHost = getFlagString(args, 'ssh-host') ?? process.env.SSH_CONNECT_HOST ?? process.env.SSH_HOST ?? '127.0.0.1'
  const sshPortValue =
    getFlagString(args, 'ssh-port') ??
    process.env.SSH_CONNECT_PORT ??
    process.env.SSH_PORT ??
    process.env.PORT ??
    '2222'
  const sshPort = parseInt(sshPortValue, 10)

  if (Number.isNaN(sshPort)) {
    throw new Error(`Invalid ssh port: ${sshPortValue}`)
  }

  return {
    docsName,
    sourceStore,
    sshHost,
    sshPort,
  }
}

function renderHelperMarkdown(target: HelperTarget, args: ParsedArgs): Promise<string> {
  return loadHelperOptions(args).then((options) => {
    switch (target) {
      case 'agents':
        return createAgentsMarkdown(options)
      case 'setup':
        return createSetupMarkdown(options)
      case 'skill':
        return createSkillMarkdown(options)
    }
  })
}

async function writeHelperOutput(path: string, content: string, append: boolean): Promise<void> {
  const resolvedPath = resolve(path)
  await mkdir(dirname(resolvedPath), { recursive: true })
  if (append) {
    await appendFile(resolvedPath, content)
    return
  }
  await writeFile(resolvedPath, content)
}

async function outputHelper(target: HelperTarget, args: ParsedArgs): Promise<void> {
  const append = getFlagBoolean(args, 'append')
  const outputPath = getFlagString(args, 'output')
  const content = await renderHelperMarkdown(target, args)

  if (!outputPath) {
    if (append) {
      throw new Error('--append requires --output.')
    }
    process.stdout.write(content)
    return
  }

  await writeHelperOutput(outputPath, content, append)
  const action = append ? 'Appended' : 'Wrote'
  console.log(`${action} ${target} helper to ${resolve(outputPath)}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.positionals.length === 0 || getFlagBoolean(args, 'help')) {
    printUsage()
    return
  }

  const [command, subcommand] = args.positionals

  if (command === 'ingest') {
    if (!subcommand) {
      printUsage()
      return
    }

    if (subcommand === 'local-folder') {
      await ingestLocalFolder(args)
      return
    }

    if (subcommand === 'git-repo') {
      await ingestGitRepo(args)
      return
    }

    await ingestPreset(subcommand, args)
    return
  }

  if (command === 'sources' && subcommand === 'list') {
    await listSources(args)
    return
  }

  if (command === 'helper') {
    if (subcommand === 'agents' || subcommand === 'setup' || subcommand === 'skill') {
      await outputHelper(subcommand, args)
      return
    }
    printUsage()
    return
  }

  printUsage()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
