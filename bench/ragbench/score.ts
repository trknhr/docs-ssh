import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { CaseScore, RetrievalRun } from './types.js'

const DEFAULT_CASES = '.bench/ragbench/cases.jsonl'
const DEFAULT_RUNS = '.bench/ragbench/runs/vector.jsonl'

type RetrievalMode = RetrievalRun['mode']

interface CaseLabels {
  caseId: string
  lineNumber: number
  supportingDocumentIds: string[]
}

interface ParsedRun {
  lineNumber: number
  run: RetrievalRun
}

interface ScoreSummary {
  mode: RetrievalMode | 'unknown'
  cases: number
  skippedCases: number
  scoredCases: number
  hitAt1: number
  hitAt3: number
  hitAt5: number
  mrr: number
  avgElapsedMs: number
  avgCommandCount: number
  avgFilesRead: number
  avgBytesRead: number
  errorCases: number
}

interface ScoreOutput {
  summary: ScoreSummary
  scores: CaseScore[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function expectString(record: Record<string, unknown>, field: string, source: string, lineNumber: number): string {
  const value = record[field]
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${source} JSONL line ${lineNumber}: ${field} must be a string`)
  }
  return value
}

function expectStringArray(
  record: Record<string, unknown>,
  field: string,
  source: string,
  lineNumber: number,
): string[] {
  const value = record[field]
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`Invalid ${source} JSONL line ${lineNumber}: ${field} must be a string array`)
  }
  return value
}

function expectNumber(record: Record<string, unknown>, field: string, source: string, lineNumber: number): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${source} JSONL line ${lineNumber}: ${field} must be a finite number`)
  }
  return value
}

async function readJsonl<T>(
  path: string,
  source: string,
  parseEntry: (record: Record<string, unknown>, lineNumber: number) => T,
): Promise<T[]> {
  const content = await readFile(path, 'utf8')
  return content
    .split(/\r?\n/u)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, lineNumber }) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Invalid ${source} JSONL line ${lineNumber}: ${message}`)
      }

      const record = asRecord(parsed)
      if (!record) {
        throw new Error(`Invalid ${source} JSONL line ${lineNumber}: expected an object`)
      }
      return parseEntry(record, lineNumber)
    })
}

function parseCase(record: Record<string, unknown>, lineNumber: number): CaseLabels {
  return {
    caseId: expectString(record, 'caseId', 'case', lineNumber),
    lineNumber,
    supportingDocumentIds: expectStringArray(record, 'supportingDocumentIds', 'case', lineNumber),
  }
}

function parseMode(record: Record<string, unknown>, lineNumber: number): RetrievalMode {
  const mode = expectString(record, 'mode', 'run', lineNumber)
  if (mode !== 'vector' && mode !== 'docs-ssh') {
    throw new Error(`Invalid run JSONL line ${lineNumber}: mode must be "vector" or "docs-ssh"`)
  }
  return mode
}

function parseCandidates(record: Record<string, unknown>, lineNumber: number): RetrievalRun['candidates'] {
  const candidates = record.candidates
  if (!Array.isArray(candidates)) {
    throw new Error(`Invalid run JSONL line ${lineNumber}: candidates must be an array`)
  }

  return candidates.map((candidate, index) => {
    const candidateRecord = asRecord(candidate)
    if (!candidateRecord) {
      throw new Error(`Invalid run JSONL line ${lineNumber}: candidates[${index}] must be an object`)
    }

    const documentId = candidateRecord.documentId
    if (typeof documentId !== 'string') {
      throw new Error(`Invalid run JSONL line ${lineNumber}: candidates[${index}].documentId must be a string`)
    }

    const path = candidateRecord.path
    if (typeof path !== 'string') {
      throw new Error(`Invalid run JSONL line ${lineNumber}: candidates[${index}].path must be a string`)
    }

    const score = candidateRecord.score
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new Error(`Invalid run JSONL line ${lineNumber}: candidates[${index}].score must be a finite number`)
    }

    const textPreview = candidateRecord.textPreview
    if (typeof textPreview !== 'string') {
      throw new Error(`Invalid run JSONL line ${lineNumber}: candidates[${index}].textPreview must be a string`)
    }

    return {
      documentId,
      path,
      score,
      textPreview,
    }
  })
}

function parseRun(record: Record<string, unknown>, lineNumber: number): ParsedRun {
  return {
    lineNumber,
    run: {
      caseId: expectString(record, 'caseId', 'run', lineNumber),
      mode: parseMode(record, lineNumber),
      question: typeof record.question === 'string' ? record.question : '',
      candidates: parseCandidates(record, lineNumber),
      elapsedMs: expectNumber(record, 'elapsedMs', 'run', lineNumber),
      commandCount: expectNumber(record, 'commandCount', 'run', lineNumber),
      filesRead: expectNumber(record, 'filesRead', 'run', lineNumber),
      bytesRead: expectNumber(record, 'bytesRead', 'run', lineNumber),
      errors: expectStringArray(record, 'errors', 'run', lineNumber),
    },
  }
}

function makeOutputPath(runsPath: string): string {
  return runsPath.endsWith('.jsonl') ? runsPath.slice(0, -'.jsonl'.length) + '.scores.json' : `${runsPath}.scores.json`
}

function indexCases(cases: CaseLabels[]): Map<string, CaseLabels> {
  const byCaseId = new Map<string, CaseLabels>()
  for (const entry of cases) {
    const existing = byCaseId.get(entry.caseId)
    if (existing) {
      throw new Error(
        `Invalid case JSONL line ${entry.lineNumber}: duplicate caseId ${JSON.stringify(entry.caseId)}; first seen on line ${existing.lineNumber}`,
      )
    }
    byCaseId.set(entry.caseId, entry)
  }
  return byCaseId
}

function assertUniqueRuns(runs: ParsedRun[]): void {
  const firstLineByCaseId = new Map<string, number>()
  for (const entry of runs) {
    const firstLine = firstLineByCaseId.get(entry.run.caseId)
    if (firstLine !== undefined) {
      throw new Error(
        `Invalid run JSONL line ${entry.lineNumber}: duplicate caseId ${JSON.stringify(entry.run.caseId)}; first seen on line ${firstLine}`,
      )
    }
    firstLineByCaseId.set(entry.run.caseId, entry.lineNumber)
  }
}

function assertKnownCase(run: ParsedRun, casesById: Map<string, CaseLabels>): CaseLabels {
  const entry = casesById.get(run.run.caseId)
  if (!entry) {
    throw new Error(
      `Invalid run JSONL line ${run.lineNumber}: caseId ${JSON.stringify(run.run.caseId)} does not exist in --cases`,
    )
  }
  return entry
}

function detectMode(runs: ParsedRun[]): RetrievalMode | 'unknown' {
  if (runs.length === 0) return 'unknown'

  const mode = runs[0]?.run.mode
  for (const entry of runs) {
    if (entry.run.mode !== mode) {
      throw new Error(
        `Invalid run JSONL line ${entry.lineNumber}: mixed modes are not supported; expected ${JSON.stringify(mode)}, got ${JSON.stringify(entry.run.mode)}`,
      )
    }
  }
  return mode
}

function scoreRun(run: RetrievalRun, labels: CaseLabels): CaseScore {
  const expectedDocumentIds = labels.supportingDocumentIds
  const expected = new Set(expectedDocumentIds)
  const retrievedDocumentIds = run.candidates.map((candidate) => candidate.documentId)
  const firstRelevantIndex = retrievedDocumentIds.findIndex((documentId) => expected.has(documentId))
  const reciprocalRank = firstRelevantIndex === -1 ? 0 : 1 / (firstRelevantIndex + 1)

  return {
    caseId: run.caseId,
    mode: run.mode,
    hitAt1: retrievedDocumentIds.slice(0, 1).some((documentId) => expected.has(documentId)),
    hitAt3: retrievedDocumentIds.slice(0, 3).some((documentId) => expected.has(documentId)),
    hitAt5: retrievedDocumentIds.slice(0, 5).some((documentId) => expected.has(documentId)),
    reciprocalRank,
    expectedDocumentIds,
    retrievedDocumentIds,
    elapsedMs: run.elapsedMs,
    commandCount: run.commandCount,
    filesRead: run.filesRead,
    bytesRead: run.bytesRead,
    errors: run.errors,
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function rate(scores: CaseScore[], field: 'hitAt1' | 'hitAt3' | 'hitAt5'): number {
  if (scores.length === 0) return 0
  return scores.filter((score) => score[field]).length / scores.length
}

function summarize(mode: RetrievalMode | 'unknown', scores: CaseScore[]): ScoreSummary {
  const labeledScores = scores.filter((score) => score.expectedDocumentIds.length > 0)

  return {
    mode,
    cases: scores.length,
    skippedCases: scores.length - labeledScores.length,
    scoredCases: labeledScores.length,
    hitAt1: rate(labeledScores, 'hitAt1'),
    hitAt3: rate(labeledScores, 'hitAt3'),
    hitAt5: rate(labeledScores, 'hitAt5'),
    mrr: average(labeledScores.map((score) => score.reciprocalRank)),
    avgElapsedMs: average(scores.map((score) => score.elapsedMs)),
    avgCommandCount: average(scores.map((score) => score.commandCount)),
    avgFilesRead: average(scores.map((score) => score.filesRead)),
    avgBytesRead: average(scores.map((score) => score.bytesRead)),
    errorCases: scores.filter((score) => score.errors.length > 0).length,
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    options: {
      cases: { type: 'string', default: DEFAULT_CASES },
      runs: { type: 'string', default: DEFAULT_RUNS },
      output: { type: 'string' },
    },
  })

  const casesPath = resolve(values.cases ?? DEFAULT_CASES)
  const runsPath = resolve(values.runs ?? DEFAULT_RUNS)
  const output = resolve(values.output ?? makeOutputPath(runsPath))

  const casesById = indexCases(await readJsonl(casesPath, 'case', parseCase))
  const runs = await readJsonl(runsPath, 'run', parseRun)
  assertUniqueRuns(runs)
  const mode = detectMode(runs)
  const scores = runs.map((run) => scoreRun(run.run, assertKnownCase(run, casesById)))
  const summary = summarize(mode, scores)
  const outputJson: ScoreOutput = { summary, scores }

  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(outputJson, null, 2) + '\n', 'utf8')

  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
