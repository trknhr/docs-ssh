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
        mountPoint: '/sources/project-docs',
        rootPath: projectDocs.rootPath,
      },
      {
        sourceName: projectDocs.name,
        mountPoint: '/docs',
        rootPath: projectDocs.rootPath,
      },
      {
        sourceName: reference.name,
        mountPoint: '/sources/reference',
        rootPath: reference.rootPath,
      },
    ],
    defaultSource: projectDocs,
    workspaceMountPath: '/workspace',
    tmpMountPath: '/tmp',
    workspaceRootPath: '/data/workspace',
  }
}

describe('helper content', () => {
  it('renders agents markdown with docs, workspace, and named source guidance', () => {
    const markdown = createAgentsMarkdown({
      docsName: 'Project Docs',
      sourceStore: createSourceStoreFixture(),
      sshHost: 'docs-ssh',
      sshPort: 2222,
    })

    expect(markdown).toContain('Before implementing against Project Docs, inspect the mounted docs over SSH first.')
    expect(markdown).toContain('- `/docs` -> default source (`project-docs`)')
    expect(markdown).toContain('- `/sources/reference`')
    expect(markdown).toContain('- `/workspace/shared` -> reserved for future shared use')
    expect(markdown).toContain('prefer remote-side `printf` or `echo` commands over heredocs or `cat > file`')
    expect(markdown).toContain('ssh docs-ssh -p 2222 grep -R "keyword" /docs')
    expect(markdown).toContain(`ssh docs-ssh -p 2222 "printf '%s\\n' '# Notes' '- item' > /workspace/tasks/example-task/notes.md"`)
    expect(markdown).toContain('ssh docs-ssh -p 2222 cat /workspace/tasks/example-task/notes.md')
    expect(markdown).toContain('ssh docs-ssh -p 2222 grep -R "keyword" /sources/reference')
  })

  it('renders skill markdown and omits -p for the standard ssh port', () => {
    const markdown = createSkillMarkdown({
      docsName: 'Project Docs',
      sourceStore: createSourceStoreFixture(),
      sshHost: 'docs.example.com',
      sshPort: 22,
    })

    expect(markdown).toContain('description: Search and read Project Docs over SSH using shell tools like grep, find, and cat.')
    expect(markdown).toContain('Use ssh docs.example.com to inspect the mounted docs before making changes.')
    expect(markdown).not.toContain('-p 22')
    expect(markdown).toContain('prefer remote-side `printf` or `echo` commands over heredocs or `cat > file`')
    expect(markdown).toContain('ssh docs.example.com grep -R "keyword" /docs')
  })

  it('renders setup markdown with installation flows and tool paths', () => {
    const markdown = createSetupMarkdown({
      docsName: 'Project Docs',
      sourceStore: createSourceStoreFixture(),
      sshHost: 'docs-ssh',
      sshPort: 2222,
    })

    expect(markdown).toContain('Choose one of these setup flows:')
    expect(markdown).toContain('ssh docs-ssh -p 2222 agents >> AGENTS.md')
    expect(markdown).toContain('mkdir -p .agents/skills/docs-ssh')
    expect(markdown).toContain('ssh docs-ssh -p 2222 skill > .agents/skills/docs-ssh/SKILL.md')
    expect(markdown).toContain('| Codex | `AGENTS.md` | `.agents/skills/docs-ssh/SKILL.md` |')
    expect(markdown).toContain('ssh docs-ssh -p 2222 setup')
  })
})
