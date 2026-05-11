import { getSourceMountPath } from '../sources/source-store.js'
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
    lines.push(`- \`${getSourceMountPath(source.name)}\``)
  }

  return lines
}

function createWorkspaceList(sourceStore: SourceStore): string[] {
  return [
    '- `/README.md` -> root guide and writing rules',
    `- \`${sourceStore.homeMountPath}\` -> private personal notes for the authenticated principal`,
    `- \`${sourceStore.projectMountPath}\` -> current project alias`,
    `- \`${sourceStore.projectMountPath}/issues\` -> issue tracking: what to do, why, status, next action, and result links`,
    `- \`${sourceStore.projectMountPath}/tasks\` -> research and work results`,
    `- \`${sourceStore.projectMountPath}/docs\` -> polished long-term project references`,
    `- \`${sourceStore.projectsMountPath}/${sourceStore.projectSlug}\` -> concrete current project path`,
    `- \`${sourceStore.tmpMountPath}\` -> temporary session-local files`,
  ]
}

function createWorkspaceRules(sourceStore: SourceStore): string[] {
  return [
    '- Run `bootstrap --json`, then read `/README.md` and `/project/README.md` before writing files.',
    `- Use \`${sourceStore.homeMountPath}\` for private personal notes.`,
    `- Use \`${sourceStore.projectMountPath}/issues\` for issue tracking: what to do, why, status, next action, and result links.`,
    `- Use \`${sourceStore.projectMountPath}/tasks\` for research and work results: logs, conclusions, verification, proposals, and generated artifacts.`,
    `- Use \`${sourceStore.projectMountPath}/docs\` only for polished references that should stay useful long-term.`,
    '- For non-interactive SSH exec writes, prefer remote-side `printf` or `echo` commands over heredocs or `cat > file`.',
    '- After writing a file over SSH, read it back with `cat` or inspect it with `ls -l` to confirm the content arrived.',
    `- Use \`${sourceStore.tmpMountPath}\` for temporary files.`,
  ]
}

function createExamples(sshPrefix: string, sourceStore: SourceStore): string[] {
  const examples = [
    `${sshPrefix} bootstrap --json`,
    `${sshPrefix} cat /README.md`,
    `${sshPrefix} cat /project/README.md`,
    `${sshPrefix} ls /project/issues`,
    `${sshPrefix} find /project/docs -name '*.md' | head`,
    `${sshPrefix} grep -R "keyword" /project/docs`,
    `${sshPrefix} "printf '%s\\n' '# Example issue' 'status: open' 'next: inspect docs' > /project/issues/example-issue.md"`,
    `${sshPrefix} mkdir -p /project/tasks/example-task/artifacts`,
    `${sshPrefix} "printf '%s\\n' '# Notes' '- item' > /project/tasks/example-task/notes.md"`,
    `${sshPrefix} sh -lc 'echo \"- note\" >> /project/tasks/example-task/notes.md'`,
    `${sshPrefix} cat /project/tasks/example-task/notes.md`,
  ]

  const nonDefaultSource = sourceStore.registry.sources.find(
    (source) => source.name !== sourceStore.registry.defaultSourceName,
  )

  if (nonDefaultSource) {
    examples.push(`${sshPrefix} grep -R "keyword" ${getSourceMountPath(nonDefaultSource.name)}`)
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
    'Use `/project/issues` for issue tracking, `/project/tasks` for research and work results, `/project/docs` for polished references, and `/project/sources/<name>` for additional ingested sources.',
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
