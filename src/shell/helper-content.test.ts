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
  const projectDocs = createSource('project-docs', '/data/project-docs')
  const reference = createSource('reference', '/data/reference')

  return {
    registry: {
      version: 1,
      defaultSourceName: projectDocs.name,
      sources: [projectDocs, reference],
    },
    mounts: [
      {
        sourceName: projectDocs.name,
        mountPoint: '/projects/default/sources/project-docs',
        rootPath: projectDocs.rootPath,
      },
      {
        sourceName: projectDocs.name,
        mountPoint: '/projects/default/docs',
        rootPath: projectDocs.rootPath,
      },
      {
        sourceName: reference.name,
        mountPoint: '/projects/default/sources/reference',
        rootPath: reference.rootPath,
      },
    ],
    defaultSource: projectDocs,
    homeMountPath: '/home',
    projectDocsMountPath: '/projects/default/docs',
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
  it('renders agents markdown with docs, issues, tasks, and named source guidance', () => {
    const markdown = createAgentsMarkdown({
      docsName: 'Project Docs',
      sourceStore: createSourceStoreFixture(),
      sshHost: 'docs-ssh',
      sshPort: 2222,
    })

    expect(markdown).toContain('Before implementing against Project Docs, inspect the mounted project filesystem over SSH first.')
    expect(markdown).toContain('- `/projects/default/docs` -> default source (`project-docs`)')
    expect(markdown).toContain('- `/projects/default/sources/reference`')
    expect(markdown).toContain('- `/projects/default/issues` -> issue tracking')
    expect(markdown).toContain('- `/projects/default/tasks` -> research and work results')
    expect(markdown).toContain('- `/home` -> private personal notes')
    expect(markdown).toContain('Run `bootstrap --json`')
    expect(markdown).toContain('Do not create new directories directly under `/projects`')
    expect(markdown).toContain('prefer remote-side `printf` or `echo` commands over heredocs or `cat > file`')
    expect(markdown).toContain('ssh docs-ssh -p 2222 bootstrap --json')
    expect(markdown).toContain('ssh docs-ssh -p 2222 grep -R "keyword" /projects/default/docs')
    expect(markdown).toContain(
      `ssh docs-ssh -p 2222 "printf '%s\\n' '# Example issue' 'status: open' 'next: inspect docs' > /projects/default/issues/example-issue.md"`,
    )
    expect(markdown).toContain(`ssh docs-ssh -p 2222 "printf '%s\\n' '# Notes' '- item' > /projects/default/tasks/example-task/notes.md"`)
    expect(markdown).toContain('ssh docs-ssh -p 2222 cat /projects/default/tasks/example-task/notes.md')
    expect(markdown).toContain('ssh docs-ssh -p 2222 grep -R "keyword" /projects/default/sources/reference')
  })

  it('renders skill markdown and omits -p for the standard ssh port', () => {
    const markdown = createSkillMarkdown({
      docsName: 'Project Docs',
      sourceStore: createSourceStoreFixture(),
      sshHost: 'docs.example.com',
      sshPort: 22,
    })

    expect(markdown).toContain('description: Search and update the Project Docs SSH filesystem using shell tools like grep, find, and cat.')
    expect(markdown).toContain('Use ssh docs.example.com to inspect the mounted project filesystem before making changes.')
    expect(markdown).not.toContain('-p 22')
    expect(markdown).toContain('ssh docs.example.com bootstrap --json')
    expect(markdown).toContain('prefer remote-side `printf` or `echo` commands over heredocs or `cat > file`')
    expect(markdown).toContain('ssh docs.example.com grep -R "keyword" /projects/default/docs')
  })

  it('renders setup markdown with installation flows and tool paths', () => {
    const markdown = createSetupMarkdown({
      docsName: 'Project Docs',
      sourceStore: createSourceStoreFixture(),
      sshHost: 'docs-ssh',
      sshPort: 2222,
    })

    expect(markdown).toContain('Choose one of these setup flows:')
    expect(markdown).toContain('git clone https://github.com/trknhr/docs-ssh.git')
    expect(markdown).toContain('npm link')
    expect(markdown).toContain('docs-ssh status --json')
    expect(markdown).toContain('ssh docs-ssh -p 2222 agents >> AGENTS.md')
    expect(markdown).toContain('mkdir -p .agents/skills/docs-ssh')
    expect(markdown).toContain('ssh docs-ssh -p 2222 skill > .agents/skills/docs-ssh/SKILL.md')
    expect(markdown).toContain('| Codex | `AGENTS.md` | `.agents/skills/docs-ssh/SKILL.md` |')
    expect(markdown).toContain('ssh docs-ssh -p 2222 setup')
  })
})
