/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified to expose a project-oriented SSH workspace.
 */

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Bash, defineCommand, InMemoryFs, ReadWriteFs, type ExecResult } from 'just-bash'
import { loadInstanceConfig, type InstanceConfig } from '../instance-config.js'
import {
  createArtifactCommand,
  type ArtifactCommandService,
} from '../artifacts/command.js'
import { loadSourceStore } from '../sources/source-store.js'
import type { SourceStore } from '../sources/types.js'
import {
  ensureWorkspaceLayout,
  getWorkspaceReadOnlyPaths,
  getWorkspaceWritablePaths,
} from '../workspace/layout.js'
import { ExtendedMountableFs, type FsAccessGuard } from './extended-mountable-fs.js'
import {
  createAgentsMarkdown,
  createSetupMarkdown,
  createSkillMarkdown,
} from './helper-content.js'

export const EXECUTION_LIMITS = {
  maxCommandCount: 1000,
  maxLoopIterations: 1000,
  maxCallDepth: 50,
  maxSubstitutionDepth: 20,
  maxSourceDepth: 10,
  maxFileDescriptors: 100,
  maxAwkIterations: 1000,
  maxSedIterations: 1000,
  maxJqIterations: 1000,
  maxGlobOperations: 10000,
  maxArrayElements: 10000,
  maxBraceExpansionResults: 1000,
  maxOutputSize: 1024 * 1024,
  maxStringLength: 1024 * 1024,
  maxHeredocSize: 1024 * 1024,
}

const BATCH_COMMAND_MAX_COUNT = 50
const BATCH_COMMAND_MAX_LENGTH = 8192
const BATCH_OUTPUT_MAX_BYTES = 1024 * 1024
const READ_RANGE_DEFAULT_LINES = 200
const READ_RANGE_MAX_LINES = 1000
const READ_RANGE_MAX_BYTES = 512 * 1024

const sshCommand = defineCommand('ssh', async (args) => {
  const command = args.join(' ')
  return {
    stdout: '',
    stderr:
      'ssh is not available from within this session.\n' +
      'Exit first, then run:\n\n' +
      `  ssh ${command}\n\n`,
    exitCode: 1,
  }
})

function createTextCommand(name: string, content: string) {
  return defineCommand(name, async () => ({
    stdout: content.endsWith('\n') ? content : `${content}\n`,
    stderr: '',
    exitCode: 0,
  }))
}

function createUsageResult(commandName: string): ExecResult {
  return {
    stdout: [
      `Usage: ${commandName} [command ... [-- command ...]]`,
      `       printf '%s\\n' 'find /projects/default/tasks' 'cat /README.md' | ${commandName}`,
      '',
      'Runs multiple commands in one SSH exec and returns one JSON object per line:',
      '{"index":0,"command":"...","exitCode":0,"stdout":"...","stderr":"..."}',
      '',
    ].join('\n'),
    stderr: '',
    exitCode: 0,
  }
}

function parseBatchCommands(args: string[], stdin: string): string[] {
  if (args.includes('--help') || args.includes('-h')) return []

  if (args.length === 0) {
    return stdin
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  }

  const commands: string[] = []
  let current: string[] = []
  for (const arg of args) {
    if (arg === '--') {
      const command = current.join(' ').trim()
      if (command) commands.push(command)
      current = []
    } else {
      current.push(arg)
    }
  }

  const command = current.join(' ').trim()
  if (command) commands.push(command)
  return commands
}

function validateBatchCommands(commandName: string, commands: string[]): ExecResult | null {
  if (commands.length === 0) {
    return {
      stdout: '',
      stderr: `${commandName}: no commands provided.\n`,
      exitCode: 2,
    }
  }

  if (commands.length > BATCH_COMMAND_MAX_COUNT) {
    return {
      stdout: '',
      stderr: `${commandName}: at most ${BATCH_COMMAND_MAX_COUNT} commands are allowed.\n`,
      exitCode: 2,
    }
  }

  for (const [index, command] of commands.entries()) {
    if (command.length > BATCH_COMMAND_MAX_LENGTH) {
      return {
        stdout: '',
        stderr: `${commandName}: command ${index} exceeds ${BATCH_COMMAND_MAX_LENGTH} characters.\n`,
        exitCode: 2,
      }
    }

    if (/^\s*(?:batch|docs-ssh-batch|ssh-batch)(?:\s|$)/u.test(command)) {
      return {
        stdout: '',
        stderr: `${commandName}: nested batch commands are not allowed.\n`,
        exitCode: 2,
      }
    }
  }

  return null
}

function createBatchCommand(commandName: string) {
  return defineCommand(commandName, async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) return createUsageResult(commandName)

    if (!ctx.exec) {
      return {
        stdout: '',
        stderr: `${commandName}: internal exec function is not available.\n`,
        exitCode: 1,
      }
    }

    const commands = parseBatchCommands(args, ctx.stdin)
    const invalid = validateBatchCommands(commandName, commands)
    if (invalid) return invalid

    const lines: string[] = []
    let exitCode = 0
    let outputBytes = 0
    for (const [index, command] of commands.entries()) {
      const result = await ctx.exec(command, {
        cwd: ctx.cwd,
        signal: ctx.signal,
        stdin: '',
      })
      if (result.exitCode !== 0 && exitCode === 0) exitCode = result.exitCode

      const line = `${JSON.stringify({
        command,
        exitCode: result.exitCode,
        index,
        stderr: result.stderr,
        stdout: result.stdout,
      })}\n`
      outputBytes += Buffer.byteLength(line, 'utf8')
      if (outputBytes > BATCH_OUTPUT_MAX_BYTES) {
        return {
          stdout: lines.join(''),
          stderr: `${commandName}: output exceeded ${BATCH_OUTPUT_MAX_BYTES} bytes.\n`,
          exitCode: exitCode || 1,
        }
      }
      lines.push(line)
    }

    return {
      stdout: lines.join(''),
      stderr: '',
      exitCode,
    }
  })
}

interface ReadRangeOptions {
  endLine: number | null
  json: boolean
  lineNumbers: boolean
  path: string
  startLine: number
}

function parsePositiveLine(value: string, name: string): number | string {
  if (!/^\d+$/u.test(value)) return `${name} must be a positive integer`
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return `${name} must be a positive integer`
  return parsed
}

function parseReadRangeArgs(args: string[]): ReadRangeOptions | string {
  let json = false
  let lineNumbers = false
  let startLine: number | null = null
  let endLine: number | null = null
  const positional: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      json = true
    } else if (arg === '-n' || arg === '--line-numbers') {
      lineNumbers = true
    } else if (arg === '--start') {
      const value = args[index + 1]
      if (!value) return '--start requires a value'
      const parsed = parsePositiveLine(value, '--start')
      if (typeof parsed === 'string') return parsed
      startLine = parsed
      index += 1
    } else if (arg === '--end') {
      const value = args[index + 1]
      if (!value) return '--end requires a value'
      const parsed = parsePositiveLine(value, '--end')
      if (typeof parsed === 'string') return parsed
      endLine = parsed
      index += 1
    } else if (arg.startsWith('-')) {
      return `unknown option: ${arg}`
    } else {
      positional.push(arg)
    }
  }

  const path = positional[0]
  if (!path) return 'missing path'
  if (positional.length > 3) return 'too many positional arguments'

  if (positional[1] !== undefined) {
    const parsed = parsePositiveLine(positional[1], 'start line')
    if (typeof parsed === 'string') return parsed
    startLine = parsed
  }
  if (positional[2] !== undefined) {
    const parsed = parsePositiveLine(positional[2], 'end line')
    if (typeof parsed === 'string') return parsed
    endLine = parsed
  }

  return {
    endLine,
    json,
    lineNumbers,
    path,
    startLine: startLine ?? 1,
  }
}

function createReadRangeCommand() {
  return defineCommand('read-range', async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) {
      return {
        stdout: [
          'Usage: read-range [--json] [-n|--line-numbers] PATH [START [END]]',
          '       read-range [--json] PATH --start START --end END',
          '',
          `Reads at most ${READ_RANGE_MAX_LINES} lines and ${READ_RANGE_MAX_BYTES} bytes from a text file.`,
          '',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }
    }

    const parsed = parseReadRangeArgs(args)
    if (typeof parsed === 'string') {
      return {
        stdout: '',
        stderr: `read-range: ${parsed}.\n`,
        exitCode: 2,
      }
    }

    const resolvedPath = ctx.fs.resolvePath(ctx.cwd, parsed.path)
    let content: string
    try {
      content = await ctx.fs.readFile(resolvedPath, 'utf8')
    } catch (error) {
      return {
        stdout: '',
        stderr: `read-range: ${parsed.path}: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      }
    }

    const lines = content.split(/\r?\n/u)
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const requestedEndLine = parsed.endLine ?? parsed.startLine + READ_RANGE_DEFAULT_LINES - 1
    const endLine = Math.min(requestedEndLine, parsed.startLine + READ_RANGE_MAX_LINES - 1, lines.length)
    if (parsed.startLine > lines.length || endLine < parsed.startLine) {
      const emptyPayload = {
        path: resolvedPath,
        startLine: parsed.startLine,
        endLine: parsed.startLine - 1,
        totalLines: lines.length,
        truncated: false,
        lines: [] as Array<{ lineNumber: number, text: string }>,
      }
      return {
        stdout: parsed.json ? `${JSON.stringify(emptyPayload)}\n` : '',
        stderr: '',
        exitCode: 0,
      }
    }

    const selected = lines.slice(parsed.startLine - 1, endLine)
    const outputLines: string[] = []
    let outputBytes = 0
    let truncated = requestedEndLine > endLine
    for (const [index, text] of selected.entries()) {
      const lineNumber = parsed.startLine + index
      const outputLine = parsed.lineNumbers ? `${lineNumber}:${text}\n` : `${text}\n`
      const nextBytes = outputBytes + Buffer.byteLength(outputLine, 'utf8')
      if (nextBytes > READ_RANGE_MAX_BYTES) {
        truncated = true
        break
      }
      outputBytes = nextBytes
      outputLines.push(outputLine)
    }

    if (parsed.json) {
      const jsonLines = outputLines.map((line, index) => ({
        lineNumber: parsed.startLine + index,
        text: parsed.lineNumbers ? line.replace(/^\d+:/u, '').replace(/\n$/u, '') : line.replace(/\n$/u, ''),
      }))
      return {
        stdout: `${JSON.stringify({
          path: resolvedPath,
          startLine: parsed.startLine,
          endLine: jsonLines.length === 0 ? parsed.startLine - 1 : parsed.startLine + jsonLines.length - 1,
          totalLines: lines.length,
          truncated,
          lines: jsonLines,
        })}\n`,
        stderr: '',
        exitCode: 0,
      }
    }

    return {
      stdout: outputLines.join(''),
      stderr: '',
      exitCode: 0,
    }
  })
}

function hasScope(scopes: Set<string>, scope: string): boolean {
  return scopes.has(scope) || scopes.has('admin')
}

function createBootstrapCommand(payload: unknown, canRead: boolean) {
  return defineCommand('bootstrap', async (args) => {
    if (!canRead) {
      return {
        stdout: '',
        stderr: 'bootstrap requires bootstrap:read scope.\n',
        exitCode: 126,
      }
    }

    if (args.includes('--json')) {
      return {
        stdout: `${JSON.stringify(payload, null, 2)}\n`,
        stderr: '',
        exitCode: 0,
      }
    }

    return {
      stdout: 'Run `bootstrap --json` for the machine-readable session manifest.\n',
      stderr: '',
      exitCode: 0,
    }
  })
}

export interface CreateBashSessionContext {
  accessibleProjects?: Array<{ displayName?: string, slug: string }>
  displayName?: string
  login?: string
  principalId?: string
  principalKind?: string
  projectSlug?: string
  scopes?: string[]
  tenantId?: string
  tenantSlug?: string
}

export interface CreateBashOptions {
  accessGuard?: FsAccessGuard
  artifactService?: ArtifactCommandService
  docsDir?: string
  docsName?: string
  env?: Record<string, string>
  instanceConfig?: InstanceConfig
  registryPath?: string
  session?: CreateBashSessionContext
  sshHost?: string
  sshPort?: number
  viewerOrigin?: string
  workspaceDir?: string
}

export async function createBash(opts: CreateBashOptions = {}) {
  const instanceConfig = opts.instanceConfig ?? loadInstanceConfig()
  const docsDir = opts.docsDir ?? instanceConfig.docsDir
  const docsName = opts.docsName ?? instanceConfig.docsName
  const registryPath = opts.registryPath ?? instanceConfig.statePaths.registryPath
  const workspaceDir = resolve(opts.workspaceDir ?? instanceConfig.workspaceDir)
  const sourceStore = await loadSourceStore({
    registryPath,
    fallbackDocsDir: docsDir,
    principalId: opts.session?.principalId,
    projectSlug: opts.session?.projectSlug,
    tenantSlug: opts.session?.tenantSlug,
    workspaceDir,
  })
  await mkdir(sourceStore.workspaceRootPath, { recursive: true })
  await ensureWorkspaceLayout(sourceStore.tenantRootPath, {
    homeRootPath: sourceStore.homeRootPath,
    projectSlug: sourceStore.projectSlug,
    projectRootPath: sourceStore.projectRootPath,
  })
  const accessibleProjectInputs = opts.session?.accessibleProjects ?? [{ slug: sourceStore.projectSlug }]
  const accessibleProjectSlugs = accessibleProjectInputs.map((project) => project.slug)
  const projectStores: SourceStore[] = []
  for (const projectSlug of [...new Set(accessibleProjectSlugs)]) {
    const projectSourceStore = projectSlug === sourceStore.projectSlug
      ? sourceStore
      : await loadSourceStore({
        registryPath,
        fallbackDocsDir: docsDir,
        principalId: opts.session?.principalId,
        projectSlug,
        tenantSlug: opts.session?.tenantSlug,
        workspaceDir,
      })
    await ensureWorkspaceLayout(projectSourceStore.tenantRootPath, {
      homeRootPath: projectSourceStore.homeRootPath,
      projectSlug: projectSourceStore.projectSlug,
      projectRootPath: projectSourceStore.projectRootPath,
    })
    projectStores.push(projectSourceStore)
  }
  const sshHost = opts.sshHost ?? instanceConfig.ssh.connectHost
  const sshPort = opts.sshPort ?? instanceConfig.ssh.connectPort
  const agentsMarkdown = createAgentsMarkdown({
    docsName,
    sourceStore,
    sshHost,
    sshPort,
  })
  const skillMarkdown = createSkillMarkdown({
    docsName,
    sourceStore,
    sshHost,
    sshPort,
  })
  const setupMarkdown = createSetupMarkdown({
    docsName,
    sourceStore,
    sshHost,
    sshPort,
  })
  const rootReadme = [
    '# docs-ssh',
    '',
    'Start here before reading or writing project material.',
    '',
    '- `/home` is private durable work for the authenticated principal.',
    `- \`${sourceStore.projectMountPath}\` is the current project workspace.`,
    `- \`${sourceStore.projectsMountPath}\` contains accessible project workspaces by slug.`,
    `- \`${sourceStore.projectMountPath}/issues\` is project issue tracking: what to do, why, status, next action, and result links.`,
    `- \`${sourceStore.projectMountPath}/tasks\` stores research and work results.`,
    `- Publish self-contained task HTML with \`artifact publish ${sourceStore.projectMountPath}/tasks/<task-slug>/artifacts/<name>.html\`.`,
    '- `/tmp` is temporary and resets between SSH sessions.',
    '',
    `Use \`/home\` for personal notes, \`${sourceStore.projectMountPath}/issues\` for issue records, and \`${sourceStore.projectMountPath}/tasks/<task-slug>/\` for task results.`,
    '',
  ].join('\n')
  const projectReadme = [
    '# Project',
    '',
    `This is the project workspace for \`${sourceStore.projectSlug}\`.`,
    '',
    '- `issues/`: project issue tracking.',
    '- `tasks/`: research and work results.',
    '- Publish self-contained HTML below `tasks/<task-slug>/artifacts/` with the `artifact publish` command.',
    '',
  ].join('\n')
  const scopes = new Set(opts.session?.scopes ?? [
    'bootstrap:read',
    'home:read',
    'home:write',
    'project:read',
    'project:write',
    'projects:read',
  ])
  const canReadHome = hasScope(scopes, 'home:read') || hasScope(scopes, 'home:write')
  const canWriteHome = hasScope(scopes, 'home:write')
  const canReadProject = hasScope(scopes, 'project:read') || hasScope(scopes, 'project:write')
  const canWriteProject = hasScope(scopes, 'project:write')
  const canReadBootstrap = hasScope(scopes, 'bootstrap:read')
  const bootstrapPayload = {
    tenant: opts.session?.tenantSlug ?? 'default',
    principal: {
      displayName: opts.session?.displayName ?? opts.session?.login ?? 'anonymous',
      id: opts.session?.principalId ?? 'anonymous',
      kind: opts.session?.principalKind ?? 'anonymous',
      login: opts.session?.login ?? 'anonymous',
    },
    project: {
      root: sourceStore.projectMountPath,
      slug: sourceStore.projectSlug,
    },
    projects: projectStores.map((projectStore) => ({
      current: projectStore.projectSlug === sourceStore.projectSlug,
      root: projectStore.projectMountPath,
      slug: projectStore.projectSlug,
    })),
    paths: {
      rootReadme: '/README.md',
      home: sourceStore.homeMountPath,
      project: sourceStore.projectMountPath,
      projectIssues: `${sourceStore.projectMountPath}/issues`,
      projectTasks: `${sourceStore.projectMountPath}/tasks`,
      projects: sourceStore.projectsMountPath,
      tmp: sourceStore.tmpMountPath,
    },
    scopes: [...scopes].sort(),
  }

  const fs = new ExtendedMountableFs({
    accessGuard: opts.accessGuard,
    readOnlyPaths: [
      ...projectStores.flatMap((projectStore) =>
        getWorkspaceReadOnlyPaths({
          homeMountPath: sourceStore.homeMountPath,
          projectMountPath: projectStore.projectMountPath,
          projectSlug: projectStore.projectSlug,
          projectsMountPath: projectStore.projectsMountPath,
        }),
      ),
    ],
    writablePaths: [
      '/bin',
      '/dev',
      '/proc',
      '/usr',
      '/usr/bin',
      ...(canWriteHome || canWriteProject ? [
        ...getWorkspaceWritablePaths({
          homeMountPath: sourceStore.homeMountPath,
          projectMountPath: sourceStore.projectMountPath,
          projectSlug: sourceStore.projectSlug,
          projectsMountPath: sourceStore.projectsMountPath,
          tmpMountPath: sourceStore.tmpMountPath,
        }),
        ...projectStores.flatMap((projectStore) =>
          getWorkspaceWritablePaths({
            homeMountPath: sourceStore.homeMountPath,
            projectMountPath: projectStore.projectMountPath,
            projectSlug: projectStore.projectSlug,
            projectsMountPath: projectStore.projectsMountPath,
            tmpMountPath: sourceStore.tmpMountPath,
          }),
        ),
      ].filter((path) => {
        if (path === sourceStore.tmpMountPath) return true
        if (path === sourceStore.homeMountPath || path.startsWith(`${sourceStore.homeMountPath}/`)) {
          return canWriteHome
        }
        return canWriteProject && projectStores.some((projectStore) => path.startsWith(`${projectStore.projectMountPath}/`))
      }) : [sourceStore.tmpMountPath]),
    ],
    initialFiles: {
      '/README.md': rootReadme,
      ...(canReadProject
        ? Object.fromEntries(projectStores.map((projectStore) => [
          `${projectStore.projectMountPath}/README.md`,
          projectStore.projectSlug === sourceStore.projectSlug
            ? projectReadme
            : [
              '# Project',
              '',
              `This is the project workspace for \`${projectStore.projectSlug}\`.`,
              '',
              '- `issues/`: project issue tracking.',
              '- `tasks/`: research and work results.',
              '- Publish self-contained HTML below `tasks/<task-slug>/artifacts/` with the `artifact publish` command.',
              '',
            ].join('\n'),
        ]))
        : {}),
    },
    mounts: [
      ...(canReadHome ? [{
        mountPoint: sourceStore.homeMountPath,
        filesystem: new ReadWriteFs({ root: sourceStore.homeRootPath }),
      }] : []),
      ...(canReadProject ? projectStores.flatMap((projectStore) => [
        {
          mountPoint: `${projectStore.projectMountPath}/issues`,
          filesystem: new ReadWriteFs({ root: `${projectStore.projectRootPath}/issues` }),
        },
        {
          mountPoint: `${projectStore.projectMountPath}/tasks`,
          filesystem: new ReadWriteFs({ root: `${projectStore.projectRootPath}/tasks` }),
        },
      ]) : []),
      {
        mountPoint: sourceStore.tmpMountPath,
        filesystem: new InMemoryFs(),
      },
    ],
  })

  const bash = new Bash({
    fs,
    cwd: '/',
    env: {
      HOME: sourceStore.homeMountPath,
      PATH: '/bin:/usr/bin',
      ...opts.env,
      BASH_ALIAS_ll: 'ls -alF',
      BASH_ALIAS_la: 'ls -a',
      BASH_ALIAS_l: 'ls -CF',
    },
    customCommands: [
      sshCommand,
      createTextCommand('agents', agentsMarkdown),
      createTextCommand('skill', skillMarkdown),
      createTextCommand('setup', setupMarkdown),
      createBootstrapCommand(bootstrapPayload, canReadBootstrap),
      createBatchCommand('batch'),
      createBatchCommand('docs-ssh-batch'),
      createBatchCommand('ssh-batch'),
      createReadRangeCommand(),
      createArtifactCommand({
        defaultProjectSlug: sourceStore.projectSlug,
        service: opts.artifactService,
        viewerOrigin: opts.viewerOrigin ?? instanceConfig.viewer.publicOrigin,
      }),
    ],
    defenseInDepth: true,
    executionLimits: EXECUTION_LIMITS,
  })

  await bash.exec('shopt -s expand_aliases')

  return { bash, fs, sourceStore }
}
