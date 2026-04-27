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

  const fs = new ExtendedMountableFs({
    readOnlyPaths: [
      '/AGENTS.md',
      '/SKILL.md',
      '/SETUP.md',
      ...getWorkspaceReadOnlyPaths(sourceStore.workspaceMountPath),
    ],
    writablePaths: [
      '/bin',
      '/dev',
      '/proc',
      sourceStore.tmpMountPath,
      '/usr',
      '/usr/bin',
      ...getWorkspaceWritablePaths(sourceStore.workspaceMountPath),
    ],
    initialFiles: {
      '/AGENTS.md': agentsMarkdown,
      '/SKILL.md': skillMarkdown,
      '/SETUP.md': setupMarkdown,
    },
    mounts: [
      ...sourceStore.mounts.map((mount) => ({
        mountPoint: mount.mountPoint,
        filesystem: new OverlayFs({ root: mount.rootPath, mountPoint: '/', readOnly: true }),
      })),
      {
        mountPoint: sourceStore.workspaceMountPath,
        filesystem: new ReadWriteFs({ root: sourceStore.workspaceRootPath }),
      },
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
      HOME: sourceStore.workspaceMountPath,
      PATH: '/bin:/usr/bin',
      ...opts.env,
      BASH_ALIAS_ll: 'ls -alF',
      BASH_ALIAS_la: 'ls -a',
      BASH_ALIAS_l: 'ls -CF',
      BASH_ALIAS_agents: 'echo && cat /AGENTS.md',
      BASH_ALIAS_skill: 'echo && cat /SKILL.md',
      BASH_ALIAS_setup: 'cat /SETUP.md',
    },
    customCommands: [sshCommand],
    defenseInDepth: true,
    executionLimits: EXECUTION_LIMITS,
  })

  await bash.exec('shopt -s expand_aliases')

  return { bash, fs, sourceStore }
}
