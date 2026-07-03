import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { tokenize } from './bm25.js'
import type { MultihopQuestion, RetrievalRun } from '../types.js'

interface RgMatch {
  lineNumber: number
  path: string
  text: string
}

interface DocumentHit {
  firstLine: number
  path: string
  score: number
  textPreview: string
}

const DEFAULT_REMOTE_ROOT = '/projects/multihop-rag/tasks/multihop-rag-corpus'
const DEFAULT_TIMEOUT_MS = 120_000

const STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'and',
  'are',
  'as',
  'at',
  'based',
  'between',
  'both',
  'but',
  'by',
  'did',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'reported',
  'that',
  'the',
  'their',
  'this',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'with',
])

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
}

function remoteExec(opts: {
  input?: string
  remoteCommand: string
  sshCommand: string
  timeoutMs?: number
}): { elapsedMs: number; stderr: string; stdout: string } {
  const startedAt = performance.now()
  const result = spawnSync('sh', ['-lc', `${opts.sshCommand} ${shellQuote(opts.remoteCommand)}`], {
    encoding: 'utf8',
    input: opts.input,
    maxBuffer: 1024 * 1024 * 20,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
  const elapsedMs = performance.now() - startedAt

  if (result.error) throw result.error
  if (result.status !== 0) {
    const stderr = result.stderr.trim()
    throw new Error(`Remote command failed (${result.status}): ${stderr || opts.remoteCommand}`)
  }

  return {
    elapsedMs,
    stderr: result.stderr,
    stdout: result.stdout,
  }
}

export function selectQueryTerms(question: string, maxTerms = 10): string[] {
  const counts = new Map<string, number>()
  for (const term of tokenize(question)) {
    if (term.length < 3 || STOP_WORDS.has(term)) continue
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length || left[0].localeCompare(right[0]))
    .slice(0, maxTerms)
    .map(([term]) => term)
}

export function parseRgMatches(output: string): RgMatch[] {
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      const match = /^(.*?):(\d+):(.*)$/u.exec(line)
      if (!match) return []
      return [{
        lineNumber: Number(match[2]),
        path: match[1] ?? '',
        text: match[3] ?? '',
      }]
    })
    .filter((match) => match.path.length > 0 && Number.isSafeInteger(match.lineNumber))
}

function scoreMatches(matches: RgMatch[], topK: number): DocumentHit[] {
  const hitsByPath = new Map<string, DocumentHit>()

  for (const match of matches) {
    const current = hitsByPath.get(match.path)
    if (!current) {
      hitsByPath.set(match.path, {
        firstLine: match.lineNumber,
        path: match.path,
        score: 1,
        textPreview: match.text,
      })
      continue
    }

    current.score += 1
    current.firstLine = Math.min(current.firstLine, match.lineNumber)
    if (current.textPreview.length < 240 && match.text.trim().length > 0) {
      current.textPreview = `${current.textPreview} ${match.text}`.trim().slice(0, 240)
    }
  }

  return [...hitsByPath.values()]
    .sort((left, right) => right.score - left.score || left.firstLine - right.firstLine || left.path.localeCompare(right.path))
    .slice(0, topK)
}

export function documentIdFromPath(path: string): string {
  const filename = basename(path).replace(/\.md$/u, '')
  const structuredMarker = filename.lastIndexOf('__doc_')
  return structuredMarker === -1 ? filename : filename.slice(structuredMarker + 2)
}

function buildRgCommand(terms: string[], remoteRoot: string): string {
  const corpusPath = `${remoteRoot.replace(/\/+$/u, '')}/corpus/news`
  const termArgs = terms.map((term) => `-e ${shellQuote(escapeRegex(term))}`).join(' ')
  return `rg -i -n -m 2 ${termArgs} ${shellQuote(corpusPath)} || true`
}

function buildReadBatch(paths: string[]): string {
  return paths.map((path) => `read-range -n ${shellQuote(path)} 1 28`).join('\n')
}

export function runDocsSshDirectRetrieval(opts: {
  limit?: number
  questions: MultihopQuestion[]
  remoteRoot?: string
  sshCommand: string
  topK: number
}): RetrievalRun[] {
  const selectedQuestions = opts.limit === undefined ? opts.questions : opts.questions.slice(0, opts.limit)
  const remoteRoot = opts.remoteRoot ?? DEFAULT_REMOTE_ROOT

  return selectedQuestions.map((question) => {
    const errors: string[] = []
    const terms = selectQueryTerms(question.question, 5)
    const startedAt = performance.now()
    let commandCount = 0
    let sshExecCount = 0
    let bytesRead = 0
    let filesRead = 0

    if (terms.length === 0) {
      return {
        bytesRead: 0,
        candidates: [],
        caseId: question.caseId,
        commandCount: 0,
        elapsedMs: performance.now() - startedAt,
        errors: ['No query terms selected.'],
        filesRead: 0,
        mode: 'docs-ssh-direct',
        question: question.question,
        sshExecCount: 0,
      }
    }

    let hits: DocumentHit[] = []
    try {
      commandCount += 1
      sshExecCount += 1
      const rgResult = remoteExec({
        remoteCommand: buildRgCommand(terms, remoteRoot),
        sshCommand: opts.sshCommand,
      })
      bytesRead += Buffer.byteLength(rgResult.stdout, 'utf8')
      hits = scoreMatches(parseRgMatches(rgResult.stdout), opts.topK)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }

    if (hits.length > 0) {
      try {
        commandCount += hits.length
        sshExecCount += 1
        const readResult = remoteExec({
          input: buildReadBatch(hits.map((hit) => hit.path)),
          remoteCommand: 'batch',
          sshCommand: opts.sshCommand,
        })
        bytesRead += Buffer.byteLength(readResult.stdout, 'utf8')
        filesRead += hits.length
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }

    return {
      bytesRead,
      candidates: hits.map((hit, index) => ({
        documentId: documentIdFromPath(hit.path),
        path: hit.path,
        rank: index + 1,
        score: hit.score,
        textPreview: hit.textPreview,
      })),
      caseId: question.caseId,
      commandCount,
      elapsedMs: performance.now() - startedAt,
      errors,
      filesRead,
      mode: 'docs-ssh-direct',
      question: question.question,
      sshExecCount,
    }
  })
}
