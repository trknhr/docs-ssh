import type { MultihopDocument } from '../types.js'

export interface Bm25SearchResult {
  document: MultihopDocument
  rank: number
  score: number
}

interface IndexedDocument {
  document: MultihopDocument
  length: number
  termCounts: Map<string, number>
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/gu) ?? []
}

export class Bm25Index {
  private readonly averageLength: number
  private readonly docFreq = new Map<string, number>()
  private readonly docs: IndexedDocument[]
  private readonly k1 = 1.2
  private readonly b = 0.75

  constructor(documents: MultihopDocument[]) {
    this.docs = documents.map((document) => {
      const terms = tokenize([
        document.title,
        document.metadata.source,
        document.metadata.category,
        document.metadata.published_at,
        document.text,
      ].filter((part) => typeof part === 'string').join('\n'))
      const termCounts = new Map<string, number>()
      for (const term of terms) {
        termCounts.set(term, (termCounts.get(term) ?? 0) + 1)
      }
      for (const term of termCounts.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1)
      }
      return {
        document,
        length: terms.length,
        termCounts,
      }
    })

    const totalLength = this.docs.reduce((sum, doc) => sum + doc.length, 0)
    this.averageLength = this.docs.length === 0 ? 0 : totalLength / this.docs.length
  }

  search(query: string, topK: number): Bm25SearchResult[] {
    const queryTerms = [...new Set(tokenize(query))]
    if (queryTerms.length === 0 || topK <= 0 || this.docs.length === 0) return []

    const results: Bm25SearchResult[] = []
    for (const indexed of this.docs) {
      let score = 0
      for (const term of queryTerms) {
        const termFrequency = indexed.termCounts.get(term) ?? 0
        if (termFrequency === 0) continue

        const documentFrequency = this.docFreq.get(term) ?? 0
        const idf = Math.log(1 + (this.docs.length - documentFrequency + 0.5) / (documentFrequency + 0.5))
        const denominator =
          termFrequency + this.k1 * (1 - this.b + this.b * (indexed.length / Math.max(1, this.averageLength)))
        score += idf * ((termFrequency * (this.k1 + 1)) / denominator)
      }

      if (score > 0) {
        results.push({
          document: indexed.document,
          rank: 0,
          score,
        })
      }
    }

    return results
      .sort((left, right) => right.score - left.score || left.document.documentId.localeCompare(right.document.documentId))
      .slice(0, topK)
      .map((result, index) => ({
        ...result,
        rank: index + 1,
      }))
  }
}
