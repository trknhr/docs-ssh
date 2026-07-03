import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { getCliArgs, parsePositiveIntegerFlag, readJsonl, writeJsonl } from './io.js'
import { Bm25Index } from './retrieval/bm25.js'
import { runDocsSshDirectRetrieval } from './retrieval/docs-ssh-direct.js'
import {
  defaultEmbeddingCachePath,
  OpenAIEmbeddingProvider,
  OpenAIReranker,
  runDenseRetrieval,
  runHybridRerankRetrieval,
  runHybridRetrieval,
} from './retrieval/rag.js'
import type { MultihopDocument, MultihopQuestion, RetrievalMode, RetrievalRun } from './types.js'

const DEFAULT_DOCUMENTS = '.bench/multihop-rag/normalized/documents.jsonl'
const DEFAULT_QUESTIONS = '.bench/multihop-rag/normalized/questions.jsonl'
const DEFAULT_RUNS_DIR = '.bench/multihop-rag/runs'
const DEFAULT_CACHE_DIR = '.bench/multihop-rag/cache'
const DEFAULT_EMBEDDING_MODEL = process.env.DOCS_SSH_BENCH_EMBEDDING_MODEL ?? 'text-embedding-3-small'
const DEFAULT_RERANK_MODEL = process.env.DOCS_SSH_BENCH_RERANK_MODEL ?? 'gpt-5.4-mini'
const DEFAULT_OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'

function textPreview(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').slice(0, 240)
}

function parseMode(value: string | undefined): RetrievalMode {
  if (value === undefined || value === 'bm25') return 'bm25'
  if (value === 'dense') return 'dense'
  if (value === 'hybrid') return 'hybrid'
  if (value === 'hybrid-rerank') return 'hybrid-rerank'
  if (value === 'docs-ssh-direct') return 'docs-ssh-direct'
  throw new Error(`Unsupported --mode for this phase: ${value}`)
}

export function runBm25Retrieval(opts: {
  documents: MultihopDocument[]
  limit?: number
  questions: MultihopQuestion[]
  topK: number
}): RetrievalRun[] {
  const index = new Bm25Index(opts.documents)
  const selectedQuestions = opts.limit === undefined ? opts.questions : opts.questions.slice(0, opts.limit)

  return selectedQuestions.map((question) => {
    const startedAt = performance.now()
    const results = index.search(question.question, opts.topK)
    const elapsedMs = performance.now() - startedAt
    const bytesRead = results.reduce((sum, result) => sum + Buffer.byteLength(result.document.text, 'utf8'), 0)

    return {
      bytesRead,
      candidates: results.map((result) => ({
        documentId: result.document.documentId,
        rank: result.rank,
        score: result.score,
        textPreview: textPreview(result.document.text),
      })),
      caseId: question.caseId,
      commandCount: 0,
      elapsedMs,
      errors: [],
      filesRead: results.length,
      mode: 'bm25',
      question: question.question,
      sshExecCount: 0,
    }
  })
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    allowPositionals: false,
    args: getCliArgs(),
    options: {
      documents: { default: DEFAULT_DOCUMENTS, type: 'string' },
      'cache-dir': { default: DEFAULT_CACHE_DIR, type: 'string' },
      'embedding-batch-size': { default: '64', type: 'string' },
      'embedding-dimensions': { type: 'string' },
      'embedding-max-chars': { default: '12000', type: 'string' },
      'embedding-model': { default: DEFAULT_EMBEDDING_MODEL, type: 'string' },
      'hybrid-candidate-k': { default: '50', type: 'string' },
      limit: { type: 'string' },
      mode: { default: 'bm25', type: 'string' },
      'openai-base-url': { default: DEFAULT_OPENAI_BASE_URL, type: 'string' },
      output: { type: 'string' },
      questions: { default: DEFAULT_QUESTIONS, type: 'string' },
      'remote-root': { type: 'string' },
      'rerank-model': { default: DEFAULT_RERANK_MODEL, type: 'string' },
      'rerank-top-n': { default: '20', type: 'string' },
      'rrf-k': { default: '60', type: 'string' },
      'runs-dir': { default: DEFAULT_RUNS_DIR, type: 'string' },
      'ssh-command': { type: 'string' },
      'top-k': { default: '10', type: 'string' },
    },
  })

  const mode = parseMode(values.mode)
  const topK = parsePositiveIntegerFlag('top-k', values['top-k']) ?? 10
  const limit = parsePositiveIntegerFlag('limit', values.limit)
  const embeddingBatchSize = parsePositiveIntegerFlag('embedding-batch-size', values['embedding-batch-size']) ?? 64
  const embeddingDimensions = parsePositiveIntegerFlag('embedding-dimensions', values['embedding-dimensions'])
  const embeddingMaxChars = parsePositiveIntegerFlag('embedding-max-chars', values['embedding-max-chars']) ?? 12000
  const hybridCandidateK = parsePositiveIntegerFlag('hybrid-candidate-k', values['hybrid-candidate-k']) ?? 50
  const rerankTopN = parsePositiveIntegerFlag('rerank-top-n', values['rerank-top-n']) ?? 20
  const rrfK = parsePositiveIntegerFlag('rrf-k', values['rrf-k']) ?? 60
  const documents = await readJsonl<MultihopDocument>(resolve(String(values.documents)))
  const questions = await readJsonl<MultihopQuestion>(resolve(String(values.questions)))
  let runs: RetrievalRun[]
  if (mode === 'bm25') {
    runs = runBm25Retrieval({ documents, limit, questions, topK })
  } else if (mode === 'dense' || mode === 'hybrid' || mode === 'hybrid-rerank') {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error(`${mode} requires OPENAI_API_KEY for embeddings`)
    }
    const embeddingModel = String(values['embedding-model'])
    const embeddingProvider = new OpenAIEmbeddingProvider({
      apiKey,
      baseUrl: String(values['openai-base-url']),
      dimensions: embeddingDimensions,
      model: embeddingModel,
    })
    const cachePath = defaultEmbeddingCachePath(String(values['cache-dir']), embeddingModel)
    if (mode === 'dense') {
      runs = await runDenseRetrieval({
        batchSize: embeddingBatchSize,
        cachePath,
        documents,
        embeddingMaxChars,
        limit,
        provider: embeddingProvider,
        questions,
        topK,
      })
    } else if (mode === 'hybrid') {
      runs = await runHybridRetrieval({
        batchSize: embeddingBatchSize,
        cachePath,
        candidateK: hybridCandidateK,
        documents,
        embeddingMaxChars,
        limit,
        provider: embeddingProvider,
        questions,
        rrfK,
        topK,
      })
    } else {
      runs = await runHybridRerankRetrieval({
        batchSize: embeddingBatchSize,
        cachePath,
        candidateK: hybridCandidateK,
        documents,
        embeddingMaxChars,
        limit,
        provider: embeddingProvider,
        questions,
        reranker: new OpenAIReranker({
          apiKey,
          baseUrl: String(values['openai-base-url']),
          model: String(values['rerank-model']),
        }),
        rerankTopN,
        rrfK,
        topK,
      })
    }
  } else if (mode === 'docs-ssh-direct') {
    const sshCommand = values['ssh-command'] ?? process.env.DOCS_SSH_BENCH_SSH_COMMAND
    if (!sshCommand) {
      throw new Error('docs-ssh-direct requires --ssh-command or DOCS_SSH_BENCH_SSH_COMMAND')
    }
    runs = runDocsSshDirectRetrieval({
      limit,
      questions,
      remoteRoot: values['remote-root'] ?? process.env.DOCS_SSH_BENCH_REMOTE_ROOT,
      sshCommand: String(sshCommand),
      topK,
    })
  } else {
    runs = []
  }
  const output = resolve(values.output ? String(values.output) : resolve(String(values['runs-dir']), `${mode}.jsonl`))
  await writeJsonl(output, runs)

  console.log(JSON.stringify({
    cases: runs.length,
    mode,
    output,
    ...(mode === 'dense' || mode === 'hybrid' || mode === 'hybrid-rerank'
      ? {
        embeddingModel: values['embedding-model'],
        ...(mode === 'hybrid-rerank' ? { rerankModel: values['rerank-model'] } : {}),
      }
      : {}),
    topK,
  }, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exitCode = 1
  })
}
