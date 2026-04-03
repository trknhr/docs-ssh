/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified to mount generic local docs and prepare for future source adapters.
 */

import { resolve } from 'node:path'
import { Bash, defineCommand, OverlayFs } from 'just-bash'
import { loadSourceStore } from '../sources/source-store.js'
import { ExtendedMountableFs } from './extended-mountable-fs.js'
import {
  createAgentsMarkdown,
  createSetupMarkdown,
  createSkillMarkdown,
} from './helper-content.js'

const DEFAULT_DOCS_DIR = resolve(process.env.DOCS_DIR ?? './docs')

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
  registryPath?: string
  sshHost?: string
  sshPort?: number
}

export async function createBash(opts: CreateBashOptions = {}) {
  const docsDir = opts.docsDir ?? DEFAULT_DOCS_DIR
  const docsName = opts.docsName ?? 'Documentation'
  const sourceStore = await loadSourceStore({
    registryPath: opts.registryPath,
    fallbackDocsDir: docsDir,
  })
  const sshHost = opts.sshHost ?? process.env.SSH_CONNECT_HOST ?? '127.0.0.1'
  const sshPort = opts.sshPort ?? parseInt(process.env.SSH_CONNECT_PORT ?? '2222', 10)
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
    readOnly: true,
    initialFiles: {
      '/AGENTS.md': agentsMarkdown,
      '/SKILL.md': skillMarkdown,
      '/SETUP.md': setupMarkdown,
    },
    mounts: sourceStore.mounts.map((mount) => ({
      mountPoint: mount.mountPoint,
      filesystem: new OverlayFs({ root: mount.rootPath, mountPoint: '/', readOnly: true }),
    })),
  })

  const bash = new Bash({
    fs,
    cwd: '/',
    env: {
      HOME: '/',
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
