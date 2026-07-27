import { access, mkdir, writeFile } from 'node:fs/promises'
import { posix, resolve } from 'node:path'

const ROOT_README_PATH = '/README.md'
const HOME_MOUNT_PATH = '/home'
const PROJECTS_MOUNT_PATH = '/projects'
const TMP_MOUNT_PATH = '/tmp'
const DEFAULT_PROJECT_SLUG = 'default'

interface WorkspaceDirectoryTemplate {
  name: string
  purpose: string
  readme: string
}

const PROJECT_DIRECTORIES: WorkspaceDirectoryTemplate[] = [
  {
    name: 'issues',
    purpose: 'Project issue tracking: what to do, why, status, next action, and result links.',
    readme: [
      '# Issues',
      '',
      'Track project issues here. Issue files describe what to do, why it matters, current status, next action, and links to related task results.',
      '',
      'Suggested issue file:',
      '',
      '```text',
      '/projects/<project-slug>/issues/0001-example-issue.md',
      '```',
      '',
      'Suggested sections:',
      '',
      '- Goal',
      '- Context',
      '- Status',
      '- Next',
      '- Results',
      '',
    ].join('\n'),
  },
  {
    name: 'tasks',
    purpose: 'Research and work results: logs, conclusions, verification, proposals, and generated artifacts.',
    readme: [
      '# Tasks',
      '',
      'Store research and work results under `/projects/<project-slug>/tasks/<task-slug>/`.',
      '',
      'Suggested task layout:',
      '',
      '```text',
      '/projects/<project-slug>/tasks/<task-slug>/',
      '  result.md',
      '  notes.md',
      '  artifacts/',
      '```',
      '',
      'HTML artifacts must be self-contained `.html` or `.htm` files. Publish one from a configured checkout with:',
      '',
      '```bash',
      'docs-ssh artifact publish tasks/<task-slug>/artifacts/<name>.html',
      '```',
      '',
      'Publishing the same source path again adds an immutable version at the existing Viewer URL.',
      '',
      'Keep polished project-facing references in task results until a dedicated docs feature exists.',
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
    'This SSH filesystem separates private notes, project work, and temporary files.',
    '',
    'Top-level paths:',
    '',
    '- `/home/`: private notes for the authenticated principal.',
    '- `/projects/`: accessible projects by slug.',
    '- `/tmp/`: session-local temporary files.',
    '',
    'Rules:',
    '',
    '- Run `bootstrap --json`, then read `/README.md` and the selected `/projects/<slug>/README.md` before automating writes.',
    '- Use `/home` for private personal notes.',
    '- Use `/projects/<slug>/issues` for issue tracking: what to do, why, status, next action, and result links.',
    '- Use `/projects/<slug>/tasks` for research and work results: logs, conclusions, verification, proposals, and generated artifacts.',
    '- Publish self-contained task HTML with `artifact publish /projects/<slug>/tasks/<task-slug>/artifacts/<name>.html`.',
    '- Do not create new directories directly under `/projects`; projects are server-managed resources.',
    `- Use \`${TMP_MOUNT_PATH}/\` for temporary files that do not need to persist.`,
    '- Prefer lowercase kebab-case names for issue files, task directories, and note files.',
    '',
    'Current project layout:',
    '',
    '```text',
    '/projects/<slug>/issues/<issue-slug>.md',
    '/projects/<slug>/tasks/<task-slug>/',
    '  result.md',
    '  notes.md',
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
    'Use it for personal notes, drafts, and private working context that should not be shared through the project.',
    '',
    'You may create files and directories here freely. Move project-facing issue records to `/projects/<slug>/issues` and task results to `/projects/<slug>/tasks`.',
    '',
  ].join('\n')
}

function createProjectReadme(projectSlug = DEFAULT_PROJECT_SLUG): string {
  return [
    '# Project',
    '',
    `This directory is the project workspace for \`${projectSlug}\`.`,
    '',
    ...PROJECT_DIRECTORIES.map((directory) => `- \`${directory.name}/\`: ${directory.purpose}`),
    '',
  ].join('\n')
}

export function getWorkspaceWritablePaths(opts: {
  homeMountPath?: string
  projectMountPath?: string
  projectSlug?: string
  projectsMountPath?: string
  tmpMountPath?: string
} = {}): string[] {
  const homeMountPath = opts.homeMountPath ?? HOME_MOUNT_PATH
  const projectsMountPath = opts.projectsMountPath ?? PROJECTS_MOUNT_PATH
  const projectSlug = opts.projectSlug ?? DEFAULT_PROJECT_SLUG
  const projectMountPath = opts.projectMountPath ?? posix.join(projectsMountPath, projectSlug)
  const tmpMountPath = opts.tmpMountPath ?? TMP_MOUNT_PATH

  return [...new Set([
    homeMountPath,
    ...PROJECT_DIRECTORIES.map((directory) => posix.join(projectMountPath, directory.name)),
    tmpMountPath,
  ])]
}

export function getWorkspaceReadOnlyPaths(opts: {
  homeMountPath?: string
  projectMountPath?: string
  projectSlug?: string
  projectsMountPath?: string
} = {}): string[] {
  const homeMountPath = opts.homeMountPath ?? HOME_MOUNT_PATH
  const projectsMountPath = opts.projectsMountPath ?? PROJECTS_MOUNT_PATH
  const projectSlug = opts.projectSlug ?? DEFAULT_PROJECT_SLUG
  const projectMountPath = opts.projectMountPath ?? posix.join(projectsMountPath, projectSlug)

  return [...new Set([
    ROOT_README_PATH,
    posix.join(homeMountPath, 'README.md'),
    posix.join(projectMountPath, 'README.md'),
    ...PROJECT_DIRECTORIES.map((directory) => posix.join(projectMountPath, directory.name, 'README.md')),
  ])]
}

export async function ensureWorkspaceLayout(
  rootPath: string,
  opts: {
    homeRootPath?: string
    projectSlug?: string
    projectRootPath?: string
  } = {},
): Promise<void> {
  const resolvedRootPath = resolve(rootPath)
  const projectSlug = opts.projectSlug ?? DEFAULT_PROJECT_SLUG
  await mkdir(resolvedRootPath, { recursive: true })

  const homeRootPath = resolve(opts.homeRootPath ?? resolve(resolvedRootPath, 'home'))
  const projectRootPath = resolve(opts.projectRootPath ?? resolve(resolvedRootPath, 'projects', projectSlug))

  await writeFileIfMissing(resolve(resolvedRootPath, 'README.md'), createWorkspaceReadme())

  await mkdir(homeRootPath, { recursive: true })
  await writeFileIfMissing(resolve(homeRootPath, 'README.md'), createHomeReadme())

  await mkdir(projectRootPath, { recursive: true })
  await writeFileIfMissing(resolve(projectRootPath, 'README.md'), createProjectReadme(projectSlug))
  for (const directory of PROJECT_DIRECTORIES) {
    const directoryPath = resolve(projectRootPath, directory.name)
    await mkdir(directoryPath, { recursive: true })
    await writeFileIfMissing(resolve(directoryPath, 'README.md'), directory.readme)
  }

}
