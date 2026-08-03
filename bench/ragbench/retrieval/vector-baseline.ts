import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, posix, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { RagbenchCase, RagbenchDocument, RetrievalRun } from '../types.js'
import { cosineScore, termFrequency, tokenize } from './text.js'

const DEFAULT_CASES = '.bench/ragbench/cases.jsonl'
const DEFAULT_OUTPUT = '.bench/ragbench/runs/vector.jsonl'
const DEFAULT_LOCAL_ROOT = '.bench/ragbench/tree/cases'
const DEFAULT_TOP_K = '5'

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

function quoted(value: string): string {
  return JSON.stringify(value)
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

function documentPath(entry: RagbenchCase, document: RagbenchDocument): string {
  return posix.join(DEFAULT_LOCAL_ROOT, entry.caseId, 'documents', `doc-${document.id}.md`)
}

function rankDocuments(entry: RagbenchCase, topK: number): RetrievalRun['candidates'] {
  const queryVector = termFrequency(tokenize(entry.question))
  return entry.documents
    .map((document, index) => ({
      candidate: {
        documentId: document.id,
        path: documentPath(entry, document),
        score: cosineScore(queryVector, termFrequency(tokenize(document.text))),
        textPreview: document.text.slice(0, 240),
      },
      index,
    }))
    .sort((a, b) => b.candidate.score - a.candidate.score || a.index - b.index)
    .slice(0, topK)
    .map(({ candidate }) => candidate)
}

const args = process.argv.slice(2)
const { values } = parseArgs({
  args: args[0] === '--' ? args.slice(1) : args,
  options: {
    cases: { type: 'string', default: DEFAULT_CASES },
    output: { type: 'string', default: DEFAULT_OUTPUT },
    'top-k': { type: 'string', default: DEFAULT_TOP_K },
  },
})

const casesPath = resolve(values.cases ?? DEFAULT_CASES)
const output = resolve(values.output ?? DEFAULT_OUTPUT)
const topK = parsePositiveInteger('top-k', values['top-k'])
const cases = await readCases(casesPath)
const runs: RetrievalRun[] = []

for (const entry of cases) {
  validateCase(entry)
}

for (const entry of cases) {
  const started = Date.now()
  const candidates = rankDocuments(entry, topK)
  runs.push({
    caseId: entry.caseId,
    mode: 'vector',
    question: entry.question,
    candidates,
    elapsedMs: Date.now() - started,
    commandCount: 0,
    filesRead: entry.documents.length,
    bytesRead: entry.documents.reduce((sum, document) => sum + Buffer.byteLength(document.text, 'utf8'), 0),
    errors: [],
  })
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, runs.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')

console.log(JSON.stringify({
  cases: runs.length,
  output,
  topK,
}, null, 2))
