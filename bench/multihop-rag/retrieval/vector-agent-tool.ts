import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { readJsonl } from '../io.js'
import { Bm25Index } from './bm25.js'
import type { MultihopDocument } from '../types.js'

const TEXT_PREVIEW_LENGTH = 640

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

async function readDocuments(path: string): Promise<MultihopDocument[]> {
  return readJsonl<MultihopDocument>(resolve(path))
}

function findDocument(documents: MultihopDocument[], documentId: string): MultihopDocument {
  const document = documents.find((candidate) => candidate.documentId === documentId)
  if (!document) throw new Error(`Unknown documentId: ${documentId}`)
  return document
}

function documentPath(documentId: string): string {
  return `corpus/news/${documentId}.md`
}

function searchDocuments(documents: MultihopDocument[], query: string, topK: number): unknown {
  const index = new Bm25Index(documents)
  return {
    query,
    results: index.search(query, topK).map((result) => ({
      documentId: result.document.documentId,
      path: documentPath(result.document.documentId),
      score: result.score,
      textPreview: result.document.text.slice(0, TEXT_PREVIEW_LENGTH),
      title: result.document.title,
    })),
  }
}

function readDocument(document: MultihopDocument, startLine = 1, endLine = 80): unknown {
  const lines = document.text.split(/\r?\n/u)
  const start = Math.max(1, startLine)
  const end = Math.min(lines.length, Math.max(start, endLine))
  return {
    document: {
      documentId: document.documentId,
      path: documentPath(document.documentId),
      title: document.title,
      lines: lines.slice(start - 1, end).map((text, index) => ({
        lineNumber: start + index,
        text,
      })),
      totalLines: lines.length,
    },
  }
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
}

async function main(): Promise<void> {
  const [command, ...rawArgs] = process.argv.slice(2)
  if (command !== 'search' && command !== 'read' && command !== 'read-many') {
    throw new Error('Usage: vector-agent-tool.ts <search|read|read-many> --documents <path> ...')
  }

  const { values } = parseArgs({
    args: rawArgs,
    options: {
      documents: { type: 'string' },
      'document-id': { type: 'string' },
      'document-ids': { type: 'string' },
      'end-line': { type: 'string', default: '80' },
      query: { type: 'string' },
      'start-line': { type: 'string', default: '1' },
      'top-k': { type: 'string', default: '10' },
    },
  })

  if (!values.documents) throw new Error('--documents is required')
  const documents = await readDocuments(values.documents)

  if (command === 'search') {
    if (!values.query) throw new Error('--query is required for search')
    console.log(JSON.stringify(searchDocuments(documents, values.query, parsePositiveInteger('top-k', values['top-k'])), null, 2))
    return
  }

  if (command === 'read-many') {
    if (!values['document-ids']) throw new Error('--document-ids is required for read-many')
    const documentIds = values['document-ids'].split(',').map((entry) => entry.trim()).filter(Boolean)
    const startLine = parsePositiveInteger('start-line', values['start-line'])
    const endLine = parsePositiveInteger('end-line', values['end-line'])
    console.log(JSON.stringify({
      documents: documentIds.map((documentId) => readDocument(findDocument(documents, documentId), startLine, endLine)),
    }, null, 2))
    return
  }

  if (!values['document-id']) throw new Error('--document-id is required for read')
  console.log(JSON.stringify(readDocument(
    findDocument(documents, values['document-id']),
    parsePositiveInteger('start-line', values['start-line']),
    parsePositiveInteger('end-line', values['end-line']),
  ), null, 2))
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
