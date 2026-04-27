import { access, mkdir, writeFile } from 'node:fs/promises'
import { posix, resolve } from 'node:path'

const WORKSPACE_MOUNT_PATH = '/workspace'
const TMP_MOUNT_PATH = '/tmp'
const WORKSPACE_GUIDE_FILES = ['README.md', '_policy.json'] as const
const TASK_TEMPLATE_FILES = ['brief.md', 'plan.md', 'notes.md', 'handoff.md'] as const

interface WorkspaceDirectoryTemplate {
  name: 'archive' | 'decisions' | 'library' | 'shared' | 'tasks'
  purpose: string
  readme: string
  reserved?: boolean
}

const WORKSPACE_DIRECTORIES: WorkspaceDirectoryTemplate[] = [
  {
    name: 'tasks',
    purpose: 'Active task-specific work. Create one directory per task.',
    readme: [
      '# Tasks',
      '',
      'Create one directory per active task under `/workspace/tasks/<task-slug>/`.',
      '',
      'Suggested task layout:',
      '',
      '```text',
      '/workspace/tasks/<task-slug>/',
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
    name: 'library',
    purpose: 'Reusable personal references, playbooks, snippets, and prompts.',
    readme: [
      '# Library',
      '',
      'Store reusable personal material that is not tied to a single task.',
      '',
      'Good fits:',
      '',
      '- references',
      '- playbooks',
      '- snippets',
      '- prompts',
      '',
      'Do not use this directory for future shared or team-facing material.',
      `That belongs in \`${WORKSPACE_MOUNT_PATH}/shared/\` once sharing exists.`,
      '',
    ].join('\n'),
  },
  {
    name: 'decisions',
    purpose: 'Durable notes for cross-task decisions.',
    readme: [
      '# Decisions',
      '',
      'Store durable decisions that affect multiple tasks or future work.',
      '',
      'Suggested naming:',
      '',
      '- `YYYY-MM-DD-topic.md`',
      '',
      'Each note should capture context, the decision, and follow-up implications.',
      '',
    ].join('\n'),
  },
  {
    name: 'archive',
    purpose: 'Completed task folders and retired notes.',
    readme: [
      '# Archive',
      '',
      'Move completed task folders or retired notes here once they are no longer active.',
      '',
      'Keep original task slugs when possible so old references stay easy to find.',
      '',
    ].join('\n'),
  },
  {
    name: 'shared',
    purpose: 'Reserved for future multi-user sharing.',
    reserved: true,
    readme: [
      '# Shared',
      '',
      'Reserved for future multi-user sharing.',
      '',
      'Until shared workflows exist:',
      '',
      '- do not depend on this directory for personal task notes',
      `- keep private work in \`${WORKSPACE_MOUNT_PATH}/tasks/\` or \`${WORKSPACE_MOUNT_PATH}/library/\``,
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
    '# Workspace',
    '',
    'This directory persists across SSH sessions.',
    '',
    'Use these top-level directories:',
    '',
    ...WORKSPACE_DIRECTORIES.map((directory) => {
      const reservedSuffix = directory.reserved ? ' Reserved for future use.' : ''
      return `- \`${directory.name}/\`: ${directory.purpose}${reservedSuffix}`
    }),
    '',
    'Rules:',
    '',
    `- Do not add additional loose files or new top-level directories under \`${WORKSPACE_MOUNT_PATH}/\`.`,
    `- Read \`${WORKSPACE_MOUNT_PATH}/_policy.json\` before automating writes.`,
    `- Use \`${TMP_MOUNT_PATH}/\` for temporary files that do not need to persist.`,
    '- Prefer lowercase kebab-case names for task directories and note files.',
    '',
    'Suggested task layout:',
    '',
    '```text',
    '/workspace/tasks/<task-slug>/',
    ...TASK_TEMPLATE_FILES.map((file) => `  ${file}`),
    '  artifacts/',
    '```',
    '',
  ].join('\n')
}

function createWorkspacePolicy(): string {
  const policy = {
    schemaVersion: 1,
    root: WORKSPACE_MOUNT_PATH,
    tmpRoot: TMP_MOUNT_PATH,
    readFirst: [`${WORKSPACE_MOUNT_PATH}/README.md`, `${WORKSPACE_MOUNT_PATH}/_policy.json`],
    rules: [
      `Do not create additional loose files or new top-level directories under ${WORKSPACE_MOUNT_PATH}/.`,
      `Create active work under ${WORKSPACE_MOUNT_PATH}/tasks/<task-slug>/.`,
      `Store reusable personal material under ${WORKSPACE_MOUNT_PATH}/library/.`,
      `Record durable cross-task decisions under ${WORKSPACE_MOUNT_PATH}/decisions/.`,
      `Move completed work to ${WORKSPACE_MOUNT_PATH}/archive/.`,
      `Treat ${WORKSPACE_MOUNT_PATH}/shared/ as reserved for future multi-user sharing.`,
      `Use ${TMP_MOUNT_PATH}/ for temporary files.`,
    ],
    naming: {
      taskSlugStyle: 'kebab-case',
      noteFileStyle: 'kebab-case-or-standard-markdown',
    },
    taskTemplate: {
      suggestedFiles: [...TASK_TEMPLATE_FILES],
      suggestedDirectories: ['artifacts'],
    },
    directories: Object.fromEntries(
      WORKSPACE_DIRECTORIES.map((directory) => [
        directory.name,
        {
          purpose: directory.purpose,
          reserved: directory.reserved ?? false,
          readme: `${WORKSPACE_MOUNT_PATH}/${directory.name}/README.md`,
        },
      ]),
    ),
  }

  return `${JSON.stringify(policy, null, 2)}\n`
}

export function getWorkspaceWritablePaths(mountPath = WORKSPACE_MOUNT_PATH): string[] {
  return WORKSPACE_DIRECTORIES.filter((directory) => !directory.reserved).map((directory) =>
    posix.join(mountPath, directory.name),
  )
}

export function getWorkspaceReadOnlyPaths(mountPath = WORKSPACE_MOUNT_PATH): string[] {
  return [
    ...WORKSPACE_GUIDE_FILES.map((file) => posix.join(mountPath, file)),
    ...WORKSPACE_DIRECTORIES.map((directory) => posix.join(mountPath, directory.name, 'README.md')),
  ]
}

export async function ensureWorkspaceLayout(rootPath: string): Promise<void> {
  const resolvedRootPath = resolve(rootPath)
  await mkdir(resolvedRootPath, { recursive: true })

  for (const directory of WORKSPACE_DIRECTORIES) {
    const directoryPath = resolve(resolvedRootPath, directory.name)
    await mkdir(directoryPath, { recursive: true })
    await writeFileIfMissing(resolve(directoryPath, 'README.md'), directory.readme)
  }

  await writeFileIfMissing(resolve(resolvedRootPath, 'README.md'), createWorkspaceReadme())
  await writeFileIfMissing(resolve(resolvedRootPath, '_policy.json'), createWorkspacePolicy())
}
