import type { RagbenchCase, RagbenchDocument } from './types.js'

const DATASET_NAME = 'galileo-ai/ragbench'
const ROWS_ENDPOINT = 'https://datasets-server.huggingface.co/rows'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function firstString(record: Record<string, unknown>, fields: string[], fallback = ''): string {
  for (const field of fields) {
    const value = record[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return fallback
}

function firstPresent(record: Record<string, unknown>, fields: string[]): unknown {
  for (const field of fields) {
    if (field in record) return record[field]
  }
  return undefined
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => collectStrings(entry))
}

function documentTitleFromText(text: string): string | undefined {
  const titleMatch = /^Title:\s*(.+)$/im.exec(text)
  return titleMatch?.[1]?.trim()
}

function documentTextFromRecord(record: Record<string, unknown>): string {
  const text = firstString(record, ['text', 'content', 'document', 'page_content', 'body'])
  return text.length > 0 ? text : JSON.stringify(record) ?? ''
}

function parseDocuments(value: unknown): RagbenchDocument[] {
  const rawDocuments = Array.isArray(value) ? value : []
  return rawDocuments.map((entry, index) => {
    if (typeof entry === 'string') {
      return {
        id: String(index),
        text: entry,
        title: documentTitleFromText(entry),
      }
    }

    const record = asRecord(entry)
    if (!record) {
      const text = JSON.stringify(entry) ?? String(entry)
      return {
        id: String(index),
        text,
        title: documentTitleFromText(text),
      }
    }

    const text = documentTextFromRecord(record)
    const title = firstString(record, ['title', 'name', 'source'], documentTitleFromText(text) ?? '')
    return {
      id: String(index),
      text,
      title: title || undefined,
    }
  })
}

function documentIdFromSentenceKey(key: string): string | null {
  const trimmed = key.trim()
  const leadingDigits = /^(\d+)/u.exec(trimmed)
  if (leadingDigits) return leadingDigits[1]

  const documentPrefixed = /(?:^|[_\-\s])doc(?:ument)?[_\-\s]?(\d+)(?:$|[_\-\s])/iu.exec(trimmed)
  return documentPrefixed?.[1] ?? null
}

function uniqueSortedDocumentIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => {
    const numericA = Number(a)
    const numericB = Number(b)
    if (Number.isFinite(numericA) && Number.isFinite(numericB)) return numericA - numericB
    return a.localeCompare(b)
  })
}

function documentIdsFromSentenceKeys(keys: string[]): string[] {
  return uniqueSortedDocumentIds(keys.flatMap((key) => {
    const id = documentIdFromSentenceKey(key)
    return id ? [id] : []
  }))
}

function documentIdsFromDirectValues(value: unknown): string[] {
  return uniqueSortedDocumentIds(collectStrings(value).map((entry) => {
    const sentenceKeyId = documentIdFromSentenceKey(entry)
    return sentenceKeyId ?? entry.trim()
  }).filter((entry) => entry.length > 0))
}

function supportingKeysFromInformation(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => supportingKeysFromInformation(entry))

  const record = asRecord(value)
  if (!record) return []

  return [
    ...collectStrings(record.supporting_sentence_keys),
    ...collectStrings(record.relevant_sentence_keys),
    ...collectStrings(record.sentence_keys),
  ]
}

function extractSupportingDocumentIds(row: Record<string, unknown>): string[] {
  for (const field of ['all_relevant_sentence_keys', 'relevant_sentence_keys', 'all_utilized_sentence_keys']) {
    const ids = documentIdsFromSentenceKeys(collectStrings(row[field]))
    if (ids.length > 0) return ids
  }

  const supportInfoIds = documentIdsFromSentenceKeys(supportingKeysFromInformation(row.sentence_support_information))
  if (supportInfoIds.length > 0) return supportInfoIds

  for (const field of ['supporting_document_ids', 'supportingDocumentIds', 'supporting_doc_ids']) {
    const ids = documentIdsFromDirectValues(row[field])
    if (ids.length > 0) return ids
  }

  return []
}

function rowContext(opts: { config: string, index: number, split: string }): string {
  return `${opts.config}/${opts.split} index ${opts.index}`
}

export function normalizeRagbenchRow(opts: {
  config: string
  index: number
  row: Record<string, unknown>
  split: string
}): RagbenchCase {
  const documents = parseDocuments(firstPresent(opts.row, ['documents', 'contexts', 'passages']))
  const entry = {
    caseId: `${opts.config}-${opts.split}-${opts.index}`,
    config: opts.config,
    split: opts.split,
    question: firstString(opts.row, ['question', 'query', 'prompt']),
    referenceAnswer: firstString(opts.row, ['response', 'answer', 'reference_answer']),
    documents,
    supportingDocumentIds: extractSupportingDocumentIds(opts.row),
    raw: opts.row,
  }

  const context = rowContext(opts)
  if (entry.question.trim().length === 0) {
    throw new Error(`Invalid RAGBench row ${context}: missing question`)
  }
  if (entry.referenceAnswer.trim().length === 0) {
    throw new Error(`Invalid RAGBench row ${context}: missing reference answer`)
  }
  if (entry.documents.length === 0) {
    throw new Error(`Invalid RAGBench row ${context}: missing documents`)
  }

  return entry
}

function rowsFromPayload(payload: unknown, opts: {
  config: string
  offset: number
  split: string
}): unknown[] {
  const response = asRecord(payload)
  if (!response || !Array.isArray(response.rows)) {
    throw new Error(
      `Invalid RAGBench response for ${opts.config}/${opts.split} offset ${opts.offset}: expected rows array`,
    )
  }
  return response.rows
}

function rowFromEntry(entry: unknown, opts: {
  config: string
  index: number
  offset: number
  split: string
}): Record<string, unknown> {
  const wrapper = asRecord(entry)
  if (!wrapper) {
    throw new Error(
      `Invalid RAGBench row wrapper for ${opts.config}/${opts.split} offset ${opts.offset} index ${opts.index}: expected object`,
    )
  }

  const row = asRecord(wrapper.row)
  if (!row) {
    throw new Error(
      `Invalid RAGBench row for ${opts.config}/${opts.split} offset ${opts.offset} index ${opts.index}: expected row object`,
    )
  }
  return row
}

export async function fetchRagbenchRows(opts: {
  config: string
  split: string
  offset: number
  length: number
}): Promise<RagbenchCase[]> {
  const params = new URLSearchParams({
    dataset: DATASET_NAME,
    config: opts.config,
    split: opts.split,
    offset: String(opts.offset),
    length: String(opts.length),
  })
  const response = await fetch(`${ROWS_ENDPOINT}?${params}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch RAGBench rows: ${response.status} ${await response.text()}`)
  }

  const payload: unknown = await response.json()
  return rowsFromPayload(payload, opts).map((entry, index) => {
    const rowIndex = opts.offset + index
    return normalizeRagbenchRow({
      config: opts.config,
      index: rowIndex,
      row: rowFromEntry(entry, {
        config: opts.config,
        index: rowIndex,
        offset: opts.offset,
        split: opts.split,
      }),
      split: opts.split,
    })
  })
}
