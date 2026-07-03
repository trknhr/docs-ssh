import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Bm25Index, type Bm25SearchResult } from './bm25.js'
import type { MultihopDocument, MultihopQuestion, RetrievedCandidate, RetrievalRun } from '../types.js'

const DEFAULT_EMBEDDING_MAX_CHARS = 12000
const DEFAULT_RRF_K = 60
const TEXT_PREVIEW_LENGTH = 240

export interface EmbeddingProvider {
  model: string
  embed(input: string[]): Promise<{
    promptTokens?: number
    totalTokens?: number
    vectors: number[][]
  }>
}

export interface Reranker {
  model: string
  rerank(opts: {
    candidates: MultihopDocument[]
    question: string
    topK: number
  }): Promise<{
    documentIds: string[]
    inputTokens?: number
    outputTokens?: number
  }>
}

interface EmbeddingCacheRecord {
  embedding: number[]
  textHash: string
}

interface EmbeddingCacheFile {
  model: string
  records: Record<string, EmbeddingCacheRecord>
}

interface EmbeddingItem {
  key: string
  text: string
}

interface RankedDocument {
  document: MultihopDocument
  score: number
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'default'
}

function textPreview(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').slice(0, TEXT_PREVIEW_LENGTH)
}

function metadataString(document: MultihopDocument, key: string): string {
  const value = document.metadata[key]
  return typeof value === 'string' ? value : ''
}

export function defaultEmbeddingCachePath(cacheDir: string, model: string): string {
  return `${cacheDir.replace(/\/$/u, '')}/embeddings-${safeName(model)}.json`
}

export function documentEmbeddingText(document: MultihopDocument, maxChars = DEFAULT_EMBEDDING_MAX_CHARS): string {
  return [
    `Title: ${document.title}`,
    `Source: ${metadataString(document, 'source')}`,
    `Category: ${metadataString(document, 'category')}`,
    `Published at: ${metadataString(document, 'published_at')}`,
    '',
    document.text,
  ].join('\n').slice(0, maxChars)
}

function questionEmbeddingText(question: MultihopQuestion): string {
  return question.question
}

async function loadEmbeddingCache(path: string, model: string): Promise<EmbeddingCacheFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as EmbeddingCacheFile
    if (parsed.model === model && parsed.records && typeof parsed.records === 'object') return parsed
  } catch {
    // Missing or stale caches are rebuilt on demand.
  }
  return { model, records: {} }
}

async function saveEmbeddingCache(path: string, cache: EmbeddingCacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(cache)}\n`, 'utf8')
}

export async function ensureEmbeddings(opts: {
  batchSize: number
  cachePath: string
  items: EmbeddingItem[]
  provider: EmbeddingProvider
}): Promise<{
  embeddings: Map<string, number[]>
  promptTokens: number
  totalTokens: number
}> {
  const cache = await loadEmbeddingCache(opts.cachePath, opts.provider.model)
  const embeddings = new Map<string, number[]>()
  const missing: EmbeddingItem[] = []

  for (const item of opts.items) {
    const textHash = hashText(item.text)
    const cached = cache.records[item.key]
    if (cached?.textHash === textHash) {
      embeddings.set(item.key, cached.embedding)
    } else {
      missing.push(item)
    }
  }

  let promptTokens = 0
  let totalTokens = 0
  for (let index = 0; index < missing.length; index += opts.batchSize) {
    const batch = missing.slice(index, index + opts.batchSize)
    const response = await opts.provider.embed(batch.map((item) => item.text))
    if (response.vectors.length !== batch.length) {
      throw new Error(`Embedding provider returned ${response.vectors.length} vectors for ${batch.length} inputs`)
    }
    promptTokens += response.promptTokens ?? 0
    totalTokens += response.totalTokens ?? 0

    for (const [batchIndex, item] of batch.entries()) {
      const embedding = response.vectors[batchIndex]
      if (!embedding) throw new Error(`Embedding provider omitted vector for ${item.key}`)
      cache.records[item.key] = {
        embedding,
        textHash: hashText(item.text),
      }
      embeddings.set(item.key, embedding)
    }
    await saveEmbeddingCache(opts.cachePath, cache)
  }

  return { embeddings, promptTokens, totalTokens }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string
  readonly #apiKey: string
  readonly #baseUrl: string
  readonly #dimensions: number | undefined

  constructor(opts: {
    apiKey: string
    baseUrl?: string
    dimensions?: number
    model: string
  }) {
    this.#apiKey = opts.apiKey
    this.#baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1'
    this.#dimensions = opts.dimensions
    this.model = opts.model
  }

  async embed(input: string[]): Promise<{ promptTokens?: number; totalTokens?: number; vectors: number[][] }> {
    const response = await fetch(`${this.#baseUrl}/embeddings`, {
      body: JSON.stringify({
        model: this.model,
        input,
        ...(this.#dimensions ? { dimensions: this.#dimensions } : {}),
      }),
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    const payload = await response.json() as {
      data?: Array<{ embedding?: number[]; index?: number }>
      error?: { message?: string }
      usage?: { prompt_tokens?: number; total_tokens?: number }
    }
    if (!response.ok) {
      throw new Error(`OpenAI embeddings request failed: ${payload.error?.message ?? response.statusText}`)
    }
    const vectors = (payload.data ?? [])
      .slice()
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((item) => {
        if (!Array.isArray(item.embedding)) throw new Error('OpenAI embeddings response omitted an embedding')
        return item.embedding
      })
    return {
      promptTokens: payload.usage?.prompt_tokens,
      totalTokens: payload.usage?.total_tokens,
      vectors,
    }
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftNorm += leftValue * leftValue
    rightNorm += rightValue * rightValue
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

function rankDenseDocuments(opts: {
  documentEmbeddings: Map<string, number[]>
  documents: MultihopDocument[]
  queryEmbedding: number[]
  topK: number
}): RankedDocument[] {
  return opts.documents
    .map((document) => ({
      document,
      score: cosineSimilarity(opts.queryEmbedding, opts.documentEmbeddings.get(document.documentId) ?? []),
    }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.document.documentId.localeCompare(right.document.documentId))
    .slice(0, opts.topK)
}

function toCandidates(results: RankedDocument[], mode: RetrievalRun['mode']): RetrievedCandidate[] {
  return results.map((result, index) => ({
    documentId: result.document.documentId,
    rank: index + 1,
    score: result.score,
    textPreview: textPreview(result.document.text),
    path: `corpus/news/${result.document.documentId}.md`,
  }))
}

function bm25ToRanked(results: Bm25SearchResult[]): RankedDocument[] {
  return results.map((result) => ({
    document: result.document,
    score: result.score,
  }))
}

function reciprocalRankFusion(resultSets: RankedDocument[][], topK: number, rrfK: number): RankedDocument[] {
  const scores = new Map<string, { document: MultihopDocument; score: number }>()
  for (const results of resultSets) {
    for (const [index, result] of results.entries()) {
      const existing = scores.get(result.document.documentId)
      const score = 1 / (rrfK + index + 1)
      if (existing) {
        existing.score += score
      } else {
        scores.set(result.document.documentId, {
          document: result.document,
          score,
        })
      }
    }
  }

  return [...scores.values()]
    .sort((left, right) => right.score - left.score || left.document.documentId.localeCompare(right.document.documentId))
    .slice(0, topK)
}

async function ensureDocumentEmbeddings(opts: {
  batchSize: number
  cachePath: string
  documents: MultihopDocument[]
  embeddingMaxChars: number
  provider: EmbeddingProvider
}): Promise<Map<string, number[]>> {
  const cached = await ensureEmbeddings({
    batchSize: opts.batchSize,
    cachePath: opts.cachePath,
    items: opts.documents.map((document) => ({
      key: `document:${document.documentId}`,
      text: documentEmbeddingText(document, opts.embeddingMaxChars),
    })),
    provider: opts.provider,
  })
  return new Map(opts.documents.map((document) => [
    document.documentId,
    cached.embeddings.get(`document:${document.documentId}`) ?? [],
  ]))
}

async function ensureQuestionEmbedding(opts: {
  batchSize: number
  cachePath: string
  provider: EmbeddingProvider
  question: MultihopQuestion
}): Promise<{ promptTokens: number; totalTokens: number; vector: number[] }> {
  const result = await ensureEmbeddings({
    batchSize: opts.batchSize,
    cachePath: opts.cachePath,
    items: [{
      key: `question:${opts.question.caseId}`,
      text: questionEmbeddingText(opts.question),
    }],
    provider: opts.provider,
  })
  return {
    promptTokens: result.promptTokens,
    totalTokens: result.totalTokens,
    vector: result.embeddings.get(`question:${opts.question.caseId}`) ?? [],
  }
}

export async function runDenseRetrieval(opts: {
  batchSize: number
  cachePath: string
  documents: MultihopDocument[]
  embeddingMaxChars?: number
  limit?: number
  provider: EmbeddingProvider
  questions: MultihopQuestion[]
  topK: number
}): Promise<RetrievalRun[]> {
  const documentEmbeddings = await ensureDocumentEmbeddings({
    batchSize: opts.batchSize,
    cachePath: opts.cachePath,
    documents: opts.documents,
    embeddingMaxChars: opts.embeddingMaxChars ?? DEFAULT_EMBEDDING_MAX_CHARS,
    provider: opts.provider,
  })
  const selectedQuestions = opts.limit === undefined ? opts.questions : opts.questions.slice(0, opts.limit)
  const runs: RetrievalRun[] = []

  for (const question of selectedQuestions) {
    const startedAt = performance.now()
    const queryEmbedding = await ensureQuestionEmbedding({
      batchSize: opts.batchSize,
      cachePath: opts.cachePath,
      provider: opts.provider,
      question,
    })
    const results = rankDenseDocuments({
      documentEmbeddings,
      documents: opts.documents,
      queryEmbedding: queryEmbedding.vector,
      topK: opts.topK,
    })
    const candidates = toCandidates(results, 'dense')
    runs.push({
      bytesRead: candidates.reduce((sum, candidate) => sum + Buffer.byteLength(candidate.textPreview ?? '', 'utf8'), 0),
      candidates,
      caseId: question.caseId,
      commandCount: 0,
      elapsedMs: performance.now() - startedAt,
      errors: [],
      filesRead: candidates.length,
      mode: 'dense',
      modelInputTokens: queryEmbedding.promptTokens,
      modelOutputTokens: 0,
      question: question.question,
      sshExecCount: 0,
    })
  }

  return runs
}

export async function runHybridRetrieval(opts: {
  batchSize: number
  cachePath: string
  candidateK: number
  documents: MultihopDocument[]
  embeddingMaxChars?: number
  limit?: number
  provider: EmbeddingProvider
  questions: MultihopQuestion[]
  rrfK?: number
  topK: number
}): Promise<RetrievalRun[]> {
  const documentEmbeddings = await ensureDocumentEmbeddings({
    batchSize: opts.batchSize,
    cachePath: opts.cachePath,
    documents: opts.documents,
    embeddingMaxChars: opts.embeddingMaxChars ?? DEFAULT_EMBEDDING_MAX_CHARS,
    provider: opts.provider,
  })
  const bm25 = new Bm25Index(opts.documents)
  const selectedQuestions = opts.limit === undefined ? opts.questions : opts.questions.slice(0, opts.limit)
  const runs: RetrievalRun[] = []

  for (const question of selectedQuestions) {
    const startedAt = performance.now()
    const queryEmbedding = await ensureQuestionEmbedding({
      batchSize: opts.batchSize,
      cachePath: opts.cachePath,
      provider: opts.provider,
      question,
    })
    const dense = rankDenseDocuments({
      documentEmbeddings,
      documents: opts.documents,
      queryEmbedding: queryEmbedding.vector,
      topK: opts.candidateK,
    })
    const lexical = bm25ToRanked(bm25.search(question.question, opts.candidateK))
    const results = reciprocalRankFusion([lexical, dense], opts.topK, opts.rrfK ?? DEFAULT_RRF_K)
    const candidates = toCandidates(results, 'hybrid')
    runs.push({
      bytesRead: candidates.reduce((sum, candidate) => sum + Buffer.byteLength(candidate.textPreview ?? '', 'utf8'), 0),
      candidates,
      caseId: question.caseId,
      commandCount: 0,
      elapsedMs: performance.now() - startedAt,
      errors: [],
      filesRead: candidates.length,
      mode: 'hybrid',
      modelInputTokens: queryEmbedding.promptTokens,
      modelOutputTokens: 0,
      question: question.question,
      sshExecCount: 0,
    })
  }

  return runs
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  if (start === -1) throw new Error('reranker response did not contain JSON')
  let depth = 0
  let escaped = false
  let inString = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return JSON.parse(text.slice(start, index + 1))
    }
  }
  throw new Error('reranker response did not contain complete JSON')
}

function outputTextFromResponsesPayload(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === 'string') return payload.output_text
  const output = Array.isArray(payload.output) ? payload.output : []
  const parts: string[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : []
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== 'object') continue
      const text = (contentItem as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

export class OpenAIReranker implements Reranker {
  readonly model: string
  readonly #apiKey: string
  readonly #baseUrl: string

  constructor(opts: {
    apiKey: string
    baseUrl?: string
    model: string
  }) {
    this.#apiKey = opts.apiKey
    this.#baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1'
    this.model = opts.model
  }

  async rerank(opts: {
    candidates: MultihopDocument[]
    question: string
    topK: number
  }): Promise<{ documentIds: string[]; inputTokens?: number; outputTokens?: number }> {
    const input = [
      'Rerank the candidate documents by how likely they contain evidence needed to answer the question.',
      'Use only the candidate text. Return JSON only: {"documentIds":["doc_id", "..."]}.',
      `Return at most ${opts.topK} ids.`,
      '',
      `Question: ${opts.question}`,
      '',
      'Candidates:',
      ...opts.candidates.map((document, index) => [
        `Candidate ${index + 1}`,
        `Document ID: ${document.documentId}`,
        `Title: ${document.title}`,
        `Source: ${metadataString(document, 'source')}`,
        `Category: ${metadataString(document, 'category')}`,
        'Text:',
        document.text.slice(0, 1800),
      ].join('\n')),
    ].join('\n\n')

    const response = await fetch(`${this.#baseUrl}/responses`, {
      body: JSON.stringify({
        input,
        max_output_tokens: 800,
        model: this.model,
      }),
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
    const payload = await response.json() as Record<string, unknown> & {
      error?: { message?: string }
      usage?: {
        input_tokens?: number
        output_tokens?: number
      }
    }
    if (!response.ok) {
      throw new Error(`OpenAI rerank request failed: ${payload.error?.message ?? response.statusText}`)
    }

    const parsed = extractJsonObject(outputTextFromResponsesPayload(payload)) as { documentIds?: unknown }
    const documentIds = Array.isArray(parsed.documentIds)
      ? parsed.documentIds.filter((documentId): documentId is string => typeof documentId === 'string')
      : []
    return {
      documentIds,
      inputTokens: payload.usage?.input_tokens,
      outputTokens: payload.usage?.output_tokens,
    }
  }
}

export async function runHybridRerankRetrieval(opts: {
  batchSize: number
  cachePath: string
  candidateK: number
  documents: MultihopDocument[]
  embeddingMaxChars?: number
  limit?: number
  provider: EmbeddingProvider
  questions: MultihopQuestion[]
  reranker: Reranker
  rerankTopN: number
  rrfK?: number
  topK: number
}): Promise<RetrievalRun[]> {
  const documentEmbeddings = await ensureDocumentEmbeddings({
    batchSize: opts.batchSize,
    cachePath: opts.cachePath,
    documents: opts.documents,
    embeddingMaxChars: opts.embeddingMaxChars ?? DEFAULT_EMBEDDING_MAX_CHARS,
    provider: opts.provider,
  })
  const documentsById = new Map(opts.documents.map((document) => [document.documentId, document]))
  const bm25 = new Bm25Index(opts.documents)
  const selectedQuestions = opts.limit === undefined ? opts.questions : opts.questions.slice(0, opts.limit)
  const runs: RetrievalRun[] = []

  for (const question of selectedQuestions) {
    const startedAt = performance.now()
    const errors: string[] = []
    const queryEmbedding = await ensureQuestionEmbedding({
      batchSize: opts.batchSize,
      cachePath: opts.cachePath,
      provider: opts.provider,
      question,
    })
    const dense = rankDenseDocuments({
      documentEmbeddings,
      documents: opts.documents,
      queryEmbedding: queryEmbedding.vector,
      topK: opts.candidateK,
    })
    const lexical = bm25ToRanked(bm25.search(question.question, opts.candidateK))
    const fused = reciprocalRankFusion([lexical, dense], opts.rerankTopN, opts.rrfK ?? DEFAULT_RRF_K)
    const candidateDocuments = fused.map((result) => result.document)
    const reranked = await opts.reranker.rerank({
      candidates: candidateDocuments,
      question: question.question,
      topK: opts.topK,
    })

    const seen = new Set<string>()
    const rerankedDocuments: RankedDocument[] = []
    for (const documentId of reranked.documentIds) {
      const document = documentsById.get(documentId)
      if (!document) {
        errors.push(`Reranker returned unknown documentId: ${documentId}`)
        continue
      }
      if (!seen.has(documentId)) {
        seen.add(documentId)
        rerankedDocuments.push({
          document,
          score: opts.topK - rerankedDocuments.length,
        })
      }
    }
    for (const result of fused) {
      if (rerankedDocuments.length >= opts.topK) break
      if (seen.has(result.document.documentId)) continue
      seen.add(result.document.documentId)
      rerankedDocuments.push(result)
    }

    const candidates = toCandidates(rerankedDocuments.slice(0, opts.topK), 'hybrid-rerank')
    runs.push({
      bytesRead: candidates.reduce((sum, candidate) => sum + Buffer.byteLength(candidate.textPreview ?? '', 'utf8'), 0),
      candidates,
      caseId: question.caseId,
      commandCount: 1,
      elapsedMs: performance.now() - startedAt,
      errors,
      filesRead: candidateDocuments.length,
      mode: 'hybrid-rerank',
      modelInputTokens: (queryEmbedding.promptTokens ?? 0) + (reranked.inputTokens ?? 0),
      modelOutputTokens: reranked.outputTokens ?? 0,
      question: question.question,
      sshExecCount: 0,
    })
  }

  return runs
}
