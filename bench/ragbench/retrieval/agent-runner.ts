import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, posix, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { RagbenchCase, RagbenchDocument, RetrievedCandidate, RetrievalRun } from '../types.js'

const DEFAULT_CASES = '.bench/ragbench/cases.jsonl'
const DEFAULT_LOCAL_ROOT = '.bench/ragbench/tree/cases'
const DEFAULT_REMOTE_ROOT = '/projects/ragbench/tasks/ragbench-cases'
const DEFAULT_TRACE_DIR = '.bench/ragbench/agent'
const DEFAULT_TOP_K = '5'
const DEFAULT_LIMIT = '10'
const DEFAULT_CODEX_HOME = process.env.DOCS_SSH_BENCH_CODEX_HOME
const DEFAULT_MAX_TOOL_CALLS = process.env.DOCS_SSH_BENCH_CODEX_MAX_TOOL_CALLS ?? '8'
const DEFAULT_MAX_TURNS = process.env.DOCS_SSH_BENCH_CODEX_MAX_TURNS ?? '1'
const DEFAULT_MODEL = process.env.DOCS_SSH_BENCH_CODEX_MODEL ?? 'gpt-5.4-mini'
const DEFAULT_REASONING_EFFORT = process.env.DOCS_SSH_BENCH_CODEX_REASONING_EFFORT ?? 'low'
const TEXT_PREVIEW_LENGTH = 240

type AgentMode = 'docs-ssh-agent' | 'vector-agent'

interface AgentCandidate {
  confidence: number | null
  documentId: string
  reason: string
}

interface AgentAnswer {
  candidates: AgentCandidate[]
}

interface CodexResult {
  elapsedMs: number
  errors: string[]
  finalMessage: string
  metrics: CodexEventMetrics
  stderr: string
  stdout: string
}

interface CodexEventMetrics {
  toolCallCount: number
  turnCount: number
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function shellDoubleQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`
}

function promptPath(value: string): string {
  const relativePath = relative(process.cwd(), value)
  if (relativePath && relativePath !== '..' && !relativePath.startsWith(`..${posix.sep}`) && !relativePath.startsWith('/')) {
    return relativePath
  }
  return value
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function expectString(record: Record<string, unknown>, field: string, lineNumber: number): string {
  const value = record[field]
  if (typeof value !== 'string') {
    throw new Error(`Invalid case JSONL line ${lineNumber}: ${field} must be a string`)
  }
  return value
}

function parseDocument(value: unknown, lineNumber: number, index: number): RagbenchDocument {
  const record = asRecord(value)
  if (!record) {
    throw new Error(`Invalid case JSONL line ${lineNumber}: documents[${index}] must be an object`)
  }

  const title = record.title
  if (title !== undefined && typeof title !== 'string') {
    throw new Error(`Invalid case JSONL line ${lineNumber}: documents[${index}].title must be a string`)
  }

  return {
    id: expectString(record, 'id', lineNumber),
    text: expectString(record, 'text', lineNumber),
    title,
  }
}

function parseCaseLine(line: string, lineNumber: number): RagbenchCase {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid case JSONL line ${lineNumber}: ${message}`)
  }

  const record = asRecord(parsed)
  if (!record) {
    throw new Error(`Invalid case JSONL line ${lineNumber}: expected an object`)
  }

  const documents = record.documents
  if (!Array.isArray(documents)) {
    throw new Error(`Invalid case JSONL line ${lineNumber}: documents must be an array`)
  }

  return {
    caseId: expectString(record, 'caseId', lineNumber),
    config: expectString(record, 'config', lineNumber),
    split: expectString(record, 'split', lineNumber),
    question: expectString(record, 'question', lineNumber),
    referenceAnswer: typeof record.referenceAnswer === 'string' ? record.referenceAnswer : '',
    documents: documents.map((document, index) => parseDocument(document, lineNumber, index)),
    supportingDocumentIds: Array.isArray(record.supportingDocumentIds)
      ? record.supportingDocumentIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    raw: record.raw,
  }
}

async function readCases(path: string): Promise<RagbenchCase[]> {
  const content = await readFile(path, 'utf8')
  return content
    .split(/\r?\n/u)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, lineNumber }) => parseCaseLine(line, lineNumber))
}

function parsePositiveInteger(name: string, value: string | undefined): number {
  if (!value || !/^\d+$/u.test(value)) {
    throw new Error(`--${name} must be a positive integer`)
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return parsed
}

function parseLimit(value: string | undefined): number | null {
  if (!value || value === 'all') return null
  return parsePositiveInteger('limit', value)
}

function parseMode(value: string | undefined): AgentMode {
  if (value === 'docs-ssh-agent' || value === 'vector-agent') return value
  throw new Error('--mode must be "docs-ssh-agent" or "vector-agent"')
}

function assertSafePathSegment(kind: string, value: string, caseId: string): void {
  if (value.length === 0 || value === '.' || value === '..' || /[\\/]/u.test(value) || value.includes('\0')) {
    throw new Error(
      `Invalid case ${JSON.stringify(caseId)}: ${kind} must be a safe path segment without slash, backslash, dot-only, or NUL characters: ${JSON.stringify(value)}`,
    )
  }
}

function validateCase(entry: RagbenchCase): void {
  assertSafePathSegment('caseId', entry.caseId, entry.caseId)
  if (entry.documents.length === 0) {
    throw new Error(`Invalid case ${JSON.stringify(entry.caseId)}: documents must contain at least one document`)
  }

  for (const document of entry.documents) {
    assertSafePathSegment('document.id', document.id, entry.caseId)
  }
}

function validateRemoteRoot(value: string): void {
  if (value.length === 0 || value === '/' || value === '.' || value === '..' || !value.startsWith('/')) {
    throw new Error('--remote-root must be an absolute /projects/<project>/tasks/<generated-dir> path')
  }

  const parts = value.slice(1).split('/')
  for (const [index, part] of parts.entries()) {
    if (part.length === 0 || part === '.' || part === '..' || /[\\/]/u.test(part) || part.includes('\0')) {
      throw new Error(
        `--remote-root segment ${index} must be a safe path segment without slash, backslash, dot-only, or NUL characters: ${JSON.stringify(part)}`,
      )
    }
  }

  if (parts.length < 4 || parts[0] !== 'projects' || parts[2] !== 'tasks') {
    throw new Error('--remote-root must be under /projects/<project>/tasks/<generated-dir>')
  }
}

function documentPath(mode: AgentMode, entry: RagbenchCase, document: RagbenchDocument, localRoot: string, remoteRoot: string): string {
  const name = `doc-${document.id}.md`
  if (mode === 'docs-ssh-agent') {
    return posix.join(remoteRoot, entry.caseId, 'documents', name)
  }
  return resolve(localRoot, entry.caseId, 'documents', name)
}

function outputPathForMode(mode: AgentMode): string {
  return `.bench/ragbench/runs/${mode}.jsonl`
}

function schemaForTopK(topK: number): unknown {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['candidates'],
    properties: {
      candidates: {
        type: 'array',
        maxItems: topK,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['documentId', 'reason'],
          properties: {
            documentId: {
              type: 'string',
              description: 'RAGBench document id, without doc- prefix or .md suffix.',
            },
            reason: {
              type: 'string',
            },
          },
        },
      },
    },
  }
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u)
  const candidate = fenced ? fenced[1].trim() : trimmed

  try {
    return JSON.parse(candidate)
  } catch {
    // Fall through and scan for the first complete JSON object.
  }

  const start = candidate.indexOf('{')
  if (start === -1) throw new Error('Codex final message did not contain a JSON object')

  let depth = 0
  let escaped = false
  let inString = false
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return JSON.parse(candidate.slice(start, index + 1))
      }
    }
  }

  throw new Error('Codex final message did not contain a complete JSON object')
}

export function parseAgentAnswer(text: string): AgentAnswer {
  const parsed = extractJsonObject(text)
  const record = asRecord(parsed)
  if (!record) throw new Error('Codex final JSON must be an object')
  if (!Array.isArray(record.candidates)) throw new Error('Codex final JSON candidates must be an array')

  const candidates = record.candidates.map((candidate, index): AgentCandidate => {
    const candidateRecord = asRecord(candidate)
    if (!candidateRecord) throw new Error(`Codex candidate ${index} must be an object`)
    if (typeof candidateRecord.documentId !== 'string') {
      throw new Error(`Codex candidate ${index}.documentId must be a string`)
    }
    if (candidateRecord.reason !== undefined && typeof candidateRecord.reason !== 'string') {
      throw new Error(`Codex candidate ${index}.reason must be a string`)
    }
    if (
      candidateRecord.confidence !== undefined &&
      candidateRecord.confidence !== null &&
      (typeof candidateRecord.confidence !== 'number' || !Number.isFinite(candidateRecord.confidence))
    ) {
      throw new Error(`Codex candidate ${index}.confidence must be a finite number or null`)
    }
    return {
      confidence: typeof candidateRecord.confidence === 'number' ? candidateRecord.confidence : null,
      documentId: candidateRecord.documentId,
      reason: typeof candidateRecord.reason === 'string' ? candidateRecord.reason : '',
    }
  })

  return { candidates }
}

export function parseCodexEventMetrics(output: string): CodexEventMetrics {
  let toolCallCount = 0
  let turnCount = 0

  for (const [index, line] of output.split(/\r?\n/u).entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }

    const record = asRecord(parsed)
    if (!record) continue
    if (record.type === 'turn.started') {
      turnCount += 1
      continue
    }

    if (record.type !== 'item.started') continue
    const item = asRecord(record.item)
    if (!item) continue
    if (item.type === 'command_execution' || item.type === 'mcp_tool_call' || item.type === 'web_search') {
      toolCallCount += 1
      continue
    }

    if (typeof item.type === 'string' && item.type.endsWith('_tool_call')) {
      toolCallCount += 1
      continue
    }

    if (typeof record.type !== 'string') {
      throw new Error(`Invalid Codex JSONL event line ${index + 1}: type must be a string`)
    }
  }

  return { toolCallCount, turnCount }
}

export function makeVectorPrompt(opts: {
  caseId: string
  casesPath: string
  maxToolCalls: number
  question: string
  searchTopK: number
  topK: number
  toolPath: string
}): string {
  const casesPath = promptPath(opts.casesPath)
  const toolPath = promptPath(opts.toolPath)
  const searchCommand = [
    'pnpm exec tsx',
    shellQuote(toolPath),
    'search',
    '--cases',
    shellQuote(casesPath),
    '--case-id',
    shellQuote(opts.caseId),
    '--query',
    shellQuote('<query>'),
    '--top-k',
    String(opts.searchTopK),
  ].join(' ')
  const readCommand = [
    'pnpm exec tsx',
    shellQuote(toolPath),
    'read',
    '--cases',
    shellQuote(casesPath),
    '--case-id',
    shellQuote(opts.caseId),
    '--document-id',
    shellQuote('<documentId>'),
  ].join(' ')
  const readManyCommand = [
    'pnpm exec tsx',
    shellQuote(toolPath),
    'read-many',
    '--cases',
    shellQuote(casesPath),
    '--case-id',
    shellQuote(opts.caseId),
    '--document-ids',
    shellQuote('<commaSeparatedDocumentIds>'),
  ].join(' ')

  return [
    'You are running a RAGBench retrieval evaluation.',
    '',
    `Question: ${opts.question}`,
    '',
    'Use the vector retrieval tool below. Do not inspect the cases file directly and do not look for support labels.',
    'Do not edit files. Only run commands needed to search and read candidate documents.',
    'Prefer one search, then read multiple top candidates with read-many in one command before deciding.',
    'Run extra searches or single-document reads only if the first search and read-many output are insufficient.',
    'If read-many returns all candidate document bodies, decide from that output; do not re-search the same query terms.',
    `Budget: use at most ${opts.maxToolCalls} shell commands in this single turn.`,
    '',
    `Search command template: ${searchCommand}`,
    `Read command template: ${readCommand}`,
    `Read many command template: ${readManyCommand}`,
    '',
    `Return the best ${opts.topK} document ids in rank order. Return JSON only.`,
  ].join('\n')
}

export function makeDocsSshPrompt(opts: {
  caseId: string
  documents: RagbenchDocument[]
  maxToolCalls: number
  question: string
  remoteRoot: string
  topK: number
}): string {
  const documentsRoot = posix.join(opts.remoteRoot, opts.caseId, 'documents')
  const batchCommands = [
    `find ${documentsRoot} -maxdepth 1 -type f -name 'doc-*.md' | sort`,
    ...opts.documents.map((document) => `cat ${posix.join(documentsRoot, `doc-${document.id}.md`)}`),
  ]
  const batchCommand = [
    'printf',
    "'%s\\n'",
    ...batchCommands.map((command) => shellDoubleQuote(command)),
    '|',
    'sh',
    '-lc',
    shellDoubleQuote('$RAGBENCH_REMOTE_COMMAND batch'),
  ].join(' ')

  return [
    'You are running a RAGBench retrieval evaluation.',
    '',
    `Question: ${opts.question}`,
    '',
    'Use the provided remote command prefix to inspect only the remote documents directory for this case.',
    'Do not read question.md, cases JSONL, or any support-label files.',
    'Do not edit files. Only run read-only commands needed to search and read candidate documents.',
    'You may use shell tools such as find, rg, sed, head, and cat remotely.',
    'Prefer the remote batch helper so multiple remote commands run through one remote exec. Run extra remote commands only if the batch output is insufficient.',
    'Copy the recommended one-call batch command as-is first; do not rewrite it with loops, heredocs, bash -s, or local shell variables.',
    'If the recommended command returns the document list and all document bodies, decide from that output; do not re-list or re-read the same files.',
    `Budget: use at most ${opts.maxToolCalls} shell commands in this single turn.`,
    '',
    'The remote command prefix is available in the RAGBENCH_REMOTE_COMMAND environment variable.',
    `Documents directory: ${documentsRoot}`,
    'batch output is JSONL with command, exitCode, stdout, and stderr fields.',
    '',
    `Recommended one-call batch command: ${batchCommand}`,
    '',
    `Return the best ${opts.topK} document ids in rank order. Document ids omit the doc- prefix and .md suffix. Return JSON only.`,
  ].join('\n')
}

function makePrompt(opts: {
  caseId: string
  casesPath: string
  documents: RagbenchDocument[]
  maxToolCalls: number
  mode: AgentMode
  question: string
  remoteRoot: string
  searchTopK: number
  sshCommand: string
  topK: number
  toolPath: string
}): string {
  if (opts.mode === 'vector-agent') {
    return makeVectorPrompt(opts)
  }
  return makeDocsSshPrompt(opts)
}

async function writeVectorAgentCases(path: string, cases: RagbenchCase[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const content = cases
    .map((entry) => JSON.stringify({
      caseId: entry.caseId,
      config: entry.config,
      documents: entry.documents,
      question: entry.question,
      referenceAnswer: '',
      split: entry.split,
    }))
    .join('\n')
  await writeFile(path, `${content}\n`, 'utf8')
}

async function runCodex(opts: {
  caseId: string
  codexBin: string
  codexHome: string | undefined
  env?: Record<string, string>
  maxToolCalls: number
  maxTurns: number
  model: string
  reasoningEffort: string
  prompt: string
  sandbox: string
  schemaPath: string
  timeoutMs: number
  traceDir: string
  workspace: string
}): Promise<CodexResult> {
  const caseTraceDir = resolve(opts.traceDir, opts.caseId)
  await mkdir(caseTraceDir, { recursive: true })
  const promptPath = resolve(caseTraceDir, 'prompt.md')
  const finalPath = resolve(caseTraceDir, 'final.json')
  await writeFile(promptPath, opts.prompt, 'utf8')

  const started = Date.now()
  const result = spawnSync(
    opts.codexBin,
    [
      'exec',
      '--config',
      'approval_policy="never"',
      '--config',
      `model_reasoning_effort=${JSON.stringify(opts.reasoningEffort)}`,
      '--model',
      opts.model,
      '--cd',
      opts.workspace,
      '--sandbox',
      opts.sandbox,
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--skip-git-repo-check',
      '--json',
      '--output-schema',
      opts.schemaPath,
      '--output-last-message',
      finalPath,
      '-',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...opts.env,
        ...(opts.codexHome ? { CODEX_HOME: opts.codexHome, HOME: opts.codexHome } : {}),
      },
      input: opts.prompt,
      maxBuffer: 1024 * 1024 * 20,
      timeout: opts.timeoutMs,
    },
  )
  await writeFile(resolve(caseTraceDir, 'stdout.log'), result.stdout ?? '', 'utf8')
  await writeFile(resolve(caseTraceDir, 'stderr.log'), result.stderr ?? '', 'utf8')

  const errors: string[] = []
  if (result.error) errors.push(result.error.message)
  if (result.status !== 0) {
    errors.push(`codex exec exited with ${result.status ?? 'unknown'}`)
  }

  let finalMessage = ''
  try {
    finalMessage = await readFile(finalPath, 'utf8')
  } catch {
    finalMessage = ''
  }

  const metrics = parseCodexEventMetrics(result.stdout ?? '')
  if (metrics.turnCount > opts.maxTurns) {
    errors.push(`codex exec used ${metrics.turnCount} turns, exceeding --max-turns ${opts.maxTurns}`)
  }
  if (metrics.toolCallCount > opts.maxToolCalls) {
    errors.push(`codex exec used ${metrics.toolCallCount} tool calls, exceeding --max-tool-calls ${opts.maxToolCalls}`)
  }

  return {
    elapsedMs: Date.now() - started,
    errors,
    finalMessage,
    metrics,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

function candidatesFromAnswer(opts: {
  answer: AgentAnswer
  entry: RagbenchCase
  localRoot: string
  mode: AgentMode
  remoteRoot: string
  topK: number
}): { candidates: RetrievedCandidate[]; errors: string[] } {
  const errors: string[] = []
  const documentsById = new Map(opts.entry.documents.map((document) => [document.id, document]))
  const seen = new Set<string>()
  const candidates: RetrievedCandidate[] = []

  for (const [index, candidate] of opts.answer.candidates.entries()) {
    if (candidates.length >= opts.topK) break
    if (seen.has(candidate.documentId)) continue
    seen.add(candidate.documentId)

    const document = documentsById.get(candidate.documentId)
    if (!document) {
      errors.push(`Codex returned unknown documentId: ${candidate.documentId}`)
      continue
    }

    candidates.push({
      documentId: document.id,
      path: documentPath(opts.mode, opts.entry, document, opts.localRoot, opts.remoteRoot),
      score: candidate.confidence ?? opts.topK - index,
      textPreview: document.text.slice(0, TEXT_PREVIEW_LENGTH),
    })
  }

  return { candidates, errors }
}

async function runCase(opts: {
  caseInputPath: string
  codexBin: string
  codexHome: string | undefined
  entry: RagbenchCase
  localRoot: string
  maxToolCalls: number
  maxTurns: number
  mode: AgentMode
  model: string
  reasoningEffort: string
  remoteRoot: string
  sandbox: string
  schemaPath: string
  searchTopK: number
  sshCommand: string
  timeoutMs: number
  topK: number
  toolPath: string
  traceDir: string
  workspace: string
}): Promise<RetrievalRun> {
  const prompt = makePrompt({
    caseId: opts.entry.caseId,
    casesPath: opts.caseInputPath,
    documents: opts.entry.documents,
    maxToolCalls: opts.maxToolCalls,
    mode: opts.mode,
    question: opts.entry.question,
    remoteRoot: opts.remoteRoot,
    searchTopK: opts.searchTopK,
    sshCommand: opts.sshCommand,
    topK: opts.topK,
    toolPath: opts.toolPath,
  })
  const codex = await runCodex({
    caseId: opts.entry.caseId,
    codexBin: opts.codexBin,
    codexHome: opts.codexHome,
    env: opts.mode === 'docs-ssh-agent'
      ? {
        RAGBENCH_REMOTE_COMMAND: opts.sshCommand,
        RAGBENCH_SSH_COMMAND: opts.sshCommand,
      }
      : undefined,
    maxToolCalls: opts.maxToolCalls,
    maxTurns: opts.maxTurns,
    model: opts.model,
    prompt,
    reasoningEffort: opts.reasoningEffort,
    sandbox: opts.sandbox,
    schemaPath: opts.schemaPath,
    timeoutMs: opts.timeoutMs,
    traceDir: opts.traceDir,
    workspace: opts.workspace,
  })
  const errors = [...codex.errors]
  let candidates: RetrievedCandidate[] = []

  if (codex.finalMessage.trim()) {
    try {
      const answer = parseAgentAnswer(codex.finalMessage)
      const parsed = candidatesFromAnswer({
        answer,
        entry: opts.entry,
        localRoot: opts.localRoot,
        mode: opts.mode,
        remoteRoot: opts.remoteRoot,
        topK: opts.topK,
      })
      candidates = parsed.candidates
      errors.push(...parsed.errors)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  } else {
    errors.push('codex exec did not write a final message')
  }

  return {
    caseId: opts.entry.caseId,
    mode: opts.mode,
    question: opts.entry.question,
    candidates,
    elapsedMs: codex.elapsedMs,
    commandCount: codex.metrics.toolCallCount,
    filesRead: candidates.length,
    bytesRead: candidates.reduce((sum, candidate) => sum + Buffer.byteLength(candidate.textPreview, 'utf8'), 0),
    errors,
  }
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const { values } = parseArgs({
    args,
    options: {
      cases: { type: 'string', default: DEFAULT_CASES },
      'codex-bin': { type: 'string', default: 'codex' },
      'codex-home': { type: 'string', default: DEFAULT_CODEX_HOME },
      'local-root': { type: 'string', default: DEFAULT_LOCAL_ROOT },
      limit: { type: 'string', default: DEFAULT_LIMIT },
      'max-tool-calls': { type: 'string', default: DEFAULT_MAX_TOOL_CALLS },
      'max-turns': { type: 'string', default: DEFAULT_MAX_TURNS },
      mode: { type: 'string' },
      model: { type: 'string', default: DEFAULT_MODEL },
      output: { type: 'string' },
      'remote-root': { type: 'string', default: DEFAULT_REMOTE_ROOT },
      'reasoning-effort': { type: 'string', default: DEFAULT_REASONING_EFFORT },
      sandbox: { type: 'string', default: 'danger-full-access' },
      'search-top-k': { type: 'string', default: '8' },
      'timeout-ms': { type: 'string', default: '300000' },
      'top-k': { type: 'string', default: DEFAULT_TOP_K },
      'trace-dir': { type: 'string', default: DEFAULT_TRACE_DIR },
      workspace: { type: 'string' },
    },
  })

  const mode = parseMode(values.mode)
  const topK = parsePositiveInteger('top-k', values['top-k'])
  const searchTopK = parsePositiveInteger('search-top-k', values['search-top-k'])
  const timeoutMs = parsePositiveInteger('timeout-ms', values['timeout-ms'])
  const maxToolCalls = parsePositiveInteger('max-tool-calls', values['max-tool-calls'])
  const maxTurns = parsePositiveInteger('max-turns', values['max-turns'])
  const limit = parseLimit(values.limit)
  const casesPath = resolve(values.cases ?? DEFAULT_CASES)
  const localRoot = resolve(values['local-root'] ?? DEFAULT_LOCAL_ROOT)
  const output = resolve(values.output ?? outputPathForMode(mode))
  const remoteRoot = values['remote-root'] ?? DEFAULT_REMOTE_ROOT
  const traceDir = resolve(values['trace-dir'] ?? DEFAULT_TRACE_DIR, mode)
  const workspace = resolve(values.workspace ?? (mode === 'docs-ssh-agent' ? resolve(traceDir, 'workspace') : process.cwd()))
  const codexHome = values['codex-home'] ? resolve(values['codex-home']) : undefined
  const toolPath = resolve('bench/ragbench/retrieval/vector-agent-tool.ts')
  const sshCommand = process.env.DOCS_SSH_BENCH_SSH_COMMAND?.trim() ?? ''

  if (mode === 'docs-ssh-agent') {
    if (!sshCommand) throw new Error('DOCS_SSH_BENCH_SSH_COMMAND must be set for --mode docs-ssh-agent')
    validateRemoteRoot(remoteRoot)
  }

  const cases = await readCases(casesPath)
  for (const entry of cases) {
    validateCase(entry)
  }
  const selectedCases = limit === null ? cases : cases.slice(0, limit)

  await mkdir(dirname(output), { recursive: true })
  await mkdir(traceDir, { recursive: true })
  await mkdir(workspace, { recursive: true })
  const schemaPath = resolve(traceDir, 'output-schema.json')
  await writeFile(schemaPath, JSON.stringify(schemaForTopK(topK), null, 2), 'utf8')

  const caseInputPath = resolve(traceDir, 'agent-cases.jsonl')
  await writeVectorAgentCases(caseInputPath, selectedCases)

  const runs: RetrievalRun[] = []
  for (const entry of selectedCases) {
    runs.push(await runCase({
      caseInputPath,
      codexBin: values['codex-bin'] ?? 'codex',
      codexHome,
      entry,
      localRoot,
      maxToolCalls,
      maxTurns,
      mode,
      model: values.model ?? DEFAULT_MODEL,
      reasoningEffort: values['reasoning-effort'] ?? DEFAULT_REASONING_EFFORT,
      remoteRoot,
      sandbox: values.sandbox ?? 'danger-full-access',
      schemaPath,
      searchTopK,
      sshCommand,
      timeoutMs,
      topK,
      toolPath,
      traceDir,
      workspace,
    }))
    await writeFile(output, runs.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
  }

  console.log(JSON.stringify({
    cases: runs.length,
    errorCount: runs.reduce((sum, entry) => sum + entry.errors.length, 0),
    maxToolCalls,
    maxTurns,
    mode,
    model: values.model ?? DEFAULT_MODEL,
    output,
    reasoningEffort: values['reasoning-effort'] ?? DEFAULT_REASONING_EFFORT,
    traceDir,
    workspace,
  }, null, 2))
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
