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

export interface CreateBashOptions {
  docsDir?: string
  docsName?: string
  env?: Record<string, string>
  instanceConfig?: InstanceConfig
  registryPath?: string
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
    workspaceDir,
  })
  await mkdir(sourceStore.workspaceRootPath, { recursive: true })
  await ensureWorkspaceLayout(sourceStore.workspaceRootPath)
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
    '- `/project` is the current project alias.',
    '- `/project/docs` is the read-only default docs source.',
    '- `/project/sources/<name>` contains additional read-only sources.',
    '- `/projects/default` is the concrete current project path.',
    '- `/shared` is tenant-wide docs and policies.',
    '- `/tmp` is temporary and resets between SSH sessions.',
    '',
    'Use `/project/tasks/<task-slug>/` for project task work and `/home/agents/codex/handoffs/` for private resume summaries.',
    '',
  ].join('\n')
  const projectReadme = [
    '# Project',
    '',
    `This is the current project alias for \`${sourceStore.projectSlug}\`.`,
    '',
    '- `docs/`: read-only default docs source.',
    '- `sources/<name>/`: read-only named sources.',
    '- `tasks/`: project-scoped task work.',
    '- `workspace/`: project-scoped working files.',
    '- `agents/`: project-facing agent handoffs and artifacts.',
    '',
  ].join('\n')

  const fs = new ExtendedMountableFs({
    readOnlyPaths: [
      ...getWorkspaceReadOnlyPaths({
        homeMountPath: sourceStore.homeMountPath,
        projectMountPath: sourceStore.projectMountPath,
        projectSlug: sourceStore.projectSlug,
        projectsMountPath: sourceStore.projectsMountPath,
        sharedMountPath: sourceStore.sharedMountPath,
      }),
    ],
    writablePaths: [
      '/bin',
      '/dev',
      '/proc',
      '/usr',
      '/usr/bin',
      ...getWorkspaceWritablePaths({
        homeMountPath: sourceStore.homeMountPath,
        projectMountPath: sourceStore.projectMountPath,
        projectSlug: sourceStore.projectSlug,
        projectsMountPath: sourceStore.projectsMountPath,
        sharedMountPath: sourceStore.sharedMountPath,
        tmpMountPath: sourceStore.tmpMountPath,
      }),
    ],
    initialFiles: {
      '/README.md': rootReadme,
      '/project/README.md': projectReadme,
      [`/projects/${sourceStore.projectSlug}/README.md`]: projectReadme,
    },
    mounts: [
      {
        mountPoint: sourceStore.homeMountPath,
        filesystem: new ReadWriteFs({ root: sourceStore.homeRootPath }),
      },
      {
        mountPoint: `${sourceStore.projectMountPath}/tasks`,
        filesystem: new ReadWriteFs({ root: `${sourceStore.projectRootPath}/tasks` }),
      },
      {
        mountPoint: `${sourceStore.projectMountPath}/workspace`,
        filesystem: new ReadWriteFs({ root: `${sourceStore.projectRootPath}/workspace` }),
      },
      {
        mountPoint: `${sourceStore.projectMountPath}/agents`,
        filesystem: new ReadWriteFs({ root: `${sourceStore.projectRootPath}/agents` }),
      },
      {
        mountPoint: `${sourceStore.projectsMountPath}/${sourceStore.projectSlug}/tasks`,
        filesystem: new ReadWriteFs({ root: `${sourceStore.projectRootPath}/tasks` }),
      },
      {
        mountPoint: `${sourceStore.projectsMountPath}/${sourceStore.projectSlug}/workspace`,
        filesystem: new ReadWriteFs({ root: `${sourceStore.projectRootPath}/workspace` }),
      },
      {
        mountPoint: `${sourceStore.projectsMountPath}/${sourceStore.projectSlug}/agents`,
        filesystem: new ReadWriteFs({ root: `${sourceStore.projectRootPath}/agents` }),
      },
      {
        mountPoint: sourceStore.sharedMountPath,
        filesystem: new ReadWriteFs({ root: sourceStore.sharedRootPath }),
      },
      ...sourceStore.mounts.map((mount) => ({
        mountPoint: mount.mountPoint,
        filesystem: new OverlayFs({ root: mount.rootPath, mountPoint: '/', readOnly: true }),
      })),
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
    ],
    defenseInDepth: true,
    executionLimits: EXECUTION_LIMITS,
  })

  await bash.exec('shopt -s expand_aliases')

  return { bash, fs, sourceStore }
}
