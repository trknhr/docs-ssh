import type { Bash } from 'just-bash'
import { describe, expect, it, vi } from 'vitest'
import {
  createCompletionEngine,
  findCmdStart,
  formatHits,
  parseCompletionContext,
  shellQuote,
} from './completion.js'

interface ExecResult {
  exitCode?: number
  stdout?: string
}

interface MockBashConfig {
  exec?: (command: string) => ExecResult | Promise<ExecResult>
  home?: string
  entries?: Record<string, string[]>
  stats?: Record<string, boolean>
}

function createMockBash(config: MockBashConfig = {}) {
  const exec = vi.fn(async (command: string) => {
    if (config.exec) return config.exec(command)
    return { exitCode: 1, stdout: '' }
  })
  const getEnv = vi.fn(() => ({ HOME: config.home ?? '/home/tester' }))
  const readdir = vi.fn(async (path: string) => {
    const entries = config.entries?.[path]
    if (!entries) throw new Error(`ENOENT: ${path}`)
    return entries
  })
  const stat = vi.fn(async (path: string) => {
    const isDirectory = config.stats?.[path]
    if (typeof isDirectory === 'undefined') throw new Error(`ENOENT: ${path}`)
    return { isDirectory }
  })

  return {
    bash: {
      exec,
      fs: { readdir, stat },
      getEnv,
    } as unknown as Bash,
    exec,
    readdir,
    stat,
  }
}

describe('completion helpers', () => {
  it('finds the current command start and ignores separators inside quotes', () => {
    const line = "echo 'a;b'; ls"
    expect(findCmdStart(line)).toBe(line.lastIndexOf(';') + 1)
  })

  it('parses completion context for command and argument positions', () => {
    const argumentContext = parseCompletionContext('grep keyword ')
    expect(argumentContext).toMatchObject({
      command: 'grep',
      word: '',
      inCommandPosition: false,
    })
    expect(argumentContext.args[0]).toBe('keyword')

    expect(parseCompletionContext('echo ok; gre')).toEqual({
      command: 'gre',
      args: [],
      word: 'gre',
      inCommandPosition: true,
    })
  })

  it('quotes shell values and formats hits', () => {
    expect(shellQuote('plain-value')).toBe('plain-value')
    expect(shellQuote('')).toBe("''")
    expect(shellQuote("it's complicated")).toBe("'it'\\''s complicated'")

    expect(formatHits(['README.md'])).toEqual(['README.md '])
    expect(formatHits(['README.md', 'notes.md'])).toEqual(['README.md', 'notes.md'])
  })

  it('prioritizes syntax-aware variable completion', async () => {
    const { bash, exec } = createMockBash({
      exec: (command) =>
        command === 'compgen -A variable -- HO'
          ? { exitCode: 0, stdout: 'HOME' }
          : { exitCode: 1, stdout: '' },
    })

    const engine = createCompletionEngine(bash)
    await expect(engine.complete('$HO', '/')).resolves.toEqual([['$HOME '], '$HO'])
    expect(exec).toHaveBeenCalledWith('compgen -A variable -- HO', { cwd: '/' })
  })

  it('completes commands when the cursor is in command position', async () => {
    const { bash } = createMockBash({
      exec: (command) =>
        command === 'compgen -A command -- gr'
          ? { exitCode: 0, stdout: 'grep\ngroupadd' }
          : { exitCode: 1, stdout: '' },
    })

    const engine = createCompletionEngine(bash)
    await expect(engine.complete('echo ok; gr', '/')).resolves.toEqual([['grep', 'groupadd'], 'gr'])
  })

  it('uses custom completion results before falling back to files', async () => {
    const { bash, readdir } = createMockBash({
      entries: {
        '/workspace': ['readme.md'],
      },
      stats: {
        '/workspace/readme.md': false,
      },
    })
    const completeFn = vi.fn(async () => ['--help'])
    const engine = createCompletionEngine(bash, completeFn)

    await expect(engine.complete('grep --h', '/workspace')).resolves.toEqual([['--help'], '--h'])
    expect(completeFn).toHaveBeenCalledWith({
      command: 'grep',
      args: ['--h'],
      word: '--h',
      cwd: '/workspace',
    })
    expect(readdir).not.toHaveBeenCalled()
  })

  it('falls back to file completion when no custom hits are available', async () => {
    const { bash } = createMockBash({
      entries: {
        '/workspace': ['readme.md', 'notes.md', 'docs'],
      },
      stats: {
        '/workspace/readme.md': false,
        '/workspace/notes.md': false,
        '/workspace/docs': true,
      },
    })

    const engine = createCompletionEngine(bash, async () => [])
    await expect(engine.complete('cat rea', '/workspace')).resolves.toEqual([['readme.md '], 'rea'])
    await expect(engine.complete('cat do', '/workspace')).resolves.toEqual([['docs/'], 'do'])
  })
})
