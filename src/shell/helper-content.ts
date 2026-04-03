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
    lines.push(`- \`/docs\` -> default source (\`${sourceStore.defaultSource.name}\`)`)
  } else {
    lines.push('- `/docs` -> default source')
  }

  for (const source of sourceStore.registry.sources) {
    lines.push(`- \`${getSourceMountPath(source.name)}\``)
  }

  return lines
}

function createExamples(sshPrefix: string, sourceStore: SourceStore): string[] {
  const examples = [
    `${sshPrefix} find /docs -name '*.md' | head`,
    `${sshPrefix} grep -R "keyword" /docs`,
    `${sshPrefix} cat /docs/index.md`,
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
    `Before implementing against ${opts.docsName}, inspect the mounted docs over SSH first.`,
    'Use `/docs` for the default source and `/sources/<name>` for any additional ingested sources.',
    '',
    'Available paths:',
    ...createSourceList(opts.sourceStore),
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
    `description: Search and read ${opts.docsName} over SSH using shell tools like grep, find, and cat.`,
    '---',
    '',
    '# docs-ssh',
    '',
    `Use ${sshPrefix} to inspect the mounted docs before making changes.`,
    '',
    'Default and named mounts:',
    ...createSourceList(opts.sourceStore),
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
    `This server exposes ${opts.docsName} through a read-only SSH shell backed by just-bash.`,
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
    'Suggested paths by tool:',
    '',
    ...createSetupPaths(),
    '',
  ].join('\n')
}
