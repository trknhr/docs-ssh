import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, posix, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { getCliArgs, readJsonl } from '../io.js'
import { getMaterializedDocumentRelativePath, type CorpusLayout } from '../materialize.js'
import type { MultihopDocument, MultihopQuestion, RetrievedCandidate, RetrievalMode, RetrievalRun } from '../types.js'

const DEFAULT_DOCUMENTS = '.bench/multihop-rag/normalized/documents.jsonl'
const DEFAULT_QUESTIONS = '.bench/multihop-rag/normalized/questions.jsonl'
const DEFAULT_REMOTE_ROOT = '/projects/multihop-rag/tasks/multihop-rag-corpus'
const DEFAULT_TRACE_DIR = '.bench/multihop-rag/agent'
const DEFAULT_TOP_K = '10'
const DEFAULT_CORPUS_LAYOUT: CorpusLayout = 'flat'
const DEFAULT_LIMIT = '3'
const DEFAULT_CONCURRENCY = '1'
const DEFAULT_CODEX_HOME = process.env.DOCS_SSH_BENCH_CODEX_HOME
const DEFAULT_MAX_TOOL_CALLS = process.env.DOCS_SSH_BENCH_CODEX_MAX_TOOL_CALLS ?? '8'
const DEFAULT_MAX_TURNS = process.env.DOCS_SSH_BENCH_CODEX_MAX_TURNS ?? '1'
const DEFAULT_MODEL = process.env.DOCS_SSH_BENCH_CODEX_MODEL ?? 'gpt-5.4-mini'
const DEFAULT_REASONING_EFFORT = process.env.DOCS_SSH_BENCH_CODEX_REASONING_EFFORT ?? 'low'
const TEXT_PREVIEW_LENGTH = 240
const WORKSPACE_SANDBOX = 'workspace-write'

type AgentMode = Extract<RetrievalMode, 'docs-ssh-agent' | 'vector-agent'>

interface AgentCandidate {
  confidence: number | null
  documentId: string
  reason: string
}

interface AgentAnswer {
  candidates: AgentCandidate[]
}

interface CodexEventMetrics {
  toolCallCount: number
  turnCount: number
}

interface CodexResult {
  elapsedMs: number
  errors: string[]
  finalMessage: string
  metrics: CodexEventMetrics
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function promptPath(value: string): string {
  const relativePath = relative(process.cwd(), value)
  if (relativePath && relativePath !== '..' && !relativePath.startsWith('..') && !relativePath.startsWith('/')) {
    return relativePath
  }
  return value
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parsePositiveInteger(name: string, value: string | undefined): number {
  if (!value || !/^\d+$/u.test(value)) throw new Error(`--${name} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`)
  return parsed
}

function parseLimit(value: string | undefined): number | null {
  if (!value || value === 'all') return null
  return parsePositiveInteger('limit', value)
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onResult?: (result: R, index: number) => Promise<void>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function runWorker(): Promise<void> {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      const item = items[index]
      if (item === undefined) return
      const result = await worker(item, index)
      results[index] = result
      await onResult?.(result, index)
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    () => runWorker(),
  ))
  return results
}

function parseMode(value: string | undefined): AgentMode {
  if (value === 'docs-ssh-agent' || value === 'vector-agent') return value
  throw new Error('--mode must be "docs-ssh-agent" or "vector-agent"')
}

function parseCorpusLayout(value: string | undefined): CorpusLayout {
  if (!value || value === 'flat') return 'flat'
  if (value === 'category-source-title') return 'category-source-title'
  throw new Error('--corpus-layout must be "flat" or "category-source-title"')
}

function splitShellCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let escaped = false
  let quote: '"' | "'" | null = null

  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (escaped) current += '\\'
  if (quote) throw new Error('Unterminated quote in SSH command')
  if (current.length > 0) tokens.push(current)
  return tokens
}

async function copyIfPresent(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await copyFile(sourcePath, destinationPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
    await writeFile(destinationPath, '', 'utf8')
  }
}

export async function localizeSshCommandFiles(workspace: string, sshCommand: string): Promise<string> {
  const tokens = splitShellCommand(sshCommand)
  if (tokens.length === 0 || tokens[0] !== 'ssh') return sshCommand

  const sshDir = resolve(workspace, '.ssh')
  await mkdir(sshDir, { recursive: true })

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '-i' && tokens[index + 1]) {
      const identityPath = tokens[index + 1]
      const localizedIdentityPath = resolve(sshDir, 'identity')
      await copyFile(identityPath, localizedIdentityPath)
      await chmod(localizedIdentityPath, 0o600)
      tokens[index + 1] = localizedIdentityPath
      index += 1
      continue
    }

    const optionToken = token === '-o' ? tokens[index + 1] : token.startsWith('-o') ? token.slice(2) : undefined
    if (!optionToken?.startsWith('UserKnownHostsFile=')) continue

    const localizedKnownHostsPath = resolve(sshDir, 'known_hosts')
    const knownHostsPath = optionToken.slice('UserKnownHostsFile='.length)
    await copyIfPresent(knownHostsPath, localizedKnownHostsPath)
    await chmod(localizedKnownHostsPath, 0o644)

    const localizedOption = `UserKnownHostsFile=${localizedKnownHostsPath}`
    if (token === '-o') {
      tokens[index + 1] = localizedOption
      index += 1
    } else {
      tokens[index] = `-o${localizedOption}`
    }
  }

  return tokens.map(shellQuote).join(' ')
}

function outputPathForMode(mode: AgentMode): string {
  return `.bench/multihop-rag/runs/${mode}.jsonl`
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
          required: ['documentId', 'reason', 'confidence'],
          properties: {
            documentId: {
              type: 'string',
              description: 'MultiHop-RAG document id such as doc_0123abcd, without .md suffix.',
            },
            reason: { type: 'string' },
            confidence: { type: ['number', 'null'] },
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
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return JSON.parse(candidate.slice(start, index + 1))
    }
  }

  throw new Error('Codex final message did not contain a complete JSON object')
}

export function parseAgentAnswer(text: string): AgentAnswer {
  const parsed = extractJsonObject(text)
  const record = asRecord(parsed)
  if (!record) throw new Error('Codex final JSON must be an object')
  if (!Array.isArray(record.candidates)) throw new Error('Codex final JSON candidates must be an array')

  return {
    candidates: record.candidates.map((candidate, index): AgentCandidate => {
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
    }),
  }
}

export function parseCodexEventMetrics(output: string): CodexEventMetrics {
  let toolCallCount = 0
  let turnCount = 0

  for (const line of output.split(/\r?\n/u)) {
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
    if (record.type === 'turn.started') turnCount += 1
    if (record.type !== 'item.started') continue
    const item = asRecord(record.item)
    if (!item) continue
    if (item.type === 'command_execution' || item.type === 'mcp_tool_call' || item.type === 'web_search') {
      toolCallCount += 1
    } else if (typeof item.type === 'string' && item.type.endsWith('_tool_call')) {
      toolCallCount += 1
    }
  }

  return { toolCallCount, turnCount }
}

export function makeVectorPrompt(opts: {
  documentsPath: string
  maxToolCalls: number
  question: string
  searchTopK: number
  topK: number
  toolPath: string
}): string {
  const documentsPath = promptPath(opts.documentsPath)
  const toolPath = promptPath(opts.toolPath)
  const searchCommand = [
    'pnpm exec tsx',
    shellQuote(toolPath),
    'search',
    '--documents',
    shellQuote(documentsPath),
    '--query',
    shellQuote('<query>'),
    '--top-k',
    String(opts.searchTopK),
  ].join(' ')
  const readManyCommand = [
    'pnpm exec tsx',
    shellQuote(toolPath),
    'read-many',
    '--documents',
    shellQuote(documentsPath),
    '--document-ids',
    shellQuote('<commaSeparatedDocumentIds>'),
    '--start-line',
    '1',
    '--end-line',
    '80',
  ].join(' ')

  return [
    'You are running a MultiHop-RAG retrieval evaluation.',
    '',
    `Question: ${opts.question}`,
    '',
    'Use only the retrieval tool commands below. Do not inspect normalized gold files or support labels.',
    'Do not edit files. Search first, then read promising documents before deciding.',
    'Prefer one search, then read multiple top candidates with read-many.',
    `Budget: use at most ${opts.maxToolCalls} shell commands in this single turn.`,
    '',
    `Search command template: ${searchCommand}`,
    `Read many command template: ${readManyCommand}`,
    '',
    `Return the best ${opts.topK} document ids in rank order. Return JSON only.`,
  ].join('\n')
}

export function makeDocsSshPrompt(opts: {
  corpusLayout?: CorpusLayout
  maxToolCalls: number
  question: string
  remoteCommand: string
  remoteRoot: string
  topK: number
}): string {
  const corpusRoot = posix.join(opts.remoteRoot, 'corpus', 'news')
  const corpusLayout = opts.corpusLayout ?? DEFAULT_CORPUS_LAYOUT
  const layoutHint = corpusLayout === 'category-source-title'
    ? 'The corpus is organized as /corpus/news/<category>/<source>/<slugified-title>__<documentId>.md. Inspect category/source directories first, then restrict rg to relevant source or category subtrees when possible.'
    : 'The corpus is flat under /corpus/news and files are named by stable document IDs.'
  const starterBatch = (corpusLayout === 'category-source-title'
    ? [
      `find ${corpusRoot} -maxdepth 3 -type d | sort | head -80`,
      `rg -i -n -m 2 -e 'REPLACE_WITH_KEY_TERM' ${corpusRoot}`,
    ]
    : [
      `find ${corpusRoot} -maxdepth 1 -type f | head -20`,
      `rg -i -n -m 2 -e 'REPLACE_WITH_KEY_TERM' ${corpusRoot}`,
    ])
    .map((command) => command.replaceAll("'", "'\"'\"'"))
    .map((command) => `'${command}'`)
    .join(' ')

  return [
    'You are running a MultiHop-RAG retrieval evaluation.',
    '',
    `Question: ${opts.question}`,
    '',
    'Use only the remote SSH helper in the current directory. Do not run docs-ssh status/login. Do not read skills, local normalized files, local .bench files, gold files, or support labels.',
    'Do not inspect /Users paths or the local filesystem to find corpus files or SSH credentials. All corpus access must go through the remote helper.',
    'Do not edit files. Use read-only remote commands through the helper.',
    layoutHint,
    'Use bootstrap --json if you need project context. Search under the corpus root, then read bounded ranges from candidate documents.',
    'Prefer the remote batch helper so multiple remote commands run through one remote exec.',
    'Use rg -m to cap per-file matches; avoid piping remote rg into head because it may still scan the full corpus.',
    `Budget: use at most ${opts.maxToolCalls} shell commands in this single turn.`,
    '',
    `Remote helper command: ${opts.remoteCommand}`,
    `Corpus root: ${corpusRoot}`,
    'Useful remote tools: find, rg, read-range, batch.',
    `Example batch shape: printf '%s\\n' ${starterBatch} | ${opts.remoteCommand} batch`,
    '',
    `Return the best ${opts.topK} document ids in rank order. Document ids are file basenames like doc_abc123 without .md. Return JSON only.`,
  ].join('\n')
}

async function writeRemoteHelper(workspace: string, sshCommand: string): Promise<void> {
  const helperPath = resolve(workspace, 'remote')
  const localizedSshCommand = await localizeSshCommandFiles(workspace, sshCommand)
  await writeFile(helperPath, [
    '#!/bin/sh',
    `exec ${localizedSshCommand} "$@"`,
    '',
  ].join('\n'), 'utf8')
  await chmod(helperPath, 0o755)
}

async function runCodex(opts: {
  caseId: string
  codexBin: string
  codexHome: string | undefined
  env?: Record<string, string>
  maxToolCalls: number
  maxTurns: number
  model: string
  prompt: string
  reasoningEffort: string
  sandbox: string
  schemaPath: string
  timeoutMs: number
  traceDir: string
  workspace: string
}): Promise<CodexResult> {
  const caseTraceDir = resolve(opts.traceDir, opts.caseId)
  await mkdir(caseTraceDir, { recursive: true })
  const promptFile = resolve(caseTraceDir, 'prompt.md')
  const finalPath = resolve(caseTraceDir, 'final.json')
  await writeFile(promptFile, opts.prompt, 'utf8')

  const startedAt = Date.now()
  const result = await new Promise<{
    error: Error | null
    status: number | null
    stderr: string
    stdout: string
  }>((resolvePromise) => {
    const child = spawn(
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
        env: {
          ...process.env,
          ...opts.env,
          ...(opts.codexHome ? { CODEX_HOME: opts.codexHome, HOME: opts.codexHome } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    let stderr = ''
    let error: Error | null = null
    const timeout = setTimeout(() => {
      error = new Error(`codex exec timed out after ${opts.timeoutMs}ms`)
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 1000).unref()
    }, opts.timeoutMs)
    timeout.unref()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (childError) => {
      error = childError
    })
    child.on('close', (status) => {
      clearTimeout(timeout)
      resolvePromise({
        error,
        status,
        stderr,
        stdout,
      })
    })
    child.stdin.end(opts.prompt)
  })

  await writeFile(resolve(caseTraceDir, 'stdout.log'), result.stdout ?? '', 'utf8')
  await writeFile(resolve(caseTraceDir, 'stderr.log'), result.stderr ?? '', 'utf8')

  const errors: string[] = []
  if (result.error) errors.push(result.error.message)
  if (result.status !== 0) errors.push(`codex exec exited with ${result.status ?? 'unknown'}`)

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
    elapsedMs: Date.now() - startedAt,
    errors,
    finalMessage,
    metrics,
  }
}

function candidatesFromAnswer(opts: {
  answer: AgentAnswer
  corpusLayout: CorpusLayout
  documents: MultihopDocument[]
  mode: AgentMode
  remoteRoot: string
  topK: number
}): { candidates: RetrievedCandidate[]; errors: string[] } {
  const errors: string[] = []
  const documentsById = new Map(opts.documents.map((document) => [document.documentId, document]))
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
      documentId: document.documentId,
      path: opts.mode === 'docs-ssh-agent'
        ? posix.join(opts.remoteRoot, getMaterializedDocumentRelativePath(document, opts.corpusLayout))
        : `corpus/news/${document.documentId}.md`,
      rank: candidates.length + 1,
      score: candidate.confidence ?? opts.topK - index,
      textPreview: document.text.slice(0, TEXT_PREVIEW_LENGTH),
    })
  }

  return { candidates, errors }
}

async function runCase(opts: {
  codexBin: string
  codexHome: string | undefined
  corpusLayout: CorpusLayout
  documents: MultihopDocument[]
  documentsPath: string
  maxToolCalls: number
  maxTurns: number
  mode: AgentMode
  model: string
  question: MultihopQuestion
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
  const prompt = opts.mode === 'vector-agent'
    ? makeVectorPrompt({
      documentsPath: opts.documentsPath,
      maxToolCalls: opts.maxToolCalls,
      question: opts.question.question,
      searchTopK: opts.searchTopK,
      topK: opts.topK,
      toolPath: opts.toolPath,
    })
    : makeDocsSshPrompt({
      corpusLayout: opts.corpusLayout,
      maxToolCalls: opts.maxToolCalls,
      question: opts.question.question,
      remoteCommand: './remote',
      remoteRoot: opts.remoteRoot,
      topK: opts.topK,
    })

  const codex = await runCodex({
    caseId: opts.question.caseId,
    codexBin: opts.codexBin,
    codexHome: opts.codexHome,
    env: opts.mode === 'docs-ssh-agent'
      ? {
        DOCS_SSH_AGENT_COMMAND: opts.sshCommand,
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
        corpusLayout: opts.corpusLayout,
        documents: opts.documents,
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
    bytesRead: candidates.reduce((sum, candidate) => sum + Buffer.byteLength(candidate.textPreview ?? '', 'utf8'), 0),
    candidates,
    caseId: opts.question.caseId,
    commandCount: codex.metrics.toolCallCount,
    elapsedMs: codex.elapsedMs,
    errors,
    filesRead: candidates.length,
    mode: opts.mode,
    question: opts.question.question,
    sshExecCount: opts.mode === 'docs-ssh-agent' ? codex.metrics.toolCallCount : 0,
  }
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: getCliArgs(),
    options: {
      'codex-bin': { type: 'string', default: 'codex' },
      'codex-home': { type: 'string', default: DEFAULT_CODEX_HOME },
      concurrency: { type: 'string', default: DEFAULT_CONCURRENCY },
      'corpus-layout': { type: 'string', default: DEFAULT_CORPUS_LAYOUT },
      documents: { type: 'string', default: DEFAULT_DOCUMENTS },
      limit: { type: 'string', default: DEFAULT_LIMIT },
      'max-tool-calls': { type: 'string', default: DEFAULT_MAX_TOOL_CALLS },
      'max-turns': { type: 'string', default: DEFAULT_MAX_TURNS },
      mode: { type: 'string' },
      model: { type: 'string', default: DEFAULT_MODEL },
      output: { type: 'string' },
      questions: { type: 'string', default: DEFAULT_QUESTIONS },
      'reasoning-effort': { type: 'string', default: DEFAULT_REASONING_EFFORT },
      'remote-root': { type: 'string', default: DEFAULT_REMOTE_ROOT },
      sandbox: { type: 'string' },
      'search-top-k': { type: 'string', default: '10' },
      'ssh-command': { type: 'string' },
      'timeout-ms': { type: 'string', default: '300000' },
      'top-k': { type: 'string', default: DEFAULT_TOP_K },
      'trace-dir': { type: 'string', default: DEFAULT_TRACE_DIR },
      workspace: { type: 'string' },
    },
  })

  const mode = parseMode(values.mode)
  const corpusLayout = parseCorpusLayout(values['corpus-layout'])
  const concurrency = parsePositiveInteger('concurrency', values.concurrency)
  const topK = parsePositiveInteger('top-k', values['top-k'])
  const searchTopK = parsePositiveInteger('search-top-k', values['search-top-k'])
  const timeoutMs = parsePositiveInteger('timeout-ms', values['timeout-ms'])
  const maxToolCalls = parsePositiveInteger('max-tool-calls', values['max-tool-calls'])
  const maxTurns = parsePositiveInteger('max-turns', values['max-turns'])
  const limit = parseLimit(values.limit)
  const documentsPath = resolve(values.documents ?? DEFAULT_DOCUMENTS)
  const questionsPath = resolve(values.questions ?? DEFAULT_QUESTIONS)
  const output = resolve(values.output ?? outputPathForMode(mode))
  const traceDir = resolve(values['trace-dir'] ?? DEFAULT_TRACE_DIR, mode)
  const workspace = resolve(values.workspace ?? (mode === 'docs-ssh-agent' ? resolve(traceDir, 'workspace') : process.cwd()))
  const codexHome = values['codex-home'] ? resolve(values['codex-home']) : undefined
  const toolPath = resolve('bench/multihop-rag/retrieval/vector-agent-tool.ts')
  const sshCommand = values['ssh-command'] ?? process.env.DOCS_SSH_BENCH_SSH_COMMAND ?? ''
  const remoteRoot = values['remote-root'] ?? DEFAULT_REMOTE_ROOT
  const sandbox = values.sandbox ?? (mode === 'docs-ssh-agent' ? WORKSPACE_SANDBOX : 'danger-full-access')

  if (mode === 'docs-ssh-agent' && !sshCommand.trim()) {
    throw new Error('docs-ssh-agent requires --ssh-command or DOCS_SSH_BENCH_SSH_COMMAND')
  }

  const documents = await readJsonl<MultihopDocument>(documentsPath)
  const questions = await readJsonl<MultihopQuestion>(questionsPath)
  const selectedQuestions = limit === null ? questions : questions.slice(0, limit)

  await mkdir(dirname(output), { recursive: true })
  await mkdir(traceDir, { recursive: true })
  await mkdir(workspace, { recursive: true })
  const schemaPath = resolve(traceDir, 'output-schema.json')
  await writeFile(schemaPath, JSON.stringify(schemaForTopK(topK), null, 2), 'utf8')

  const partialRuns = new Array<RetrievalRun | undefined>(selectedQuestions.length)
  let partialWriteChain = Promise.resolve()
  const writePartialRun = (result: RetrievalRun, index: number): Promise<void> => {
    partialRuns[index] = result
    partialWriteChain = partialWriteChain.then(async () => {
      const completedRuns = partialRuns.filter((entry): entry is RetrievalRun => Boolean(entry))
      await writeFile(output, `${completedRuns.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
    })
    return partialWriteChain
  }

  const runs = await runWithConcurrency(selectedQuestions, concurrency, async (question) => {
    const caseWorkspace = mode === 'docs-ssh-agent' ? resolve(workspace, question.caseId) : workspace
    await mkdir(caseWorkspace, { recursive: true })
    if (mode === 'docs-ssh-agent') {
      await writeRemoteHelper(caseWorkspace, sshCommand)
    }
    return runCase({
      codexBin: values['codex-bin'] ?? 'codex',
      codexHome,
      corpusLayout,
      documents,
      documentsPath,
      maxToolCalls,
      maxTurns,
      mode,
      model: values.model ?? DEFAULT_MODEL,
      question,
      reasoningEffort: values['reasoning-effort'] ?? DEFAULT_REASONING_EFFORT,
      remoteRoot,
      sandbox,
      schemaPath,
      searchTopK,
      sshCommand,
      timeoutMs,
      topK,
      toolPath,
      traceDir,
      workspace: caseWorkspace,
    })
  }, writePartialRun)
  await partialWriteChain
  await writeFile(output, `${runs.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')

  console.log(JSON.stringify({
    cases: runs.length,
    concurrency,
    errorCount: runs.reduce((sum, entry) => sum + entry.errors.length, 0),
    maxToolCalls,
    maxTurns,
    mode,
    corpusLayout,
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
