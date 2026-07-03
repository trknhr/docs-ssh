import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { getCliArgs, readJsonl, writeJson, writeJsonl } from './io.js'
import type { CaseScore, MultihopGold, RetrievalRun } from './types.js'

const DEFAULT_GOLD = '.bench/multihop-rag/normalized/gold.jsonl'

function intersectionCount(left: string[], right: string[]): number {
  const rightSet = new Set(right)
  return left.filter((value) => rightSet.has(value)).length
}

function anyHit(expected: string[], retrieved: string[], k: number): boolean {
  return intersectionCount(expected, retrieved.slice(0, k)) > 0
}

function allHit(expected: string[], retrieved: string[], k: number): boolean {
  const retrievedSet = new Set(retrieved.slice(0, k))
  return expected.length > 0 && expected.every((documentId) => retrievedSet.has(documentId))
}

function evidenceRecall(expected: string[], retrieved: string[], k: number): number {
  if (expected.length === 0) return 0
  return intersectionCount(expected, retrieved.slice(0, k)) / expected.length
}

function reciprocalRank(expected: string[], retrieved: string[], k: number): number {
  const expectedSet = new Set(expected)
  const index = retrieved.slice(0, k).findIndex((documentId) => expectedSet.has(documentId))
  return index === -1 ? 0 : 1 / (index + 1)
}

function averagePrecision(expected: string[], retrieved: string[], k: number): number {
  const expectedSet = new Set(expected)
  if (expectedSet.size === 0) return 0

  let hitCount = 0
  let precisionSum = 0
  for (const [index, documentId] of retrieved.slice(0, k).entries()) {
    if (!expectedSet.has(documentId)) continue
    hitCount += 1
    precisionSum += hitCount / (index + 1)
  }
  return precisionSum / Math.min(expectedSet.size, k)
}

export function scoreRuns(runs: RetrievalRun[], goldRows: MultihopGold[]): CaseScore[] {
  const goldByCaseId = new Map(goldRows.map((gold) => [gold.caseId, gold]))

  return runs.map((run) => {
    const gold = goldByCaseId.get(run.caseId)
    if (!gold) {
      throw new Error(`Run references unknown caseId: ${run.caseId}`)
    }

    const retrievedDocumentIds = run.candidates
      .slice()
      .sort((left, right) => left.rank - right.rank)
      .map((candidate) => candidate.documentId)
    const expectedDocumentIds = gold.supportingDocumentIds

    return {
      allEvidenceRecallAt10: allHit(expectedDocumentIds, retrievedDocumentIds, 10),
      allEvidenceRecallAt5: allHit(expectedDocumentIds, retrievedDocumentIds, 5),
      anyEvidenceRecallAt1: anyHit(expectedDocumentIds, retrievedDocumentIds, 1),
      anyEvidenceRecallAt10: anyHit(expectedDocumentIds, retrievedDocumentIds, 10),
      anyEvidenceRecallAt5: anyHit(expectedDocumentIds, retrievedDocumentIds, 5),
      averagePrecisionAt10: averagePrecision(expectedDocumentIds, retrievedDocumentIds, 10),
      bytesRead: run.bytesRead,
      caseId: run.caseId,
      commandCount: run.commandCount,
      elapsedMs: run.elapsedMs,
      errors: run.errors,
      evidenceRecallAt10: evidenceRecall(expectedDocumentIds, retrievedDocumentIds, 10),
      evidenceRecallAt5: evidenceRecall(expectedDocumentIds, retrievedDocumentIds, 5),
      expectedDocumentIds,
      filesRead: run.filesRead,
      mode: run.mode,
      reciprocalRankAt10: reciprocalRank(expectedDocumentIds, retrievedDocumentIds, 10),
      retrievedDocumentIds,
      sshExecCount: run.sshExecCount,
    }
  })
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function boolMean(values: boolean[]): number {
  return mean(values.map((value) => (value ? 1 : 0)))
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[index] ?? 0
}

export function summarizeScores(scores: CaseScore[]): Record<string, unknown> {
  const modes = [...new Set(scores.map((score) => score.mode))]
  return {
    allEvidenceRecallAt10: boolMean(scores.map((score) => score.allEvidenceRecallAt10)),
    allEvidenceRecallAt5: boolMean(scores.map((score) => score.allEvidenceRecallAt5)),
    anyEvidenceRecallAt1: boolMean(scores.map((score) => score.anyEvidenceRecallAt1)),
    anyEvidenceRecallAt10: boolMean(scores.map((score) => score.anyEvidenceRecallAt10)),
    anyEvidenceRecallAt5: boolMean(scores.map((score) => score.anyEvidenceRecallAt5)),
    averagePrecisionAt10: mean(scores.map((score) => score.averagePrecisionAt10)),
    avgBytesRead: mean(scores.map((score) => score.bytesRead)),
    avgCommandCount: mean(scores.map((score) => score.commandCount)),
    avgElapsedMs: mean(scores.map((score) => score.elapsedMs)),
    avgFilesRead: mean(scores.map((score) => score.filesRead)),
    avgSshExecCount: mean(scores.map((score) => score.sshExecCount)),
    cases: scores.length,
    errorCases: scores.filter((score) => score.errors.length > 0).length,
    evidenceRecallAt10: mean(scores.map((score) => score.evidenceRecallAt10)),
    evidenceRecallAt5: mean(scores.map((score) => score.evidenceRecallAt5)),
    mode: modes.length === 1 ? modes[0] : modes,
    mrrAt10: mean(scores.map((score) => score.reciprocalRankAt10)),
    p95ElapsedMs: percentile(scores.map((score) => score.elapsedMs), 95),
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    allowPositionals: false,
    args: getCliArgs(),
    options: {
      'cases-output': { type: 'string' },
      gold: { default: DEFAULT_GOLD, type: 'string' },
      output: { type: 'string' },
      runs: { type: 'string' },
    },
  })

  if (!values.runs) throw new Error('Missing required --runs path')

  const gold = await readJsonl<MultihopGold>(resolve(String(values.gold)))
  const runs = await readJsonl<RetrievalRun>(resolve(String(values.runs)))
  const scores = scoreRuns(runs, gold)
  const summary = summarizeScores(scores)

  if (values['cases-output']) {
    await writeJsonl(resolve(String(values['cases-output'])), scores)
  }
  if (values.output) {
    await writeJson(resolve(String(values.output)), summary)
  }

  console.log(JSON.stringify(summary, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exitCode = 1
  })
}
