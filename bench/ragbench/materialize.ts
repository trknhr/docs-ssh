import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { RagbenchCase, RagbenchDocument } from './types.js'

const DEFAULT_CASES = '.bench/ragbench/cases.jsonl'
const DEFAULT_LOCAL_ROOT = '.bench/ragbench/tree/cases'
const DEFAULT_REMOTE_ROOT = '/projects/ragbench/tasks/ragbench-cases'
const DEFAULT_REMOTE_BATCH_BYTES = `${900 * 1024}`

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

function formatQuestion(entry: RagbenchCase, includeLabels: boolean): string {
  return [
    `# ${entry.caseId}`,
    '',
    '## Question',
    '',
    entry.question,
    '',
    ...(includeLabels
      ? [
          '## Reference Answer',
          '',
          entry.referenceAnswer,
          '',
          '## Supporting Documents',
          '',
          entry.supportingDocumentIds.length > 0 ? entry.supportingDocumentIds.join(', ') : 'unknown',
          '',
        ]
      : []),
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

async function writeLocalCase(root: string, entry: RagbenchCase, includeLabels: boolean): Promise<number> {
  assertSafePathSegment('caseId', entry.caseId)
  const caseDir = resolveInsideLocalRoot(root, 'case directory', entry.caseId)
  const documentsDir = resolveInsideLocalRoot(root, 'documents directory', entry.caseId, 'documents')
  await mkdir(caseDir, { recursive: true })
  await mkdir(documentsDir, { recursive: true })
  await writeFile(
    resolveInsideLocalRoot(root, 'question file', entry.caseId, 'question.md'),
    formatQuestion(entry, includeLabels),
    'utf8',
  )

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
  input?: Buffer | string
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

function createLocalTarArchive(localRoot: string, entries: string[]): Buffer {
  const result = spawnSync('tar', ['-cf', '-', '-C', localRoot, ...entries], {
    encoding: 'buffer',
    env: {
      ...process.env,
      COPYFILE_DISABLE: '1',
    },
    maxBuffer: 1024 * 1024 * 256,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : String(result.stderr).trim()
    throw new Error(`Local tar archive failed (${result.status}): ${stderr || localRoot}`)
  }

  return result.stdout
}

export function formatRemoteExtractCommand(remoteRoot: string): string {
  return `tar -xf - -C ${shellQuote(remoteRoot)}`
}

export interface RemoteArchiveBatch {
  archive: Buffer
  entries: string[]
}

export function createRemoteArchiveBatches(opts: {
  entries: string[]
  localRoot: string
  maxBytes: number
}): RemoteArchiveBatch[] {
  if (opts.entries.length === 0) return []

  const archive = createLocalTarArchive(opts.localRoot, opts.entries)
  if (archive.length <= opts.maxBytes) {
    return [{ archive, entries: opts.entries }]
  }

  if (opts.entries.length === 1) {
    throw new Error(
      `Remote materialize batch for ${opts.entries[0]} is ${archive.length} bytes, exceeding --remote-batch-bytes ${opts.maxBytes}`,
    )
  }

  const midpoint = Math.ceil(opts.entries.length / 2)
  return [
    ...createRemoteArchiveBatches({
      ...opts,
      entries: opts.entries.slice(0, midpoint),
    }),
    ...createRemoteArchiveBatches({
      ...opts,
      entries: opts.entries.slice(midpoint),
    }),
  ]
}

function materializeRemoteTree(opts: {
  caseIds: string[]
  expectedFileCount: number
  localRoot: string
  maxBatchBytes: number
  remoteRoot: string
  sshCommand: string
}): number {
  runRemoteCommand({
    remoteCommand: `rm -rf ${shellQuote(opts.remoteRoot)} && mkdir -p ${shellQuote(opts.remoteRoot)}`,
    sshCommand: opts.sshCommand,
  })

  const batches = createRemoteArchiveBatches({
    entries: opts.caseIds,
    localRoot: opts.localRoot,
    maxBytes: opts.maxBatchBytes,
  })
  for (const batch of batches) {
    runRemoteCommand({
      input: batch.archive,
      remoteCommand: formatRemoteExtractCommand(opts.remoteRoot),
      sshCommand: opts.sshCommand,
    })
  }

  const fileCount = Number.parseInt(runRemoteCommand({
    remoteCommand: `find ${shellQuote(opts.remoteRoot)} -type f | wc -l`,
    sshCommand: opts.sshCommand,
  }).trim(), 10)

  if (fileCount !== opts.expectedFileCount) {
    throw new Error(`Remote materialize verification failed for ${opts.remoteRoot}: expected ${opts.expectedFileCount} files, got ${fileCount}`)
  }

  return batches.length
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
      'remote-batch-bytes': { type: 'string', default: DEFAULT_REMOTE_BATCH_BYTES },
      'remote-root': { type: 'string', default: DEFAULT_REMOTE_ROOT },
      'include-labels': { type: 'boolean', default: false },
    },
  })

  const casesPath = resolve(values.cases ?? DEFAULT_CASES)
  const localRoot = resolve(values['local-root'] ?? DEFAULT_LOCAL_ROOT)
  const maxRemoteBatchBytes = parsePositiveInteger('remote-batch-bytes', values['remote-batch-bytes'])
  const remoteRoot = values['remote-root'] ?? DEFAULT_REMOTE_ROOT
  const sshCommand = process.env.DOCS_SSH_BENCH_SSH_COMMAND?.trim()
  const cases = await readCases(casesPath)
  let documentCount = 0
  let remoteBatchCount: number | null = null

  for (const entry of cases) {
    validateCasePathSegments(entry)
  }

  validateLocalRootForCleanup(localRoot, process.cwd())
  await rm(localRoot, { force: true, recursive: true })
  await mkdir(localRoot, { recursive: true })
  for (const entry of cases) {
    documentCount += await writeLocalCase(localRoot, entry, values['include-labels'] ?? false)
  }

  if (sshCommand) {
    validateRemoteRoot(remoteRoot)
    remoteBatchCount = materializeRemoteTree({
      caseIds: cases.map((entry) => entry.caseId),
      expectedFileCount: cases.length + documentCount,
      localRoot,
      maxBatchBytes: maxRemoteBatchBytes,
      remoteRoot,
      sshCommand,
    })
  }

  console.log(JSON.stringify({
    cases: cases.length,
    documents: documentCount,
    localRoot,
    questionIncludesAnswerKey: values['include-labels'] ?? false,
    remoteBatches: remoteBatchCount,
    remoteBatchBytes: sshCommand ? maxRemoteBatchBytes : null,
    remoteRoot: sshCommand ? remoteRoot : null,
  }, null, 2))
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
