import { describe, expect, it } from 'vitest'
import { formatRemoteWriteCommand } from '../bench/ragbench/materialize.js'

describe('RAGBench materialize remote writes', () => {
  it('formats remote writes without stdin-dependent cat redirection or raw content arguments', () => {
    const command = formatRemoteWriteCommand('/projects/default/tasks/ragbench-cases/case/question.md', "line 1\nit's fine\n")

    expect(command).toContain('printf %s ')
    expect(command).toContain(' | base64 -d > ')
    expect(command).toContain('bGluZSAxCml0J3MgZmluZQo=')
    expect(command).toContain(' > ')
    expect(command).not.toContain('cat >')
    expect(command).not.toContain("it's fine")
  })
})
