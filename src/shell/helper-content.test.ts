import { describe, expect, it } from 'vitest'
import { createAgentsMarkdown, createSetupMarkdown, createSkillMarkdown } from './helper-content.js'
import type { SourceSpec, SourceStore } from '../sources/types.js'

function createSource(name: string, rootPath: string): SourceSpec {
  return {
    name,
    type: 'local-folder',
    rootPath,
    managed: false,
    createdAt: '2026-04-06T00:00:00.000Z',
  }
}

function createSourceStoreFixture(): SourceStore {
  const primary = createSource('primary', '/data/primary')
  const reference = createSource('reference', '/data/reference')

  return {
    registry: {
      version: 1,
      defaultSourceName: primary.name,
      sources: [primary, reference],
    },
    defaultSource: primary,
    homeMountPath: '/home',
    projectMountPath: '/projects/default',
    projectSlug: 'default',
    projectsMountPath: '/projects',
    sharedMountPath: '/shared',
    tmpMountPath: '/tmp',
    homeRootPath: '/data/workspace/tenants/default/principals/owner/home',
    projectRootPath: '/data/workspace/tenants/default/projects/default',
    sharedRootPath: '/data/workspace/tenants/default/shared',
    tenantRootPath: '/data/workspace/tenants/default',
    workspaceRootPath: '/data/workspace',
  }
}

describe('helper content', () => {
  it('renders agents markdown with docs, issues, and tasks guidance', () => {
    const markdown = createAgentsMarkdown({
      docsName: 'Project Docs',
      sourceStore: createSourceStoreFixture(),
      sshHost: 'docs-ssh',
      sshPort: 2222,
    })

    expect(markdown).toContain('Before implementing against Project Docs, inspect the mounted project filesystem over SSH first.')
    expect(markdown).toContain('- `/projects/default/issues` -> issue tracking')
    expect(markdown).toContain('- `/projects/default/tasks` -> research and work results')
    expect(markdown).toContain('- `/home` -> private personal notes')
    expect(markdown).toContain('Run `bootstrap --json`')
    expect(markdown).toContain('Do not create new directories directly under `/projects`')
    expect(markdown).toContain('pipe newline-separated commands into `batch`')
    expect(markdown).toContain('Use `read-range [-n] <path> <start> <end>`')
    expect(markdown).toContain('npx docs-ssh@latest status --json')
    expect(markdown).toContain('npx docs-ssh@latest login --json')
    expect(markdown).toContain('Web/OIDC login is server-wide and is not scoped to a project')
    expect(markdown).toContain(
      'Treat `/projects/default` as the primary project workspace for this directory, even if the SSH session or `bootstrap --json` reports a different current project',
    )
    expect(markdown).toContain('Non-interactive SSH exec stdin is supported')
    expect(markdown).toContain('docs-ssh-batch')
    expect(markdown).toContain('ssh docs-ssh -p 2222 bootstrap --json')
    expect(markdown).toContain('ssh docs-ssh -p 2222 read-range -n /README.md 1 80')
    expect(markdown).toContain(
      `printf '%s\\n' 'find /projects/default/tasks -maxdepth 1 -type f' 'read-range -n /README.md 1 40' | ssh docs-ssh -p 2222 batch`,
    )
    expect(markdown).toContain(
      `ssh docs-ssh -p 2222 "printf '%s\\n' '# Example issue' 'status: open' 'next: inspect docs' > /projects/default/issues/example-issue.md"`,
    )
    expect(markdown).toContain(`ssh docs-ssh -p 2222 "printf '%s\\n' '# Notes' '- item' > /projects/default/tasks/example-task/notes.md"`)
    expect(markdown).toContain('ssh docs-ssh -p 2222 cat /projects/default/tasks/example-task/notes.md')
    expect(markdown).not.toContain('/sources')
  })

  it('renders skill markdown and omits -p for the standard ssh port', () => {
    const markdown = createSkillMarkdown({
      docsName: 'Project Docs',
      sourceStore: createSourceStoreFixture(),
      sshHost: 'docs.example.com',
      sshPort: 22,
    })

    expect(markdown).toContain('description: Inspect and update the Project Docs SSH project workspace using shell tools like ls, find, and cat.')
    expect(markdown).toContain('Use ssh docs.example.com to inspect the mounted project filesystem before making changes.')
    expect(markdown).not.toContain('-p 22')
    expect(markdown).toContain('ssh docs.example.com bootstrap --json')
    expect(markdown).toContain('npx docs-ssh@latest status --json')
    expect(markdown).toContain('Web/OIDC login is server-wide and is not scoped to a project')
    expect(markdown).toContain(
      'Treat `/projects/default` as the primary project workspace for this directory, even if the SSH session or `bootstrap --json` reports a different current project',
    )
    expect(markdown).toContain('pipe newline-separated commands into `batch`')
    expect(markdown).toContain('read-range -n /README.md 1 80')
    expect(markdown).toContain('Non-interactive SSH exec stdin is supported')
    expect(markdown).toContain('docs-ssh-batch')
    expect(markdown).not.toContain('/sources')
  })

  it('renders setup markdown with installation flows and tool paths', () => {
    const markdown = createSetupMarkdown({
      docsName: 'Project Docs',
      sourceStore: createSourceStoreFixture(),
      sshHost: 'docs-ssh',
      sshPort: 2222,
    })

    expect(markdown).toContain('Choose one of these setup flows:')
    expect(markdown).toContain('Run the CLI without a global install:')
    expect(markdown).toContain('npx docs-ssh@latest status --json')
    expect(markdown).toContain('npx docs-ssh@latest agents --output AGENTS.md --append --ssh-host docs-ssh --ssh-port 2222')
    expect(markdown).toContain('npx docs-ssh@latest skill --output .agents/skills/docs-ssh/SKILL.md --ssh-host docs-ssh --ssh-port 2222')
    expect(markdown).toContain('| Codex | `AGENTS.md` | `.agents/skills/docs-ssh/SKILL.md` |')
    expect(markdown).toContain('npx docs-ssh@latest setup --ssh-host docs-ssh --ssh-port 2222')
    expect(markdown).toContain('ssh docs-ssh -p 2222 setup')
  })
})
