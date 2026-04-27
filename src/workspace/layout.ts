import { access, mkdir, writeFile } from 'node:fs/promises'
import { posix, resolve } from 'node:path'

const ROOT_README_PATH = '/README.md'
const HOME_MOUNT_PATH = '/home'
const PROJECT_MOUNT_PATH = '/project'
const PROJECTS_MOUNT_PATH = '/projects'
const SHARED_MOUNT_PATH = '/shared'
const TMP_MOUNT_PATH = '/tmp'
const TASK_TEMPLATE_FILES = ['brief.md', 'plan.md', 'notes.md', 'handoff.md'] as const
const DEFAULT_PROJECT_SLUG = 'default'

interface WorkspaceDirectoryTemplate {
  name: string
  purpose: string
  readme: string
}

const HOME_DIRECTORIES: WorkspaceDirectoryTemplate[] = [
  {
    name: 'tasks',
    purpose: 'Private durable task work for the current principal.',
    readme: [
      '# Tasks',
      '',
      'Create private task work under `/home/tasks/<task-slug>/`.',
      '',
      'Suggested task layout:',
      '',
      '```text',
      '/home/tasks/<task-slug>/',
      '  brief.md',
      '  plan.md',
      '  notes.md',
      '  handoff.md',
      '  artifacts/',
      '```',
      '',
      'Rules:',
      '',
      '- Keep task-specific context in the task directory.',
      '- Use lowercase kebab-case for task slugs.',
      '- Put generated outputs in `artifacts/`.',
      `- Use \`${TMP_MOUNT_PATH}\` for temporary files that do not need to persist.`,
      '',
    ].join('\n'),
  },
  {
    name: 'workspace',
    purpose: 'Private scratchpad and longer-lived working files.',
    readme: [
      '# Workspace',
      '',
      'Store private durable work that is not ready for a project task or shared docs.',
      '',
    ].join('\n'),
  },
  {
    name: 'docs',
    purpose: 'Private notes and references for the current principal.',
    readme: [
      '# Docs',
      '',
      'Store private notes and references here.',
      '',
      'Move project-facing material to `/project/docs/` or `/project/tasks/` when it should be shared.',
      '',
    ].join('\n'),
  },
  {
    name: 'agents',
    purpose: 'Private agent state, handoffs, sessions, and artifacts.',
    readme: [
      '# Agents',
      '',
      'Use `/home/agents/<agent-name>/` for private agent state.',
      '',
      'Suggested layout:',
      '',
      '```text',
      '/home/agents/<agent-name>/',
      '  handoffs/',
      '  sessions/',
      '    raw/',
      '  artifacts/',
      '```',
      '',
      'Do not save raw local agent session data unless the user explicitly opts in.',
      '',
    ].join('\n'),
  },
]

const PROJECT_DIRECTORIES: WorkspaceDirectoryTemplate[] = [
  {
    name: 'tasks',
    purpose: 'Project-scoped task work.',
    readme: [
      '# Tasks',
      '',
      'Create project-facing task work under `/project/tasks/<task-slug>/`.',
      '',
      'Suggested task layout:',
      '',
      '```text',
      '/project/tasks/<task-slug>/',
      ...TASK_TEMPLATE_FILES.map((file) => `  ${file}`),
      '  artifacts/',
      '```',
      '',
    ].join('\n'),
  },
  {
    name: 'workspace',
    purpose: 'Project-scoped working files.',
    readme: [
      '# Workspace',
      '',
      'Store project-scoped working files that are not task-specific.',
      '',
    ].join('\n'),
  },
  {
    name: 'agents',
    purpose: 'Project-facing agent handoffs and artifacts.',
    readme: [
      '# Agents',
      '',
      'Use `/project/agents/<agent-name>/` for summaries and artifacts that should be visible to the project.',
      '',
      'Do not place raw session data here. Raw session data belongs under `/home/agents/<agent-name>/sessions/raw/` only when explicitly requested.',
      '',
    ].join('\n'),
  },
]

const SHARED_DIRECTORIES: WorkspaceDirectoryTemplate[] = [
  {
    name: 'docs',
    purpose: 'Tenant-wide shared docs.',
    readme: [
      '# Docs',
      '',
      'Store docs that apply across projects in this tenant.',
      '',
    ].join('\n'),
  },
  {
    name: 'policies',
    purpose: 'Tenant-wide shared policies.',
    readme: [
      '# Policies',
      '',
      'Store policies and durable rules that apply across projects in this tenant.',
      '',
    ].join('\n'),
  },
]

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function writeFileIfMissing(path: string, content: string): Promise<void> {
  if (await pathExists(path)) return
  await writeFile(path, content)
}

function createWorkspaceReadme(): string {
  return [
    '# docs-ssh',
    '',
    'This SSH filesystem separates private work, current project work, tenant-shared material, and temporary files.',
    '',
    'Top-level paths:',
    '',
    '- `/home/`: private durable work for the authenticated principal.',
    '- `/project/`: alias for the current project.',
    '- `/projects/`: accessible projects by slug.',
    '- `/shared/`: tenant-wide shared docs and policies.',
    '- `/tmp/`: session-local temporary files.',
    '',
    'Rules:',
    '',
    '- Read `/README.md` and `/project/README.md` before automating writes.',
    '- Use `/home` for private durable work.',
    '- Use `/project` for project-scoped docs, tasks, workspace files, handoffs, and artifacts.',
    '- Use `/shared` only for tenant-wide docs and policies.',
    `- Use \`${TMP_MOUNT_PATH}/\` for temporary files that do not need to persist.`,
    '- Do not save raw local agent session data unless the user explicitly opts in.',
    '- If raw session data is requested, write it under `/home/agents/<agent-name>/sessions/raw/` only.',
    '- Prefer lowercase kebab-case names for task directories and note files.',
    '',
    'Current project task layout:',
    '',
    '```text',
    '/project/tasks/<task-slug>/',
    ...TASK_TEMPLATE_FILES.map((file) => `  ${file}`),
    '  artifacts/',
    '```',
    '',
  ].join('\n')
}

function createHomeReadme(): string {
  return [
    '# Home',
    '',
    'This directory is private durable storage for the authenticated principal.',
    '',
    ...HOME_DIRECTORIES.map((directory) => `- \`${directory.name}/\`: ${directory.purpose}`),
    '',
  ].join('\n')
}

function createProjectReadme(projectSlug = DEFAULT_PROJECT_SLUG): string {
  return [
    '# Project',
    '',
    `This directory is the current project alias for \`${projectSlug}\`.`,
    '',
    '- `docs/`: read-only default project docs source.',
    '- `sources/<name>/`: read-only named project sources.',
    ...PROJECT_DIRECTORIES.map((directory) => `- \`${directory.name}/\`: ${directory.purpose}`),
    '',
  ].join('\n')
}

function createSharedReadme(): string {
  return [
    '# Shared',
    '',
    'This directory stores tenant-wide shared material.',
    '',
    ...SHARED_DIRECTORIES.map((directory) => `- \`${directory.name}/\`: ${directory.purpose}`),
    '',
  ].join('\n')
}

export function getWorkspaceWritablePaths(opts: {
  homeMountPath?: string
  projectMountPath?: string
  projectSlug?: string
  projectsMountPath?: string
  sharedMountPath?: string
  tmpMountPath?: string
} = {}): string[] {
  const homeMountPath = opts.homeMountPath ?? HOME_MOUNT_PATH
  const projectMountPath = opts.projectMountPath ?? PROJECT_MOUNT_PATH
  const projectsMountPath = opts.projectsMountPath ?? PROJECTS_MOUNT_PATH
  const projectSlug = opts.projectSlug ?? DEFAULT_PROJECT_SLUG
  const sharedMountPath = opts.sharedMountPath ?? SHARED_MOUNT_PATH
  const tmpMountPath = opts.tmpMountPath ?? TMP_MOUNT_PATH
  const concreteProjectPath = posix.join(projectsMountPath, projectSlug)

  return [
    ...HOME_DIRECTORIES.map((directory) => posix.join(homeMountPath, directory.name)),
    ...PROJECT_DIRECTORIES.map((directory) => posix.join(projectMountPath, directory.name)),
    ...PROJECT_DIRECTORIES.map((directory) => posix.join(concreteProjectPath, directory.name)),
    ...SHARED_DIRECTORIES.map((directory) => posix.join(sharedMountPath, directory.name)),
    tmpMountPath,
  ]
}

export function getWorkspaceReadOnlyPaths(opts: {
  homeMountPath?: string
  projectMountPath?: string
  projectSlug?: string
  projectsMountPath?: string
  sharedMountPath?: string
} = {}): string[] {
  const homeMountPath = opts.homeMountPath ?? HOME_MOUNT_PATH
  const projectMountPath = opts.projectMountPath ?? PROJECT_MOUNT_PATH
  const projectsMountPath = opts.projectsMountPath ?? PROJECTS_MOUNT_PATH
  const projectSlug = opts.projectSlug ?? DEFAULT_PROJECT_SLUG
  const sharedMountPath = opts.sharedMountPath ?? SHARED_MOUNT_PATH
  const concreteProjectPath = posix.join(projectsMountPath, projectSlug)

  return [
    ROOT_README_PATH,
    posix.join(homeMountPath, 'README.md'),
    ...HOME_DIRECTORIES.map((directory) => posix.join(homeMountPath, directory.name, 'README.md')),
    posix.join(projectMountPath, 'README.md'),
    posix.join(projectMountPath, 'docs'),
    posix.join(projectMountPath, 'sources'),
    ...PROJECT_DIRECTORIES.map((directory) => posix.join(projectMountPath, directory.name, 'README.md')),
    posix.join(concreteProjectPath, 'README.md'),
    posix.join(concreteProjectPath, 'docs'),
    posix.join(concreteProjectPath, 'sources'),
    ...PROJECT_DIRECTORIES.map((directory) => posix.join(concreteProjectPath, directory.name, 'README.md')),
    posix.join(sharedMountPath, 'README.md'),
    ...SHARED_DIRECTORIES.map((directory) => posix.join(sharedMountPath, directory.name, 'README.md')),
  ]
}

export async function ensureWorkspaceLayout(rootPath: string): Promise<void> {
  const resolvedRootPath = resolve(rootPath)
  await mkdir(resolvedRootPath, { recursive: true })

  const homeRootPath = resolve(resolvedRootPath, 'home')
  const projectRootPath = resolve(resolvedRootPath, 'projects', DEFAULT_PROJECT_SLUG)
  const sharedRootPath = resolve(resolvedRootPath, 'shared')

  await writeFileIfMissing(resolve(resolvedRootPath, 'README.md'), createWorkspaceReadme())

  await mkdir(homeRootPath, { recursive: true })
  await writeFileIfMissing(resolve(homeRootPath, 'README.md'), createHomeReadme())
  for (const directory of HOME_DIRECTORIES) {
    const directoryPath = resolve(homeRootPath, directory.name)
    await mkdir(directoryPath, { recursive: true })
    await writeFileIfMissing(resolve(directoryPath, 'README.md'), directory.readme)
  }
  await mkdir(resolve(homeRootPath, 'agents', 'codex', 'handoffs'), { recursive: true })
  await mkdir(resolve(homeRootPath, 'agents', 'codex', 'sessions', 'raw'), { recursive: true })
  await mkdir(resolve(homeRootPath, 'agents', 'codex', 'artifacts'), { recursive: true })

  await mkdir(projectRootPath, { recursive: true })
  await writeFileIfMissing(resolve(projectRootPath, 'README.md'), createProjectReadme(DEFAULT_PROJECT_SLUG))
  for (const directory of PROJECT_DIRECTORIES) {
    const directoryPath = resolve(projectRootPath, directory.name)
    await mkdir(directoryPath, { recursive: true })
    await writeFileIfMissing(resolve(directoryPath, 'README.md'), directory.readme)
  }
  await mkdir(resolve(projectRootPath, 'agents', 'codex', 'handoffs'), { recursive: true })
  await mkdir(resolve(projectRootPath, 'agents', 'codex', 'artifacts'), { recursive: true })

  await mkdir(sharedRootPath, { recursive: true })
  await writeFileIfMissing(resolve(sharedRootPath, 'README.md'), createSharedReadme())
  for (const directory of SHARED_DIRECTORIES) {
    const directoryPath = resolve(sharedRootPath, directory.name)
    await mkdir(directoryPath, { recursive: true })
    await writeFileIfMissing(resolve(directoryPath, 'README.md'), directory.readme)
  }
}
