import { getProjectSourceMountPath } from '../sources/source-store.js'
import type { SourceStore } from '../sources/types.js'

export interface HelperContentOptions {
  docsName: string
  sourceStore: SourceStore
  sshHost: string
  sshPort: number
}

function formatSshPrefix(host: string, port: number): string {
  return port === 22 ? `ssh ${host}` : `ssh ${host} -p ${port}`
}

function createSourceList(sourceStore: SourceStore): string[] {
  const lines: string[] = []

  if (sourceStore.defaultSource) {
    lines.push(`- \`${sourceStore.projectDocsMountPath}\` -> default source (\`${sourceStore.defaultSource.name}\`)`)
  } else {
    lines.push(`- \`${sourceStore.projectDocsMountPath}\` -> default source`)
  }

  for (const source of sourceStore.registry.sources) {
    lines.push(`- \`${getProjectSourceMountPath(source.name, sourceStore.projectMountPath)}\``)
  }

  return lines
}

function createWorkspaceList(sourceStore: SourceStore): string[] {
  return [
    '- `/README.md` -> root guide and writing rules',
    `- \`${sourceStore.homeMountPath}\` -> private personal notes for the authenticated principal`,
    `- \`${sourceStore.projectMountPath}\` -> current project workspace`,
    `- \`${sourceStore.projectMountPath}/issues\` -> issue tracking: what to do, why, status, next action, and result links`,
    `- \`${sourceStore.projectMountPath}/tasks\` -> research and work results`,
    `- \`${sourceStore.projectMountPath}/docs\` -> polished long-term project references`,
    `- \`${sourceStore.tmpMountPath}\` -> temporary session-local files`,
  ]
}

function createWorkspaceRules(sourceStore: SourceStore): string[] {
  return [
    '- Run `docs-ssh status --json` first. If no active session exists, run `docs-ssh login --json` and use the returned `sshCommand` for SSH access.',
    `- Run \`bootstrap --json\`, then read \`/README.md\` and \`${sourceStore.projectMountPath}/README.md\` before writing files.`,
    `- Use \`${sourceStore.homeMountPath}\` for private personal notes.`,
    `- Use \`${sourceStore.projectMountPath}/issues\` for issue tracking: what to do, why, status, next action, and result links.`,
    `- Use \`${sourceStore.projectMountPath}/tasks\` for research and work results: logs, conclusions, verification, proposals, and generated artifacts.`,
    `- Use \`${sourceStore.projectMountPath}/docs\` only for polished references that should stay useful long-term.`,
    `- Do not create new directories directly under \`${sourceStore.projectsMountPath}\`; projects are server-managed resources.`,
    '- For non-interactive SSH exec writes, prefer remote-side `printf` or `echo` commands over heredocs or `cat > file`.',
    '- After writing a file over SSH, read it back with `cat` or inspect it with `ls -l` to confirm the content arrived.',
    `- Use \`${sourceStore.tmpMountPath}\` for temporary files.`,
  ]
}

function createExamples(sshPrefix: string, sourceStore: SourceStore): string[] {
  const examples = [
    'docs-ssh status --json',
    'docs-ssh login --json',
    `${sshPrefix} bootstrap --json`,
    `${sshPrefix} cat /README.md`,
    `${sshPrefix} cat ${sourceStore.projectMountPath}/README.md`,
    `${sshPrefix} ls ${sourceStore.projectMountPath}/issues`,
    `${sshPrefix} find ${sourceStore.projectDocsMountPath} -name '*.md' | head`,
    `${sshPrefix} grep -R "keyword" ${sourceStore.projectDocsMountPath}`,
    `${sshPrefix} "printf '%s\\n' '# Example issue' 'status: open' 'next: inspect docs' > ${sourceStore.projectMountPath}/issues/example-issue.md"`,
    `${sshPrefix} mkdir -p ${sourceStore.projectMountPath}/tasks/example-task/artifacts`,
    `${sshPrefix} "printf '%s\\n' '# Notes' '- item' > ${sourceStore.projectMountPath}/tasks/example-task/notes.md"`,
    `${sshPrefix} sh -lc 'echo \"- note\" >> ${sourceStore.projectMountPath}/tasks/example-task/notes.md'`,
    `${sshPrefix} cat ${sourceStore.projectMountPath}/tasks/example-task/notes.md`,
  ]

  const nonDefaultSource = sourceStore.registry.sources.find(
    (source) => source.name !== sourceStore.registry.defaultSourceName,
  )

  if (nonDefaultSource) {
    examples.push(`${sshPrefix} grep -R "keyword" ${getProjectSourceMountPath(nonDefaultSource.name, sourceStore.projectMountPath)}`)
  }

  return examples
}

function createSetupPaths(): string[] {
  return [
    '| Tool | Instructions file | Skill path |',
    '|------|-------------------|------------|',
    '| Claude Code | `CLAUDE.md` | `.claude/skills/docs-ssh/SKILL.md` |',
    '| Codex | `AGENTS.md` | `.agents/skills/docs-ssh/SKILL.md` |',
    '| Cursor | `AGENTS.md` | `.agents/skills/docs-ssh/SKILL.md` |',
    '| Gemini CLI | `GEMINI.md` | `.agents/skills/docs-ssh/SKILL.md` |',
    '| GitHub Copilot | `AGENTS.md` | `.github/skills/docs-ssh/SKILL.md` |',
  ]
}

export function createAgentsMarkdown(opts: HelperContentOptions): string {
  const sshPrefix = formatSshPrefix(opts.sshHost, opts.sshPort)

  return [
    '## docs-ssh',
    '',
    `Before implementing against ${opts.docsName}, inspect the mounted project filesystem over SSH first.`,
    `Use \`${opts.sourceStore.projectMountPath}/issues\` for issue tracking, \`${opts.sourceStore.projectMountPath}/tasks\` for research and work results, \`${opts.sourceStore.projectDocsMountPath}\` for polished references, and \`${opts.sourceStore.projectMountPath}/sources/<name>\` for additional ingested sources.`,
    '',
    'Available paths:',
    ...createSourceList(opts.sourceStore),
    ...createWorkspaceList(opts.sourceStore),
    '',
    'Workspace rules:',
    ...createWorkspaceRules(opts.sourceStore),
    '',
    'Examples:',
    '',
    '```bash',
    ...createExamples(sshPrefix, opts.sourceStore),
    '```',
    '',
  ].join('\n')
}

export function createSkillMarkdown(opts: HelperContentOptions): string {
  const sshPrefix = formatSshPrefix(opts.sshHost, opts.sshPort)

  return [
    '---',
    'name: docs-ssh',
    `description: Search and update the ${opts.docsName} SSH filesystem using shell tools like grep, find, and cat.`,
    '---',
    '',
    '# docs-ssh',
    '',
    `Use ${sshPrefix} to inspect the mounted project filesystem before making changes.`,
    '',
    'Project paths:',
    ...createSourceList(opts.sourceStore),
    ...createWorkspaceList(opts.sourceStore),
    '',
    'Workspace rules:',
    ...createWorkspaceRules(opts.sourceStore),
    '',
    'Example commands:',
    '',
    '```bash',
    ...createExamples(sshPrefix, opts.sourceStore),
    '```',
    '',
  ].join('\n')
}

export function createSetupMarkdown(opts: HelperContentOptions): string {
  const sshPrefix = formatSshPrefix(opts.sshHost, opts.sshPort)

  return [
    '# docs-ssh Setup',
    '',
    `This server exposes ${opts.docsName} through a project-oriented SSH filesystem with private notes, issues, task results, and docs.`,
    '',
    'Choose one of these setup flows:',
    '',
    '1. Append lightweight instructions to your agent instructions file.',
    '2. Install a reusable `docs-ssh` skill into your tool-specific skills directory.',
    '3. Do both.',
    '',
    'Install the local CLI first:',
    '',
    '```bash',
    'git clone https://github.com/trknhr/docs-ssh.git',
    'cd docs-ssh',
    'pnpm install',
    'pnpm run build',
    'npm link',
    'docs-ssh status --json',
    '```',
    '',
    '`npm link` creates the global `docs-ssh` command for the cloned repo. The reusable skill expects `docs-ssh` to be available in `PATH`. Rerun `pnpm run build:server` after editing CLI or server TypeScript.',
    '',
    'Append to instructions:',
    '',
    '```bash',
    `${sshPrefix} agents >> AGENTS.md`,
    '```',
    '',
    'Install the skill:',
    '',
    '```bash',
    'mkdir -p .agents/skills/docs-ssh',
    `${sshPrefix} skill > .agents/skills/docs-ssh/SKILL.md`,
    '```',
    '',
    'Preview the generated helper files:',
    '',
    '```bash',
    `${sshPrefix} agents`,
    `${sshPrefix} skill`,
    `${sshPrefix} setup`,
    '```',
    '',
    'Filesystem paths:',
    ...createWorkspaceList(opts.sourceStore),
    '',
    'Workspace rules:',
    ...createWorkspaceRules(opts.sourceStore),
    '',
    'Suggested paths by tool:',
    '',
    ...createSetupPaths(),
    '',
  ].join('\n')
}
