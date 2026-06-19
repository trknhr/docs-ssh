/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified to expose a project-oriented SSH workspace.
 */

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Bash, defineCommand, InMemoryFs, ReadWriteFs } from 'just-bash'
import { loadInstanceConfig, type InstanceConfig } from '../instance-config.js'
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
    ],
    defenseInDepth: true,
    executionLimits: EXECUTION_LIMITS,
  })

  await bash.exec('shopt -s expand_aliases')

  return { bash, fs, sourceStore }
}
