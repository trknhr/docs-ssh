import { readFile } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { RagbenchCase, RagbenchDocument } from '../types.js'
import { cosineScore, termFrequency, tokenize } from './text.js'

const TEXT_PREVIEW_LENGTH = 640

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
    config: typeof record.config === 'string' ? record.config : '',
    split: typeof record.split === 'string' ? record.split : '',
    question: expectString(record, 'question', lineNumber),
    referenceAnswer: typeof record.referenceAnswer === 'string' ? record.referenceAnswer : '',
    documents: documents.map((document, index) => parseDocument(document, lineNumber, index)),
    supportingDocumentIds: [],
    raw: undefined,
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

function findCase(cases: RagbenchCase[], caseId: string): RagbenchCase {
  const entry = cases.find((candidate) => candidate.caseId === caseId)
  if (!entry) throw new Error(`Unknown caseId: ${caseId}`)
  return entry
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

function documentPath(entry: RagbenchCase, document: RagbenchDocument): string {
  return posix.join(entry.caseId, 'documents', `doc-${document.id}.md`)
}

function searchDocuments(entry: RagbenchCase, query: string, topK: number): unknown {
  const queryVector = termFrequency(tokenize(query))
  const results = entry.documents
    .map((document, index) => ({
      documentId: document.id,
      index,
      path: documentPath(entry, document),
      score: cosineScore(queryVector, termFrequency(tokenize(`${document.title ?? ''}\n${document.text}`))),
      textPreview: document.text.slice(0, TEXT_PREVIEW_LENGTH),
      title: document.title ?? null,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, topK)
    .map(({ index: _index, ...result }) => result)

  return {
    caseId: entry.caseId,
    query,
    results,
  }
}

function readDocument(entry: RagbenchCase, documentId: string): unknown {
  const document = entry.documents.find((candidate) => candidate.id === documentId)
  if (!document) throw new Error(`Unknown documentId for case ${entry.caseId}: ${documentId}`)
  return {
    caseId: entry.caseId,
    document: {
      documentId: document.id,
      path: documentPath(entry, document),
      text: document.text,
      title: document.title ?? null,
    },
  }
}

function readDocuments(entry: RagbenchCase, documentIds: string[]): unknown {
  return {
    caseId: entry.caseId,
    documents: documentIds.map((documentId) => readDocument(entry, documentId)).map((result) => {
      const record = result as { document: unknown }
      return record.document
    }),
  }
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
}

async function main(): Promise<void> {
  const [command, ...rawArgs] = process.argv.slice(2)
  if (command !== 'search' && command !== 'read' && command !== 'read-many') {
    throw new Error('Usage: vector-agent-tool.ts <search|read|read-many> --cases <path> --case-id <id> ...')
  }

  const { values } = parseArgs({
    args: rawArgs,
    options: {
      cases: { type: 'string' },
      'case-id': { type: 'string' },
      'document-id': { type: 'string' },
      'document-ids': { type: 'string' },
      query: { type: 'string' },
      'top-k': { type: 'string', default: '8' },
    },
  })

  if (!values.cases) throw new Error('--cases is required')
  if (!values['case-id']) throw new Error('--case-id is required')

  const cases = await readCases(resolve(values.cases))
  const entry = findCase(cases, values['case-id'])
  if (command === 'search') {
    if (!values.query) throw new Error('--query is required for search')
    const topK = parsePositiveInteger('top-k', values['top-k'])
    console.log(JSON.stringify(searchDocuments(entry, values.query, topK), null, 2))
    return
  }

  if (command === 'read-many') {
    if (!values['document-ids']) throw new Error('--document-ids is required for read-many')
    const documentIds = values['document-ids'].split(',').map((entry) => entry.trim()).filter(Boolean)
    if (documentIds.length === 0) throw new Error('--document-ids must contain at least one id')
    console.log(JSON.stringify(readDocuments(entry, documentIds), null, 2))
    return
  }

  if (!values['document-id']) throw new Error('--document-id is required for read')
  console.log(JSON.stringify(readDocument(entry, values['document-id']), null, 2))
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
