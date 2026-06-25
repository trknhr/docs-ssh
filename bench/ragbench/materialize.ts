import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { RagbenchCase, RagbenchDocument } from './types.js'

const DEFAULT_CASES = '.bench/ragbench/cases.jsonl'
const DEFAULT_LOCAL_ROOT = '.bench/ragbench/tree/cases'
const DEFAULT_REMOTE_ROOT = '/projects/ragbench/tasks/ragbench-cases'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
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

function expectStringArray(record: Record<string, unknown>, field: string, lineNumber: number): string[] {
  const value = record[field]
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`Invalid case JSONL line ${lineNumber}: ${field} must be a string array`)
  }
  return value
}

function parseDocument(value: unknown, lineNumber: number, index: number): RagbenchDocument {
  const record = asRecord(value)
  if (!record) {
    throw new Error(`Invalid case JSONL line ${lineNumber}: documents[${index}] must be an object`)
  }

  const id = expectString(record, 'id', lineNumber)
  const text = expectString(record, 'text', lineNumber)
  const title = record.title
  if (title !== undefined && typeof title !== 'string') {
    throw new Error(`Invalid case JSONL line ${lineNumber}: documents[${index}].title must be a string`)
  }

  return {
    id,
    text,
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
    supportingDocumentIds: expectStringArray(record, 'supportingDocumentIds', lineNumber),
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

function assertSafePathSegment(kind: string, value: string): void {
  if (value.length === 0 || value === '.' || value === '..' || /[\\/]/u.test(value) || value.includes('\0')) {
    throw new Error(`${kind} must be a safe path segment without slash, backslash, dot-only, or NUL characters: ${value}`)
  }
}

function validateCasePathSegments(entry: RagbenchCase): void {
  assertSafePathSegment('caseId', entry.caseId)
  for (const document of entry.documents) {
    assertSafePathSegment('document.id', document.id)
  }
}

function validateRemoteRoot(value: string): void {
  if (value.length === 0 || value === '/' || value === '.' || value === '..' || !value.startsWith('/')) {
    throw new Error('--remote-root must be an absolute /projects/<project>/tasks/<generated-dir> path')
  }

  const parts = value.slice(1).split('/')
  for (const [index, part] of parts.entries()) {
    assertSafePathSegment(`remoteRoot[${index}]`, part)
  }

  if (parts.length < 4 || parts[0] !== 'projects' || parts[2] !== 'tasks') {
    throw new Error('--remote-root cleanup is allowed only under /projects/<project>/tasks/<generated-dir>')
  }
}

function validateLocalRootForCleanup(value: string, cwd: string): void {
  if (value.length === 0 || value.includes('\0')) {
    throw new Error('--local-root must be a generated path under .bench/ragbench/')
  }

  const benchmarkRoot = resolve(cwd, '.bench', 'ragbench')
  const relativePath = relative(benchmarkRoot, value)
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('--local-root cleanup is allowed only under the current workspace .bench/ragbench/ directory')
  }
}

function assertInsideLocalRoot(root: string, target: string, kind: string): void {
  const relativePath = relative(root, target)
  if (relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))) {
    return
  }
  throw new Error(`${kind} resolved outside local root: ${target}`)
}

function resolveInsideLocalRoot(root: string, kind: string, ...parts: string[]): string {
  const target = resolve(root, ...parts)
  assertInsideLocalRoot(root, target, kind)
  return target
}

function formatQuestion(entry: RagbenchCase): string {
  return [
    `# ${entry.caseId}`,
    '',
    '## Question',
    '',
    entry.question,
    '',
    '## Reference Answer',
    '',
    entry.referenceAnswer,
    '',
    '## Supporting Documents',
    '',
    entry.supportingDocumentIds.length > 0 ? entry.supportingDocumentIds.join(', ') : 'unknown',
    '',
  ].join('\n')
}

function formatDocument(document: RagbenchDocument): string {
  return [
    `# Document ${document.id}`,
    ...(document.title ? ['', `Title: ${document.title}`] : []),
    '',
    document.text,
    '',
  ].join('\n')
}

async function writeLocalCase(root: string, entry: RagbenchCase): Promise<number> {
  assertSafePathSegment('caseId', entry.caseId)
  const caseDir = resolveInsideLocalRoot(root, 'case directory', entry.caseId)
  const documentsDir = resolveInsideLocalRoot(root, 'documents directory', entry.caseId, 'documents')
  await mkdir(caseDir, { recursive: true })
  await mkdir(documentsDir, { recursive: true })
  await writeFile(resolveInsideLocalRoot(root, 'question file', entry.caseId, 'question.md'), formatQuestion(entry), 'utf8')

  for (const document of entry.documents) {
    assertSafePathSegment('document.id', document.id)
    await writeFile(
      resolveInsideLocalRoot(root, 'document file', entry.caseId, 'documents', `doc-${document.id}.md`),
      formatDocument(document),
      'utf8',
    )
  }

  return entry.documents.length
}

function runRemoteCommand(opts: {
  input?: string
  remoteCommand: string
  sshCommand: string
}): string {
  const result = spawnSync('sh', ['-lc', `${opts.sshCommand} ${shellQuote(opts.remoteCommand)}`], {
    encoding: 'utf8',
    input: opts.input,
    maxBuffer: 1024 * 1024 * 20,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    const stderr = result.stderr.trim()
    throw new Error(`Remote command failed (${result.status}): ${stderr || opts.remoteCommand}`)
  }

  return result.stdout
}

export function formatRemoteWriteCommand(remotePath: string, content: string): string {
  const encoded = Buffer.from(content, 'utf8').toString('base64')
  return `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(remotePath)}`
}

function writeRemoteFile(sshCommand: string, remotePath: string, content: string): void {
  runRemoteCommand({
    remoteCommand: formatRemoteWriteCommand(remotePath, content),
    sshCommand,
  })

  const expectedBytes = Buffer.byteLength(content, 'utf8')
  const byteCount = Number.parseInt(runRemoteCommand({
    remoteCommand: `wc -c < ${shellQuote(remotePath)}`,
    sshCommand,
  }).trim(), 10)

  if (byteCount !== expectedBytes) {
    throw new Error(`Remote write verification failed for ${remotePath}: expected ${expectedBytes} bytes, got ${byteCount}`)
  }
}

function writeRemoteCase(sshCommand: string, remoteRoot: string, entry: RagbenchCase): number {
  assertSafePathSegment('caseId', entry.caseId)
  const caseRoot = posix.join(remoteRoot, entry.caseId)
  const documentsRoot = posix.join(caseRoot, 'documents')
  runRemoteCommand({
    remoteCommand: `mkdir -p ${shellQuote(documentsRoot)}`,
    sshCommand,
  })

  writeRemoteFile(sshCommand, posix.join(caseRoot, 'question.md'), formatQuestion(entry))
  for (const document of entry.documents) {
    assertSafePathSegment('document.id', document.id)
    writeRemoteFile(sshCommand, posix.join(documentsRoot, `doc-${document.id}.md`), formatDocument(document))
  }

  return entry.documents.length
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    options: {
      cases: { type: 'string', default: DEFAULT_CASES },
      'local-root': { type: 'string', default: DEFAULT_LOCAL_ROOT },
      'remote-root': { type: 'string', default: DEFAULT_REMOTE_ROOT },
    },
  })

  const casesPath = resolve(values.cases ?? DEFAULT_CASES)
  const localRoot = resolve(values['local-root'] ?? DEFAULT_LOCAL_ROOT)
  const remoteRoot = values['remote-root'] ?? DEFAULT_REMOTE_ROOT
  const sshCommand = process.env.DOCS_SSH_BENCH_SSH_COMMAND?.trim()
  const cases = await readCases(casesPath)
  let documentCount = 0

  for (const entry of cases) {
    validateCasePathSegments(entry)
  }

  validateLocalRootForCleanup(localRoot, process.cwd())
  await rm(localRoot, { force: true, recursive: true })
  await mkdir(localRoot, { recursive: true })
  for (const entry of cases) {
    documentCount += await writeLocalCase(localRoot, entry)
  }

  if (sshCommand) {
    validateRemoteRoot(remoteRoot)
    runRemoteCommand({
      remoteCommand: `rm -rf ${shellQuote(remoteRoot)} && mkdir -p ${shellQuote(remoteRoot)}`,
      sshCommand,
    })
    for (const entry of cases) {
      writeRemoteCase(sshCommand, remoteRoot, entry)
    }
  }

  console.log(JSON.stringify({
    cases: cases.length,
    documents: documentCount,
    localRoot,
    remoteRoot: sshCommand ? remoteRoot : null,
  }, null, 2))
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
