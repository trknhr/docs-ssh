/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified only for docs-ssh packaging.
 */

import { posix } from 'node:path'
import type { Bash } from 'just-bash'

type CompletionResult = [completions: string[], word: string]

export type CommandCompleteFn = (ctx: {
  command: string
  args: string[]
  word: string
  cwd: string
}) => Promise<string[]>

const COMMAND_SEPARATORS = new Set([';', '|', '&', '(', '`'])

export function parseCompletionContext(line: string) {
  const cmdStart = findCmdStart(line)
  const cmdLine = line.slice(cmdStart)
  const trimmed = cmdLine.trimStart()
  const parts = trimmed.split(/\s+/)
  const word = cmdLine.endsWith(' ') ? '' : (parts[parts.length - 1] ?? '')

  let ti = cmdLine.length - word.length - 1
  while (ti >= 0 && (cmdLine[ti] === ' ' || cmdLine[ti] === '\t')) ti--

  let inCommandPosition = false

  if (ti < 0) inCommandPosition = true
  else if (COMMAND_SEPARATORS.has(cmdLine[ti])) inCommandPosition = true

  const command = parts[0] ?? ''
  const args = parts.length > 1 ? parts.slice(1) : []

  return { word, command, args, inCommandPosition }
}

export function findCmdStart(line: string): number {
  let start = 0
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === "'" || char === '"') {
      const close = line.indexOf(char, index + 1)
      if (close !== -1) index = close
      continue
    }
    if (COMMAND_SEPARATORS.has(char)) start = index + 1
  }
  return start
}

export function shellQuote(value: string): string {
  if (value === '') return "''"
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function compgen(bash: Bash, action: string, prefix: string, cwd: string): Promise<string[]> {
  const result = await bash.exec(`compgen -A ${action} -- ${shellQuote(prefix)}`, { cwd })
  if (result.exitCode !== 0 || !result.stdout.trim()) return []
  return result.stdout.trim().split('\n').filter(Boolean)
}

export interface CompletionEngine {
  complete(line: string, cwd: string): Promise<CompletionResult>
}

export function createCompletionEngine(
  bash: Bash,
  completeFn?: CommandCompleteFn,
): CompletionEngine {
  return {
    async complete(line: string, cwd: string): Promise<CompletionResult> {
      const ctx = parseCompletionContext(line)
      const syntaxHits = await completeSyntaxAware(bash, ctx.word, cwd)
      if (syntaxHits) return [syntaxHits, ctx.word]

      if (ctx.inCommandPosition) return completeCommands(bash, ctx.word, cwd)

      if (completeFn) {
        const hits = await completeFn({
          command: ctx.command,
          args: ctx.args,
          word: ctx.word,
          cwd,
        })
        if (hits.length > 0) return [hits, ctx.word]
      }

      return completeFiles(bash, ctx.word, cwd)
    },
  }
}

async function completeSyntaxAware(
  bash: Bash,
  word: string,
  cwd: string,
): Promise<string[] | null> {
  if (word.startsWith('$')) {
    if (word.startsWith('${')) {
      const hits = (await compgen(bash, 'variable', word.slice(2), cwd)).map((value) => `\${${value}}`)
      return formatHits(hits)
    }
    const hits = (await compgen(bash, 'variable', word.slice(1), cwd)).map((value) => `$${value}`)
    return formatHits(hits)
  }

  return null
}

async function completeCommands(bash: Bash, word: string, cwd: string): Promise<CompletionResult> {
  const hits = await compgen(bash, 'command', word, cwd)
  return [formatHits(hits), word]
}

async function completeFiles(bash: Bash, word: string, cwd: string): Promise<CompletionResult> {
  let tildePrefix = ''
  let expanded = word
  const home = bash.getEnv().HOME

  if (home && (word === '~' || word.startsWith('~/'))) {
    tildePrefix = word.startsWith('~/') ? '~/' : '~'
    expanded = home + word.slice(1)
  }

  const lastSlash = expanded.lastIndexOf('/')
  const dirPart = lastSlash >= 0 ? expanded.slice(0, lastSlash + 1) : ''
  const namePart = lastSlash >= 0 ? expanded.slice(lastSlash + 1) : expanded
  const searchDir = dirPart ? posix.resolve(cwd, dirPart) : cwd

  try {
    const entries = await bash.fs.readdir(searchDir)
    const matches = entries.filter((entry) => entry.startsWith(namePart)).map((entry) => dirPart + entry)

    const decorated = await Promise.all(
      matches.map(async (match) => {
        try {
          const fullPath = posix.resolve(cwd, match)
          const stat = await bash.fs.stat(fullPath)
          const display = tildePrefix
            ? tildePrefix + match.slice((home?.length ?? 0) + (tildePrefix === '~/' ? 1 : 0))
            : match
          if (stat.isDirectory) return `${display}/`
          return matches.length === 1 ? `${display} ` : display
        } catch {
          return match
        }
      }),
    )

    return [decorated, word]
  } catch {
    return [[], word]
  }
}

export function formatHits(hits: string[], singleSuffix = ' '): string[] {
  if (hits.length === 1) return [hits[0] + singleSuffix]
  return hits
}
