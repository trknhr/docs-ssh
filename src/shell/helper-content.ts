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

function createWorkspaceList(sourceStore: SourceStore): string[] {
  return [
    '- `/README.md` -> root guide and writing rules',
    `- \`${sourceStore.homeMountPath}\` -> private personal notes for the authenticated principal`,
    `- \`${sourceStore.projectMountPath}\` -> current project workspace`,
    `- \`${sourceStore.projectMountPath}/issues\` -> issue tracking: what to do, why, status, next action, and result links`,
    `- \`${sourceStore.projectMountPath}/tasks\` -> research and work results`,
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
    `- Do not create new directories directly under \`${sourceStore.projectsMountPath}\`; projects are server-managed resources.`,
    '- For non-interactive SSH exec writes, prefer remote-side `printf` or `echo` commands over heredocs or `cat > file`.',
    '- After writing a file over SSH, read it back with `cat` or inspect it with `ls -l` to confirm the content arrived.',
    `- Use \`${sourceStore.tmpMountPath}\` for temporary files.`,
  ]
}

function createExamples(sshPrefix: string, sourceStore: SourceStore): string[] {
  return [
    'docs-ssh status --json',
    'docs-ssh login --json',
    `${sshPrefix} bootstrap --json`,
    `${sshPrefix} cat /README.md`,
    `${sshPrefix} cat ${sourceStore.projectMountPath}/README.md`,
    `${sshPrefix} ls ${sourceStore.projectMountPath}/issues`,
    `${sshPrefix} "printf '%s\\n' '# Example issue' 'status: open' 'next: inspect docs' > ${sourceStore.projectMountPath}/issues/example-issue.md"`,
    `${sshPrefix} mkdir -p ${sourceStore.projectMountPath}/tasks/example-task/artifacts`,
    `${sshPrefix} "printf '%s\\n' '# Notes' '- item' > ${sourceStore.projectMountPath}/tasks/example-task/notes.md"`,
    `${sshPrefix} sh -lc 'echo \"- note\" >> ${sourceStore.projectMountPath}/tasks/example-task/notes.md'`,
    `${sshPrefix} cat ${sourceStore.projectMountPath}/tasks/example-task/notes.md`,
  ]
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
    `Use \`${opts.sourceStore.projectMountPath}/issues\` for issue tracking and \`${opts.sourceStore.projectMountPath}/tasks\` for research and work results.`,
    '',
    'Available paths:',
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
    `description: Inspect and update the ${opts.docsName} SSH project workspace using shell tools like ls, find, and cat.`,
    '---',
    '',
    '# docs-ssh',
    '',
    `Use ${sshPrefix} to inspect the mounted project filesystem before making changes.`,
    '',
    'Project paths:',
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
    `This server exposes ${opts.docsName} through a project-oriented SSH filesystem with private notes, issues, and task results.`,
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
