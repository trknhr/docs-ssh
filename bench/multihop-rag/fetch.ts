import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { getCliArgs, parsePositiveIntegerFlag, readJsonArray, writeJson, writeJsonl } from './io.js'
import { normalizeMultihopDataset } from './normalize.js'

const DEFAULT_QUERY_URL = 'https://huggingface.co/datasets/yixuantt/MultiHopRAG/resolve/main/MultiHopRAG.json'
const DEFAULT_CORPUS_URL = 'https://huggingface.co/datasets/yixuantt/MultiHopRAG/resolve/main/corpus.json'
const DEFAULT_RAW_DIR = '.bench/multihop-rag/raw'
const DEFAULT_OUTPUT_DIR = '.bench/multihop-rag/normalized'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function download(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
  }
  return response.text()
}

async function ensureJsonFile(opts: {
  force: boolean
  inputFile?: string
  outputFile: string
  url: string
}): Promise<string> {
  if (opts.inputFile) {
    return readFile(opts.inputFile, 'utf8')
  }

  if (!opts.force && (await exists(opts.outputFile))) {
    return readFile(opts.outputFile, 'utf8')
  }

  const content = await download(opts.url)
  await mkdir(resolve(opts.outputFile, '..'), { recursive: true })
  await writeFile(opts.outputFile, content, 'utf8')
  return content
}

function parseJsonArrayFromContent(content: string, label: string): unknown[] {
  const parsed: unknown = JSON.parse(content)
  if (!Array.isArray(parsed)) throw new Error(`${label} must contain a JSON array`)
  return parsed
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    allowPositionals: false,
    args: getCliArgs(),
    options: {
      'corpus-file': { type: 'string' },
      'corpus-url': { default: DEFAULT_CORPUS_URL, type: 'string' },
      force: { default: false, type: 'boolean' },
      limit: { type: 'string' },
      'output-dir': { default: DEFAULT_OUTPUT_DIR, type: 'string' },
      'queries-file': { type: 'string' },
      'queries-url': { default: DEFAULT_QUERY_URL, type: 'string' },
      'raw-dir': { default: DEFAULT_RAW_DIR, type: 'string' },
    },
  })

  const rawDir = resolve(String(values['raw-dir']))
  const outputDir = resolve(String(values['output-dir']))
  const limit = parsePositiveIntegerFlag('limit', values.limit)

  const queryContent = await ensureJsonFile({
    force: Boolean(values.force),
    inputFile: values['queries-file'],
    outputFile: resolve(rawDir, 'MultiHopRAG.json'),
    url: String(values['queries-url']),
  })
  const corpusContent = await ensureJsonFile({
    force: Boolean(values.force),
    inputFile: values['corpus-file'],
    outputFile: resolve(rawDir, 'corpus.json'),
    url: String(values['corpus-url']),
  })

  const queryRows = values['queries-file']
    ? parseJsonArrayFromContent(queryContent, String(values['queries-file']))
    : await readJsonArray(resolve(rawDir, 'MultiHopRAG.json'))
  const corpusRows = values['corpus-file']
    ? parseJsonArrayFromContent(corpusContent, String(values['corpus-file']))
    : await readJsonArray(resolve(rawDir, 'corpus.json'))

  const normalized = normalizeMultihopDataset(queryRows, corpusRows, { limit })
  await writeJsonl(resolve(outputDir, 'documents.jsonl'), normalized.documents)
  await writeJsonl(resolve(outputDir, 'questions.jsonl'), normalized.questions)
  await writeJsonl(resolve(outputDir, 'gold.jsonl'), normalized.gold)

  const summary = {
    corpusRows: corpusRows.length,
    documents: normalized.documents.length,
    gold: normalized.gold.length,
    limit: limit ?? null,
    outputDir,
    queryRows: queryRows.length,
    questions: normalized.questions.length,
    skippedQuestions: normalized.skippedQuestions,
  }
  await writeJson(resolve(outputDir, 'summary.json'), summary)
  console.log(JSON.stringify(summary, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exitCode = 1
  })
}
