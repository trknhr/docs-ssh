import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, posix, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { RagbenchCase, RagbenchDocument, RetrievedCandidate, RetrievalRun } from '../types.js'
import { cosineScore, termFrequency, tokenize } from './text.js'

const DEFAULT_CASES = '.bench/ragbench/cases.jsonl'
const DEFAULT_OUTPUT = '.bench/ragbench/runs/docs-ssh.jsonl'
const DEFAULT_REMOTE_ROOT = '/projects/ragbench/tasks/ragbench-cases'
const DEFAULT_TOP_K = '5'
const MAX_RG_TERMS = 64
const TEXT_PREVIEW_LENGTH = 240

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function quoted(value: string): string {
  return JSON.stringify(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function expectString(record: Record<string, unknown>, field: string, lineNumber: number): string {
  const value = record[field]
  if (typeof value !== 'string') {
    throw new Error(`Invalid case JSONL line ${lineNumber}: ${field} must be a string`)
  }
  return value
}

function parseDocument(value: unknown, lineNumber: number, index: number): RagbenchDocument {
  const record = asRecord(value)
  if (!record) {
    throw new Error(`Invalid case JSONL line ${lineNumber}: documents[${index}] must be an object`)
  }

  const title = record.title
  if (title !== undefined && typeof title !== 'string') {
    throw new Error(`Invalid case JSONL line ${lineNumber}: documents[${index}].title must be a string`)
  }

  return {
    id: expectString(record, 'id', lineNumber),
    text: expectString(record, 'text', lineNumber),
    title,
  }
}

function parseCaseLine(line: string, lineNumber: number): RagbenchCase {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid case JSONL line ${lineNumber}: ${message}`)
  }

  const record = asRecord(parsed)
  if (!record) {
    throw new Error(`Invalid case JSONL line ${lineNumber}: expected an object`)
  }

  const documents = record.documents
  if (!Array.isArray(documents)) {
    throw new Error(`Invalid case JSONL line ${lineNumber}: documents must be an array`)
  }

  return {
    caseId: expectString(record, 'caseId', lineNumber),
    config: expectString(record, 'config', lineNumber),
    split: expectString(record, 'split', lineNumber),
    question: expectString(record, 'question', lineNumber),
    referenceAnswer: expectString(record, 'referenceAnswer', lineNumber),
    documents: documents.map((document, index) => parseDocument(document, lineNumber, index)),
    supportingDocumentIds: Array.isArray(record.supportingDocumentIds)
      ? record.supportingDocumentIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    raw: record.raw,
  }
}

async function readCases(path: string): Promise<RagbenchCase[]> {
  const content = await readFile(path, 'utf8')
  return content
    .split(/\r?\n/u)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, lineNumber }) => parseCaseLine(line, lineNumber))
}

function parsePositiveInteger(name: string, value: string | undefined): number {
  if (!value || !/^\d+$/u.test(value)) {
    throw new Error(`--${name} must be a positive integer`)
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return parsed
}

function assertSafePathSegment(kind: string, value: string, caseId: string): void {
  if (value.length === 0 || value === '.' || value === '..' || /[\\/]/u.test(value) || value.includes('\0')) {
    throw new Error(
      `Invalid case ${quoted(caseId)}: ${kind} must be a safe path segment without slash, backslash, dot-only, or NUL characters: ${quoted(value)}`,
    )
  }
}

function validateCase(entry: RagbenchCase): void {
  assertSafePathSegment('caseId', entry.caseId, entry.caseId)
  if (entry.documents.length === 0) {
    throw new Error(`Invalid case ${quoted(entry.caseId)}: documents must contain at least one document`)
  }

  for (const document of entry.documents) {
    assertSafePathSegment('document.id', document.id, entry.caseId)
  }
}

function validateRemoteRoot(value: string): void {
  if (value.length === 0 || value === '/' || value === '.' || value === '..' || !value.startsWith('/')) {
    throw new Error('--remote-root must be an absolute /projects/<project>/tasks/<generated-dir> path')
  }

  const parts = value.slice(1).split('/')
  for (const [index, part] of parts.entries()) {
    if (part.length === 0 || part === '.' || part === '..' || /[\\/]/u.test(part) || part.includes('\0')) {
      throw new Error(
        `--remote-root segment ${index} must be a safe path segment without slash, backslash, dot-only, or NUL characters: ${quoted(part)}`,
      )
    }
  }

  if (parts.length < 4 || parts[0] !== 'projects' || parts[2] !== 'tasks') {
    throw new Error('--remote-root must be under /projects/<project>/tasks/<generated-dir>')
  }
}

interface RemoteCommandResult {
  error: Error | undefined
  status: number | null
  stderr: string
  stdout: string
}

interface RunContext {
  commandCount: number
  errors: string[]
  sshCommand: string
}

interface RunnerContext extends RunContext {
  remoteRoot: string
}

function runRemoteCommand(context: RunContext, remoteCommand: string): RemoteCommandResult {
  context.commandCount += 1
  const result = spawnSync('sh', ['-lc', `${context.sshCommand} ${shellQuote(remoteCommand)}`], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  })

  return {
    error: result.error,
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

function failureMessage(action: string, result: RemoteCommandResult): string {
  if (result.error) return `${action} failed: ${result.error.message}`
  const stderr = result.stderr.trim()
  return `${action} failed with exit ${result.status ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`
}

function runPreflight(sshCommand: string, remoteRoot: string): void {
  const context: RunContext = {
    commandCount: 0,
    errors: [],
    sshCommand,
  }
  const remoteCommand = `command -v find rg cat >/dev/null && test -d ${shellQuote(remoteRoot)}`
  const result = runRemoteCommand(context, remoteCommand)
  if (result.error || result.status !== 0) {
    throw new Error(failureMessage('docs-ssh preflight for required tools and remote root', result))
  }
}

function splitNulList(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0)
}

interface RemoteDocument {
  documentId: string
  index: number
  path: string
}

function documentIdFromPath(remotePath: string): string | null {
  const name = posix.basename(remotePath)
  if (!name.startsWith('doc-') || !name.endsWith('.md')) return null
  return name.slice('doc-'.length, -'.md'.length)
}

function uniqueQueryTerms(question: string): string[] {
  return [...new Set(tokenize(question))].slice(0, MAX_RG_TERMS)
}

function findRemoteDocuments(context: RunContext, documentsRoot: string, entry: RagbenchCase): RemoteDocument[] {
  const result = runRemoteCommand(
    context,
    `find ${shellQuote(documentsRoot)} -maxdepth 1 -type f -name ${shellQuote('doc-*.md')} -print0`,
  )
  if (result.error || result.status !== 0) {
    context.errors.push(failureMessage(`find documents for case ${quoted(entry.caseId)}`, result))
    return []
  }

  const documentOrder = new Map(entry.documents.map((document, index) => [document.id, index]))
  return splitNulList(result.stdout)
    .map((path) => {
      const documentId = documentIdFromPath(path)
      if (documentId === null) return null
      const index = documentOrder.get(documentId)
      if (index === undefined) return null
      return { documentId, index, path }
    })
    .filter((document): document is RemoteDocument => document !== null)
    .sort((a, b) => a.index - b.index || a.path.localeCompare(b.path))
}

function findMatchingPaths(context: RunContext, documentsRoot: string, entry: RagbenchCase): Set<string> | null {
  const queryTerms = uniqueQueryTerms(entry.question)
  if (queryTerms.length === 0) return new Set()

  const patterns = queryTerms.map((term) => `-e ${shellQuote(term)}`).join(' ')
  const result = runRemoteCommand(
    context,
    `rg --files-with-matches --ignore-case --null ${patterns} -- ${shellQuote(documentsRoot)}`,
  )

  if (result.status === 0 && !result.error) {
    return new Set(splitNulList(result.stdout))
  }
  if (result.status === 1 && !result.error) {
    return new Set()
  }

  context.errors.push(failureMessage(`rg query for case ${quoted(entry.caseId)}`, result))
  return null
}

function readRemoteDocument(context: RunContext, document: RemoteDocument): string | null {
  const result = runRemoteCommand(context, `cat -- ${shellQuote(document.path)}`)
  if (result.error || result.status !== 0) {
    context.errors.push(failureMessage(`cat ${document.path}`, result))
    return null
  }
  return result.stdout
}

function makeCandidate(document: RemoteDocument, content: string, score: number): RetrievedCandidate {
  return {
    documentId: document.documentId,
    path: document.path,
    score,
    textPreview: content.slice(0, TEXT_PREVIEW_LENGTH),
  }
}

function rankRemoteDocuments(entry: RagbenchCase, topK: number, context: RunnerContext): {
  bytesRead: number
  candidates: RetrievedCandidate[]
  filesRead: number
} {
  const documentsRoot = posix.join(context.remoteRoot, entry.caseId, 'documents')
  const remoteDocuments = findRemoteDocuments(context, documentsRoot, entry)
  const matchingPaths = remoteDocuments.length > 0 ? findMatchingPaths(context, documentsRoot, entry) : new Set<string>()
  const matchedDocuments = matchingPaths
    ? remoteDocuments.filter((document) => matchingPaths.has(document.path))
    : []
  const queryVector = termFrequency(tokenize(entry.question))
  const ranked: Array<{ candidate: RetrievedCandidate; index: number }> = []
  let filesRead = 0
  let bytesRead = 0

  for (const document of matchedDocuments) {
    const content = readRemoteDocument(context, document)
    if (content === null) continue
    filesRead += 1
    bytesRead += Buffer.byteLength(content, 'utf8')
    ranked.push({
      candidate: makeCandidate(document, content, cosineScore(queryVector, termFrequency(tokenize(content)))),
      index: document.index,
    })
  }

  ranked.sort((a, b) => b.candidate.score - a.candidate.score || a.index - b.index)
  const candidates = ranked.slice(0, topK).map(({ candidate }) => candidate)
  const alreadyTried = new Set(matchedDocuments.map((document) => document.path))

  if (candidates.length < topK) {
    const fallbackDocuments = remoteDocuments.filter((document) => !alreadyTried.has(document.path))
    for (const document of fallbackDocuments) {
      if (candidates.length >= topK) break
      const content = readRemoteDocument(context, document)
      if (content === null) continue
      filesRead += 1
      bytesRead += Buffer.byteLength(content, 'utf8')
      candidates.push(makeCandidate(document, content, 0))
    }
  }

  return { bytesRead, candidates, filesRead }
}

function runCase(entry: RagbenchCase, topK: number, sshCommand: string, remoteRoot: string): RetrievalRun {
  const started = Date.now()
  const context: RunnerContext = {
    commandCount: 0,
    errors: [],
    remoteRoot,
    sshCommand,
  }
  const { bytesRead, candidates, filesRead } = rankRemoteDocuments(entry, topK, context)

  return {
    caseId: entry.caseId,
    mode: 'docs-ssh',
    question: entry.question,
    candidates,
    elapsedMs: Date.now() - started,
    commandCount: context.commandCount,
    filesRead,
    bytesRead,
    errors: context.errors,
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    options: {
      cases: { type: 'string', default: DEFAULT_CASES },
      output: { type: 'string', default: DEFAULT_OUTPUT },
      'remote-root': { type: 'string', default: DEFAULT_REMOTE_ROOT },
      'top-k': { type: 'string', default: DEFAULT_TOP_K },
    },
  })

  const sshCommand = process.env.DOCS_SSH_BENCH_SSH_COMMAND?.trim()
  if (!sshCommand) {
    throw new Error('DOCS_SSH_BENCH_SSH_COMMAND must be set to the docs-ssh SSH command for this benchmark')
  }

  const casesPath = resolve(values.cases ?? DEFAULT_CASES)
  const output = resolve(values.output ?? DEFAULT_OUTPUT)
  const remoteRoot = values['remote-root'] ?? DEFAULT_REMOTE_ROOT
  const topK = parsePositiveInteger('top-k', values['top-k'])
  validateRemoteRoot(remoteRoot)
  runPreflight(sshCommand, remoteRoot)

  const cases = await readCases(casesPath)
  for (const entry of cases) {
    validateCase(entry)
  }

  const runs = cases.map((entry) => runCase(entry, topK, sshCommand, remoteRoot))
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, runs.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')

  console.log(JSON.stringify({
    errorCount: runs.reduce((sum, entry) => sum + entry.errors.length, 0),
    cases: runs.length,
    output,
    remoteRoot,
    topK,
  }, null, 2))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
