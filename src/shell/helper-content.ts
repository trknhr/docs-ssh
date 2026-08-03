import type { SourceStore } from '../sources/types.js'

const CLI_COMMAND = 'npx docs-ssh@latest'

export interface HelperContentOptions {
  docsName: string
  sourceStore: SourceStore
  sshHost: string
  sshPort: number
}

function formatSshPrefix(host: string, port: number): string {
  return port === 22 ? `ssh ${host}` : `ssh ${host} -p ${port}`
}

function formatHelperFlags(host: string, port: number): string {
  return port === 22 ? `--ssh-host ${host}` : `--ssh-host ${host} --ssh-port ${port}`
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
    `- Run \`${CLI_COMMAND} status --json\` first. If no active session exists, run \`${CLI_COMMAND} login --json\` and use the returned \`sshCommand\` for SSH access.`,
    '- Web/OIDC login is server-wide and is not scoped to a project.',
    `- Treat \`${sourceStore.projectMountPath}\` as the primary project workspace for this directory, even if the SSH session or \`bootstrap --json\` reports a different current project.`,
    `- Run \`bootstrap --json\`, then read \`/README.md\` and \`${sourceStore.projectMountPath}/README.md\` before writing files.`,
    `- Use \`${sourceStore.homeMountPath}\` for private personal notes.`,
    `- Use \`${sourceStore.projectMountPath}/issues\` for issue tracking: what to do, why, status, next action, and result links.`,
    `- Use \`${sourceStore.projectMountPath}/tasks\` for research and work results: logs, conclusions, verification, proposals, and generated artifacts.`,
    `- Put self-contained HTML in \`${sourceStore.projectMountPath}/tasks/<task-slug>/artifacts/\`, then publish it with \`${CLI_COMMAND} artifact publish tasks/<task-slug>/artifacts/<name>.html\`.`,
    `- Do not create new directories directly under \`${sourceStore.projectsMountPath}\`; projects are server-managed resources.`,
    '- Non-interactive SSH exec stdin is supported; use `cat > file` or tar streams for larger writes, and remote-side `printf` or `echo` for short literals.',
    '- To reduce SSH round trips, pipe newline-separated commands into `batch` (also available as `docs-ssh-batch` and `ssh-batch`); it returns one JSON object per command.',
    '- Use `read-range [-n] <path> <start> <end>` instead of `cat` when you only need a small part of a large file.',
    '- After writing a file over SSH, read it back with `cat` or inspect it with `ls -l` to confirm the content arrived.',
    `- Use \`${sourceStore.tmpMountPath}\` for temporary files.`,
  ]
}

function createExamples(sshPrefix: string, sourceStore: SourceStore): string[] {
  return [
    `${CLI_COMMAND} status --json`,
    `${CLI_COMMAND} login --json`,
    `${sshPrefix} bootstrap --json`,
    `${sshPrefix} cat /README.md`,
    `${sshPrefix} cat ${sourceStore.projectMountPath}/README.md`,
    `${sshPrefix} ls ${sourceStore.projectMountPath}/issues`,
    `${sshPrefix} read-range -n /README.md 1 80`,
    `printf '%s\\n' 'find ${sourceStore.projectMountPath}/tasks -maxdepth 1 -type f' 'read-range -n /README.md 1 40' | ${sshPrefix} batch`,
    `${sshPrefix} "printf '%s\\n' '# Example issue' 'status: open' 'next: inspect docs' > ${sourceStore.projectMountPath}/issues/example-issue.md"`,
    `${sshPrefix} mkdir -p ${sourceStore.projectMountPath}/tasks/example-task/artifacts`,
    `${sshPrefix} "printf '%s\\n' '# Notes' '- item' > ${sourceStore.projectMountPath}/tasks/example-task/notes.md"`,
    `${sshPrefix} sh -lc 'echo \"- note\" >> ${sourceStore.projectMountPath}/tasks/example-task/notes.md'`,
    `${sshPrefix} cat ${sourceStore.projectMountPath}/tasks/example-task/notes.md`,
    `${CLI_COMMAND} artifact publish tasks/example-task/artifacts/index.html`,
    `${sshPrefix} artifact list --project ${sourceStore.projectSlug}`,
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
  const helperFlags = formatHelperFlags(opts.sshHost, opts.sshPort)

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
    'Run the CLI without a global install:',
    '',
    '```bash',
    `${CLI_COMMAND} status --json`,
    '```',
    '',
    '`npx` downloads the latest `docs-ssh` CLI on demand, so no global install is required.',
    '',
    'Append to instructions:',
    '',
    '```bash',
    `${CLI_COMMAND} agents --output AGENTS.md --append ${helperFlags}`,
    '```',
    '',
    'Install the skill:',
    '',
    '```bash',
    `${CLI_COMMAND} skill --output .agents/skills/docs-ssh/SKILL.md ${helperFlags}`,
    '```',
    '',
    'Preview the generated helper files from the local CLI or running server:',
    '',
    '```bash',
    `${CLI_COMMAND} agents ${helperFlags}`,
    `${CLI_COMMAND} skill ${helperFlags}`,
    `${CLI_COMMAND} setup ${helperFlags}`,
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
