import { createHash } from 'node:crypto'
import { asRecord, getString } from './io.js'
import type { JsonPrimitive, MultihopDocument, MultihopGold, MultihopQuestion, NormalizedDataset } from './types.js'

interface DocumentLookup {
  documents: MultihopDocument[]
  keyToDocumentId: Map<string, string | null>
}

export interface NormalizeOptions {
  limit?: number
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}

function safeMetadataValue(value: unknown): JsonPrimitive | undefined {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return undefined
}

function pickMetadata(record: Record<string, unknown>, fields: string[]): Record<string, JsonPrimitive> {
  const metadata: Record<string, JsonPrimitive> = {}
  for (const field of fields) {
    const value = safeMetadataValue(record[field])
    if (value !== undefined) metadata[field] = value
  }
  return metadata
}

function documentFingerprint(record: Record<string, unknown>): string {
  return [
    getString(record, 'url') ?? '',
    getString(record, 'title') ?? '',
    getString(record, 'source') ?? '',
    getString(record, 'published_at') ?? '',
  ].join('\n')
}

function createDocumentId(record: Record<string, unknown>): string {
  return `doc_${hashText(documentFingerprint(record) || JSON.stringify(record))}`
}

function documentKeys(record: Record<string, unknown>): string[] {
  const title = getString(record, 'title')
  const url = getString(record, 'url')
  const source = getString(record, 'source')
  const publishedAt = getString(record, 'published_at')
  const keys: string[] = []

  if (url) keys.push(`url:${url}`)
  if (title && source && publishedAt) keys.push(`title-source-published:${title}\0${source}\0${publishedAt}`)
  if (title && source) keys.push(`title-source:${title}\0${source}`)
  if (title && publishedAt) keys.push(`title-published:${title}\0${publishedAt}`)
  return keys.map((key) => normalizeWhitespace(key).toLowerCase())
}

function addLookupKey(map: Map<string, string | null>, key: string, documentId: string): void {
  const existing = map.get(key)
  if (existing === undefined) {
    map.set(key, documentId)
    return
  }
  if (existing !== documentId) map.set(key, null)
}

function normalizeCorpus(corpusRows: unknown[]): DocumentLookup {
  const documentsById = new Map<string, MultihopDocument>()
  const keyToDocumentId = new Map<string, string | null>()

  for (const row of corpusRows) {
    const record = asRecord(row)
    if (!record) continue

    const title = getString(record, 'title')
    const text = getString(record, 'body') ?? getString(record, 'text')
    if (!title || !text) continue

    const documentId = createDocumentId(record)
    if (!documentsById.has(documentId)) {
      documentsById.set(documentId, {
        documentId,
        metadata: pickMetadata(record, ['author', 'category', 'published_at', 'source', 'url']),
        source: row,
        text,
        title,
      })
    }

    for (const key of documentKeys(record)) {
      addLookupKey(keyToDocumentId, key, documentId)
    }
  }

  return {
    documents: [...documentsById.values()],
    keyToDocumentId,
  }
}

function lookupDocumentId(lookup: DocumentLookup, evidence: Record<string, unknown>): string | undefined {
  for (const key of documentKeys(evidence)) {
    const documentId = lookup.keyToDocumentId.get(key)
    if (documentId) return documentId
  }
  return undefined
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function createCaseId(index: number, query: string): string {
  return `case_${String(index + 1).padStart(4, '0')}_${hashText(query).slice(0, 8)}`
}

export function normalizeMultihopDataset(
  queryRows: unknown[],
  corpusRows: unknown[],
  options: NormalizeOptions = {},
): NormalizedDataset {
  const lookup = normalizeCorpus(corpusRows)
  const questions: MultihopQuestion[] = []
  const gold: MultihopGold[] = []
  let skippedQuestions = 0

  for (const [index, row] of queryRows.entries()) {
    if (options.limit !== undefined && questions.length >= options.limit) break

    const record = asRecord(row)
    if (!record) {
      skippedQuestions += 1
      continue
    }

    const question = getString(record, 'query') ?? getString(record, 'question')
    const answer = getString(record, 'answer')
    const evidenceList = record.evidence_list
    if (!question || !answer || !Array.isArray(evidenceList)) {
      skippedQuestions += 1
      continue
    }

    const supportingEvidence: NonNullable<MultihopGold['supportingEvidence']> = []
    const supportingDocumentIds: string[] = []
    let missingEvidence = false

    for (const evidence of evidenceList) {
      const evidenceRecord = asRecord(evidence)
      if (!evidenceRecord) {
        missingEvidence = true
        continue
      }

      const documentId = lookupDocumentId(lookup, evidenceRecord)
      if (!documentId) {
        missingEvidence = true
        continue
      }

      supportingDocumentIds.push(documentId)
      supportingEvidence.push({
        documentId,
        metadata: pickMetadata(evidenceRecord, ['author', 'category', 'published_at', 'source', 'title', 'url']),
        text: getString(evidenceRecord, 'fact'),
      })
    }

    const uniqueSupportingDocumentIds = uniqueSorted(supportingDocumentIds)
    if (missingEvidence || uniqueSupportingDocumentIds.length === 0) {
      skippedQuestions += 1
      continue
    }

    const caseId = createCaseId(index, question)
    const queryType = getString(record, 'question_type')
    questions.push({
      caseId,
      metadata: pickMetadata(record, ['question_type']),
      question,
      queryType,
      source: row,
    })
    gold.push({
      answer,
      caseId,
      supportingDocumentIds: uniqueSupportingDocumentIds,
      supportingEvidence,
    })
  }

  return {
    documents: lookup.documents,
    gold,
    questions,
    skippedQuestions,
  }
}
