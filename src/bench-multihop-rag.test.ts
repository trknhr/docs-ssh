import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getMaterializedDocumentRelativePath, materializeMultihopCorpus } from '../bench/multihop-rag/materialize.js'
import { normalizeMultihopDataset } from '../bench/multihop-rag/normalize.js'
import {
  type EmbeddingProvider,
  type Reranker,
  runDenseRetrieval,
  runHybridRerankRetrieval,
  runHybridRetrieval,
} from '../bench/multihop-rag/retrieval/rag.js'
import {
  extractJsonObject,
  localizeSshCommandFiles,
  makeDocsSshPrompt,
  makeVectorPrompt,
  parseAgentAnswer,
  parseCodexEventMetrics,
} from '../bench/multihop-rag/retrieval/agent-runner.js'
import { documentIdFromPath, parseRgMatches, selectQueryTerms } from '../bench/multihop-rag/retrieval/docs-ssh-direct.js'
import { runBm25Retrieval } from '../bench/multihop-rag/run.js'
import { scoreRuns, summarizeScores } from '../bench/multihop-rag/score.js'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-ssh-multihop-bench-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

const corpus = [
  {
    author: 'Reporter A',
    body: 'The criminal trial for Sam Bankman-Fried started to determine fraud and conspiracy charges.',
    category: 'technology',
    published_at: '2023-10-01T14:00:29+00:00',
    source: 'TechCrunch',
    title: 'SBF trial starts soon',
    url: 'https://example.test/sbf-trial',
  },
  {
    author: 'Reporter B',
    body: 'Before his fall, Bankman-Fried was described as a visible face of the crypto industry.',
    category: 'technology',
    published_at: '2023-09-28T12:00:00+00:00',
    source: 'The Verge',
    title: 'The FTX trial is bigger than SBF',
    url: 'https://example.test/ftx-trial',
  },
  {
    author: 'Reporter C',
    body: 'A cloud provider announced a new file storage feature for application workloads.',
    category: 'cloud',
    published_at: '2023-09-01T00:00:00+00:00',
    source: 'Cloud News',
    title: 'Cloud storage announcement',
    url: 'https://example.test/cloud-storage',
  },
]

const queries = [
  {
    answer: 'Sam Bankman-Fried',
    evidence_list: [
      {
        fact: 'The criminal trial for Sam Bankman-Fried started Tuesday.',
        published_at: '2023-10-01T14:00:29+00:00',
        source: 'TechCrunch',
        title: 'SBF trial starts soon',
        url: 'https://example.test/sbf-trial',
      },
      {
        fact: 'Bankman-Fried was described as a crypto industry figure.',
        published_at: '2023-09-28T12:00:00+00:00',
        source: 'The Verge',
        title: 'The FTX trial is bigger than SBF',
        url: 'https://example.test/ftx-trial',
      },
    ],
    query: 'Which crypto industry figure faced a fraud and conspiracy criminal trial?',
    question_type: 'inference_query',
  },
  {
    answer: 'Insufficient information.',
    evidence_list: [],
    query: 'This query has no support and should be skipped.',
    question_type: 'null_query',
  },
]

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'fake-embedding'

  async embed(input: string[]): Promise<{ vectors: number[][] }> {
    return {
      vectors: input.map((text) => {
        const normalized = text.toLowerCase()
        return [
          normalized.includes('sam bankman-fried') || normalized.includes('sbf') ? 1 : 0,
          normalized.includes('fraud') || normalized.includes('conspiracy') ? 1 : 0,
          normalized.includes('cloud') || normalized.includes('storage') ? 1 : 0,
          normalized.includes('the verge') ? 1 : 0,
          normalized.includes('techcrunch') ? 1 : 0,
        ]
      }),
    }
  }
}

class FakeReranker implements Reranker {
  readonly model = 'fake-reranker'

  async rerank(opts: {
    candidates: Array<{ documentId: string }>
    question: string
    topK: number
  }): Promise<{ documentIds: string[]; inputTokens: number; outputTokens: number }> {
    return {
      documentIds: opts.candidates.slice(0, opts.topK).map((document) => document.documentId),
      inputTokens: opts.question.length,
      outputTokens: opts.topK,
    }
  }
}

describe('MultiHop-RAG benchmark pipeline', () => {
  it('normalizes query, corpus, and gold files without leaking labels into materialized corpus', async () => {
    const normalized = normalizeMultihopDataset(queries, corpus)
    expect(normalized.documents).toHaveLength(3)
    expect(normalized.questions).toHaveLength(1)
    expect(normalized.gold).toHaveLength(1)
    expect(normalized.skippedQuestions).toBe(1)
    expect(normalized.gold[0]?.supportingDocumentIds).toHaveLength(2)

    const tempDir = await createTempDir()
    const outputRoot = resolve(tempDir, 'tree')
    const summary = await materializeMultihopCorpus({
      clean: true,
      documents: normalized.documents,
      outputRoot,
    })
    expect(summary.documents).toBe(3)

    const readme = await readFile(resolve(outputRoot, 'README.md'), 'utf8')
    expect(readme).toContain('Gold answers and supporting evidence labels are held by the benchmark harness')
    const documentPath = resolve(outputRoot, 'corpus', 'news', `${normalized.gold[0]?.supportingDocumentIds[0]}.md`)
    const materializedDocument = await readFile(documentPath, 'utf8')
    expect(materializedDocument).toContain('## Body')
    expect(materializedDocument).not.toContain('Reference Answer')
    expect(materializedDocument).not.toContain('Supporting Documents')

    const structuredRoot = resolve(tempDir, 'structured-tree')
    await materializeMultihopCorpus({
      clean: true,
      documents: normalized.documents,
      layout: 'category-source-title',
      outputRoot: structuredRoot,
    })
    const structuredRelativePath = getMaterializedDocumentRelativePath(normalized.documents[0]!, 'category-source-title')
    expect(structuredRelativePath).toBe(`corpus/news/technology/techcrunch/sbf-trial-starts-soon__${normalized.documents[0]!.documentId}.md`)
    const structuredDocument = await readFile(resolve(structuredRoot, ...structuredRelativePath.split('/')), 'utf8')
    expect(structuredDocument).toContain(`Document ID: ${normalized.documents[0]!.documentId}`)
  })

  it('runs BM25 and scores multi-document evidence retrieval', () => {
    const normalized = normalizeMultihopDataset(queries, corpus)
    const runs = runBm25Retrieval({
      documents: normalized.documents,
      questions: normalized.questions,
      topK: 3,
    })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.candidates.map((candidate) => candidate.documentId)).toEqual(
      expect.arrayContaining(normalized.gold[0]?.supportingDocumentIds ?? []),
    )

    const scores = scoreRuns(runs, normalized.gold)
    expect(scores[0]?.anyEvidenceRecallAt1).toBe(true)
    expect(scores[0]?.allEvidenceRecallAt5).toBe(true)
    expect(scores[0]?.evidenceRecallAt5).toBe(1)

    const summary = summarizeScores(scores)
    expect(summary).toMatchObject({
      allEvidenceRecallAt5: 1,
      anyEvidenceRecallAt1: 1,
      cases: 1,
      errorCases: 0,
      evidenceRecallAt5: 1,
      mode: 'bm25',
    })
  })

  it('runs dense, hybrid, and hybrid-rerank retrieval with injectable providers', async () => {
    const normalized = normalizeMultihopDataset(queries, corpus)
    const tempDir = await createTempDir()
    const provider = new FakeEmbeddingProvider()

    const denseRuns = await runDenseRetrieval({
      batchSize: 2,
      cachePath: resolve(tempDir, 'dense-cache.json'),
      documents: normalized.documents,
      provider,
      questions: normalized.questions,
      topK: 3,
    })
    expect(denseRuns[0]?.mode).toBe('dense')
    expect(scoreRuns(denseRuns, normalized.gold)[0]?.anyEvidenceRecallAt5).toBe(true)

    const hybridRuns = await runHybridRetrieval({
      batchSize: 2,
      cachePath: resolve(tempDir, 'hybrid-cache.json'),
      candidateK: 3,
      documents: normalized.documents,
      provider,
      questions: normalized.questions,
      topK: 3,
    })
    expect(hybridRuns[0]?.mode).toBe('hybrid')
    expect(scoreRuns(hybridRuns, normalized.gold)[0]?.anyEvidenceRecallAt5).toBe(true)

    const rerankRuns = await runHybridRerankRetrieval({
      batchSize: 2,
      cachePath: resolve(tempDir, 'rerank-cache.json'),
      candidateK: 3,
      documents: normalized.documents,
      provider,
      questions: normalized.questions,
      reranker: new FakeReranker(),
      rerankTopN: 3,
      topK: 3,
    })
    expect(rerankRuns[0]?.mode).toBe('hybrid-rerank')
    expect(rerankRuns[0]?.commandCount).toBe(1)
    expect(rerankRuns[0]?.modelInputTokens).toBeGreaterThan(0)
  })

  it('selects docs-ssh direct query terms and parses rg output', () => {
    expect(selectQueryTerms('Who is the crypto industry figure facing fraud and conspiracy charges?')).toEqual([
      'conspiracy',
      'industry',
      'charges',
      'crypto',
      'facing',
      'figure',
      'fraud',
    ])

    expect(parseRgMatches([
      '/projects/multihop-rag/tasks/corpus/news/doc_a.md:12:Sam Bankman-Fried trial starts.',
      '/projects/multihop-rag/tasks/corpus/news/doc_b.md:3:FTX fraud charges.',
      'not an rg line',
      '',
    ].join('\n'))).toEqual([
      {
        lineNumber: 12,
        path: '/projects/multihop-rag/tasks/corpus/news/doc_a.md',
        text: 'Sam Bankman-Fried trial starts.',
      },
      {
        lineNumber: 3,
        path: '/projects/multihop-rag/tasks/corpus/news/doc_b.md',
        text: 'FTX fraud charges.',
      },
    ])

    expect(documentIdFromPath('/projects/multihop-rag/tasks/corpus/news/doc_a.md')).toBe('doc_a')
    expect(documentIdFromPath('/projects/multihop-rag/tasks/corpus/news/source/title-slug__doc_b.md')).toBe('doc_b')
  })

  it('parses agent JSON answers and Codex JSONL metrics', () => {
    expect(extractJsonObject('```json\n{"candidates":[]}\n```')).toEqual({ candidates: [] })
    expect(parseAgentAnswer('{"candidates":[{"documentId":"doc_a","reason":"matched","confidence":0.7}]}')).toEqual({
      candidates: [
        {
          confidence: 0.7,
          documentId: 'doc_a',
          reason: 'matched',
        },
      ],
    })
    expect(parseCodexEventMetrics([
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"type":"command_execution"}}',
      '{"type":"item.started","item":{"type":"mcp_tool_call"}}',
    ].join('\n'))).toEqual({
      toolCallCount: 2,
      turnCount: 1,
    })
  })

  it('builds agentic retrieval prompts', () => {
    const vectorPrompt = makeVectorPrompt({
      documentsPath: '/tmp/documents.jsonl',
      maxToolCalls: 8,
      question: 'Which articles identify the FTX founder?',
      searchTopK: 10,
      toolPath: '/tmp/vector-agent-tool.ts',
      topK: 5,
    })
    expect(vectorPrompt).toContain('Use only the retrieval tool commands')
    expect(vectorPrompt).toContain('read-many')
    expect(vectorPrompt).toContain('--document-ids')

    const docsSshPrompt = makeDocsSshPrompt({
      corpusLayout: 'category-source-title',
      maxToolCalls: 8,
      question: 'Which articles identify the FTX founder?',
      remoteCommand: './remote',
      remoteRoot: '/projects/multihop-rag/tasks/multihop-rag-corpus',
      topK: 5,
    })
    expect(docsSshPrompt).toContain('./remote')
    expect(docsSshPrompt).toContain('/projects/multihop-rag/tasks/multihop-rag-corpus/corpus/news')
    expect(docsSshPrompt).toContain('<category>/<source>/<slugified-title>__<documentId>.md')
    expect(docsSshPrompt).toContain('batch')
  })

  it('localizes SSH command files into the nested Codex workspace', async () => {
    const tempDir = await createTempDir()
    const keyPath = resolve(tempDir, 'id_ed25519')
    const knownHostsPath = resolve(tempDir, 'known_hosts')
    const workspace = resolve(tempDir, 'workspace')
    await writeFile(keyPath, 'private-key', 'utf8')
    await writeFile(knownHostsPath, 'host-key', 'utf8')

    const localized = await localizeSshCommandFiles(
      workspace,
      `ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${knownHostsPath} -i ${keyPath} -p 2222 sess@example.test`,
    )

    expect(localized).not.toContain(keyPath)
    expect(localized).not.toContain(knownHostsPath)
    expect(localized).toContain(resolve(workspace, '.ssh', 'identity'))
    expect(localized).toContain(resolve(workspace, '.ssh', 'known_hosts'))
    await expect(readFile(resolve(workspace, '.ssh', 'identity'), 'utf8')).resolves.toBe('private-key')
    await expect(readFile(resolve(workspace, '.ssh', 'known_hosts'), 'utf8')).resolves.toBe('host-key')
  })
})
