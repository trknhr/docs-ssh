/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified to mount generic local docs and prepare for future source adapters.
 */

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Bash, defineCommand, InMemoryFs, OverlayFs, ReadWriteFs } from 'just-bash'
import { loadInstanceConfig, type InstanceConfig } from '../instance-config.js'
import { loadSourceStore } from '../sources/source-store.js'
import {
  ensureWorkspaceLayout,
  getWorkspaceReadOnlyPaths,
  getWorkspaceWritablePaths,
} from '../workspace/layout.js'
import { ExtendedMountableFs } from './extended-mountable-fs.js'
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
  docsDir?: string
  docsName?: string
  env?: Record<string, string>
  instanceConfig?: InstanceConfig
  registryPath?: string
  session?: CreateBashSessionContext
  sshHost?: string
  sshPort?: number
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
    `- \`${sourceStore.projectDocsMountPath}\` is the read-only default docs source.`,
    `- \`${sourceStore.projectMountPath}/sources/<name>\` contains additional read-only sources.`,
    `- \`${sourceStore.projectMountPath}/issues\` is project issue tracking: what to do, why, status, next action, and result links.`,
    `- \`${sourceStore.projectMountPath}/tasks\` stores research and work results.`,
    '- `/tmp` is temporary and resets between SSH sessions.',
    '',
    `Use \`/home\` for personal notes, \`${sourceStore.projectMountPath}/issues\` for issue records, \`${sourceStore.projectMountPath}/tasks/<task-slug>/\` for task results, and \`${sourceStore.projectDocsMountPath}\` for polished long-term references.`,
    '',
  ].join('\n')
  const projectReadme = [
    '# Project',
    '',
    `This is the project workspace for \`${sourceStore.projectSlug}\`.`,
    '',
    '- `docs/`: read-only default docs source.',
    '- `sources/<name>/`: read-only named sources.',
    '- `issues/`: project issue tracking.',
    '- `tasks/`: research and work results.',
    '',
  ].join('\n')
  const scopes = new Set(opts.session?.scopes ?? [
    'bootstrap:read',
    'home:read',
    'home:write',
    'project:read',
    'project:write',
    'projects:read',
    'sources:read',
  ])
  const canReadHome = hasScope(scopes, 'home:read') || hasScope(scopes, 'home:write')
  const canWriteHome = hasScope(scopes, 'home:write')
  const canReadProject = hasScope(scopes, 'project:read') || hasScope(scopes, 'project:write')
  const canWriteProject = hasScope(scopes, 'project:write')
  const canReadSources = hasScope(scopes, 'sources:read')
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
    paths: {
      rootReadme: '/README.md',
      home: sourceStore.homeMountPath,
      project: sourceStore.projectMountPath,
      projectDocs: sourceStore.projectDocsMountPath,
      projectIssues: `${sourceStore.projectMountPath}/issues`,
      projectTasks: `${sourceStore.projectMountPath}/tasks`,
      projectSources: `${sourceStore.projectMountPath}/sources`,
      projects: sourceStore.projectsMountPath,
      tmp: sourceStore.tmpMountPath,
    },
    scopes: [...scopes].sort(),
  }

  const fs = new ExtendedMountableFs({
    readOnlyPaths: [
      ...getWorkspaceReadOnlyPaths({
        homeMountPath: sourceStore.homeMountPath,
        projectMountPath: sourceStore.projectMountPath,
        projectSlug: sourceStore.projectSlug,
        projectsMountPath: sourceStore.projectsMountPath,
      }),
    ],
    writablePaths: [
      '/bin',
      '/dev',
      '/proc',
      '/usr',
      '/usr/bin',
      ...(canWriteHome || canWriteProject ? getWorkspaceWritablePaths({
        homeMountPath: sourceStore.homeMountPath,
        projectMountPath: sourceStore.projectMountPath,
        projectSlug: sourceStore.projectSlug,
        projectsMountPath: sourceStore.projectsMountPath,
        tmpMountPath: sourceStore.tmpMountPath,
      }).filter((path) => {
        if (path === sourceStore.tmpMountPath) return true
        if (path === sourceStore.homeMountPath || path.startsWith(`${sourceStore.homeMountPath}/`)) {
          return canWriteHome
        }
        if (path.startsWith(`${sourceStore.projectMountPath}/`)) {
          return canWriteProject
        }
        const concreteProjectPath = `${sourceStore.projectsMountPath}/${sourceStore.projectSlug}`
        if (path.startsWith(`${concreteProjectPath}/`)) {
          return canWriteProject
        }
        return false
      }) : [sourceStore.tmpMountPath]),
    ],
    initialFiles: {
      '/README.md': rootReadme,
      ...(canReadProject ? { [`${sourceStore.projectMountPath}/README.md`]: projectReadme } : {}),
    },
    mounts: [
      ...(canReadHome ? [{
        mountPoint: sourceStore.homeMountPath,
        filesystem: new ReadWriteFs({ root: sourceStore.homeRootPath }),
      }] : []),
      ...(canReadProject ? [{
        mountPoint: `${sourceStore.projectMountPath}/issues`,
        filesystem: new ReadWriteFs({ root: `${sourceStore.projectRootPath}/issues` }),
      },
      {
        mountPoint: `${sourceStore.projectMountPath}/tasks`,
        filesystem: new ReadWriteFs({ root: `${sourceStore.projectRootPath}/tasks` }),
      }] : []),
      ...(canReadProject && canReadSources ? sourceStore.mounts
        .map((mount) => ({
          mountPoint: mount.mountPoint,
          filesystem: new OverlayFs({ root: mount.rootPath, mountPoint: '/', readOnly: true }),
        })) : []),
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
    ],
    defenseInDepth: true,
    executionLimits: EXECUTION_LIMITS,
  })

  await bash.exec('shopt -s expand_aliases')

  return { bash, fs, sourceStore }
}
