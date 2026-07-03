export type JsonPrimitive = string | number | boolean | null

export interface MultihopDocument {
  documentId: string
  title: string
  text: string
  metadata: Record<string, JsonPrimitive>
  source: unknown
}

export interface MultihopQuestion {
  caseId: string
  question: string
  queryType?: string
  metadata: Record<string, JsonPrimitive>
  source: unknown
}

export interface MultihopGold {
  answer: string
  caseId: string
  supportingDocumentIds: string[]
  supportingEvidence?: Array<{
    documentId: string
    metadata?: Record<string, JsonPrimitive>
    text?: string
  }>
}

export interface RetrievedCandidate {
  documentId: string
  path?: string
  rank: number
  score?: number
  textPreview?: string
}

export type RetrievalMode =
  | 'bm25'
  | 'dense'
  | 'hybrid'
  | 'hybrid-rerank'
  | 'docs-ssh-direct'
  | 'vector-agent'
  | 'docs-ssh-agent'

export interface RetrievalRun {
  bytesRead: number
  candidates: RetrievedCandidate[]
  caseId: string
  commandCount: number
  elapsedMs: number
  errors: string[]
  filesRead: number
  mode: RetrievalMode
  modelInputTokens?: number
  modelOutputTokens?: number
  question: string
  sshExecCount: number
}

export interface NormalizedDataset {
  documents: MultihopDocument[]
  gold: MultihopGold[]
  questions: MultihopQuestion[]
  skippedQuestions: number
}

export interface CaseScore {
  allEvidenceRecallAt10: boolean
  allEvidenceRecallAt5: boolean
  anyEvidenceRecallAt1: boolean
  anyEvidenceRecallAt10: boolean
  anyEvidenceRecallAt5: boolean
  averagePrecisionAt10: number
  bytesRead: number
  caseId: string
  commandCount: number
  elapsedMs: number
  errors: string[]
  evidenceRecallAt10: number
  evidenceRecallAt5: number
  expectedDocumentIds: string[]
  filesRead: number
  mode: RetrievalMode
  reciprocalRankAt10: number
  retrievedDocumentIds: string[]
  sshExecCount: number
}
