export interface RagbenchDocument {
  id: string
  text: string
  title?: string
}

export interface RagbenchCase {
  caseId: string
  config: string
  split: string
  question: string
  referenceAnswer: string
  documents: RagbenchDocument[]
  supportingDocumentIds: string[]
  raw: unknown
}

export interface RetrievedCandidate {
  documentId: string
  path: string
  score: number
  textPreview: string
}

export interface RetrievalRun {
  caseId: string
  mode: 'docs-ssh' | 'vector'
  question: string
  candidates: RetrievedCandidate[]
  elapsedMs: number
  commandCount: number
  filesRead: number
  bytesRead: number
  errors: string[]
}

export interface CaseScore {
  caseId: string
  mode: RetrievalRun['mode']
  hitAt1: boolean
  hitAt3: boolean
  hitAt5: boolean
  reciprocalRank: number
  expectedDocumentIds: string[]
  retrievedDocumentIds: string[]
  elapsedMs: number
  commandCount: number
  filesRead: number
  bytesRead: number
  errors: string[]
}
