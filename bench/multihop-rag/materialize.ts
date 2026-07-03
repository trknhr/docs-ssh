import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { getCliArgs, readJsonl, writeJson } from './io.js'
import type { MultihopDocument } from './types.js'

const DEFAULT_INPUT = '.bench/multihop-rag/normalized/documents.jsonl'
const DEFAULT_OUTPUT_ROOT = '.bench/multihop-rag/tree'
const DEFAULT_LAYOUT: CorpusLayout = 'flat'
const TITLE_SLUG_MAX_LENGTH = 96

export type CorpusLayout = 'category-source-title' | 'flat'

function parseCorpusLayout(value: string | undefined): CorpusLayout {
  if (!value || value === 'flat') return 'flat'
  if (value === 'category-source-title') return 'category-source-title'
  throw new Error('--layout must be "flat" or "category-source-title"')
}

function slugify(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, TITLE_SLUG_MAX_LENGTH)
    .replace(/-+$/gu, '')
  return slug || fallback
}

export function getMaterializedDocumentRelativePath(document: MultihopDocument, layout: CorpusLayout): string {
  if (layout === 'flat') return `corpus/news/${document.documentId}.md`

  return [
    'corpus',
    'news',
    slugify(document.metadata.category, 'uncategorized'),
    slugify(document.metadata.source, 'unknown-source'),
    `${slugify(document.title, 'untitled')}__${document.documentId}.md`,
  ].join('/')
}

function metadataLine(label: string, value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  return [`${label}: ${value}`]
}

function formatDocument(document: MultihopDocument): string {
  return [
    `# ${document.title}`,
    '',
    `Document ID: ${document.documentId}`,
    ...metadataLine('Source', document.metadata.source),
    ...metadataLine('Author', document.metadata.author),
    ...metadataLine('Category', document.metadata.category),
    ...metadataLine('Published at', document.metadata.published_at),
    ...metadataLine('URL', document.metadata.url),
    '',
    '## Body',
    '',
    document.text.trim(),
    '',
  ].join('\n')
}

export async function materializeMultihopCorpus(opts: {
  clean?: boolean
  documents: MultihopDocument[]
  layout?: CorpusLayout
  outputRoot: string
}): Promise<{ bytesWritten: number; documents: number; layout: CorpusLayout; outputRoot: string }> {
  const outputRoot = resolve(opts.outputRoot)
  const layout = opts.layout ?? DEFAULT_LAYOUT
  const corpusRoot = resolve(outputRoot, 'corpus', 'news')
  if (opts.clean) {
    await rm(outputRoot, { force: true, recursive: true })
  }
  await mkdir(corpusRoot, { recursive: true })

  let bytesWritten = 0
  for (const document of opts.documents) {
    const content = formatDocument(document)
    bytesWritten += Buffer.byteLength(content, 'utf8')
    const documentPath = resolve(outputRoot, ...getMaterializedDocumentRelativePath(document, layout).split('/'))
    await mkdir(dirname(documentPath), { recursive: true })
    await writeFile(documentPath, content, 'utf8')
  }

  const layoutDescription = layout === 'category-source-title'
    ? 'Corpus documents are under `/corpus/news/<category>/<source>/<slugified-title>__<document-id>.md`.'
    : 'Corpus documents are under `/corpus/news/` and are named by stable document IDs.'
  const readme = [
    '# MultiHop-RAG Corpus',
    '',
    'This project contains only the readable corpus for the docs-ssh benchmark.',
    'Gold answers and supporting evidence labels are held by the benchmark harness outside this tree.',
    '',
    layoutDescription,
    '',
  ].join('\n')
  await writeFile(resolve(outputRoot, 'README.md'), readme, 'utf8')
  bytesWritten += Buffer.byteLength(readme, 'utf8')

  await writeJson(resolve(outputRoot, 'manifest.json'), {
    corpusPath: 'corpus/news',
    dataset: 'yixuantt/MultiHopRAG',
    documentCount: opts.documents.length,
    generatedAt: new Date().toISOString(),
    layout,
  })

  return {
    bytesWritten,
    documents: opts.documents.length,
    layout,
    outputRoot,
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    allowPositionals: false,
    args: getCliArgs(),
    options: {
      clean: { default: true, type: 'boolean' },
      input: { default: DEFAULT_INPUT, type: 'string' },
      layout: { default: DEFAULT_LAYOUT, type: 'string' },
      'output-root': { default: DEFAULT_OUTPUT_ROOT, type: 'string' },
    },
  })

  const documents = await readJsonl<MultihopDocument>(resolve(String(values.input)))
  const summary = await materializeMultihopCorpus({
    clean: Boolean(values.clean),
    documents,
    layout: parseCorpusLayout(String(values.layout)),
    outputRoot: String(values['output-root']),
  })
  console.log(JSON.stringify(summary, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exitCode = 1
  })
}
