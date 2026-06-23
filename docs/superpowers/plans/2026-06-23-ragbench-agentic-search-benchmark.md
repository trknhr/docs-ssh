# RAGBench Agentic Search Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local benchmark that compares docs-ssh filesystem search over SSH with a simple vector top-k baseline on the same RAGBench samples.

**Architecture:** Keep the benchmark outside the production server path under `bench/ragbench/`. Fetch a small RAGBench subset from the Hugging Face dataset server, normalize it into case JSONL, materialize the same documents into a docs-ssh project workspace, run two retrievers, and score evidence-document hit rate plus operational metrics. Phase 1 scores retrieval/evidence only; answer generation can be added later without changing the data format.

**Tech Stack:** Node 24, TypeScript, `tsx`, built-in `fetch`, local filesystem, SSH command execution, pnpm scripts, no production dependencies.

---

## File Structure

- Create `bench/ragbench/README.md`: benchmark workflow and interpretation notes.
- Create `bench/ragbench/types.ts`: shared dataset, candidate, run, and scoring types.
- Create `bench/ragbench/hf-dataset.ts`: Hugging Face dataset-server client and row normalization.
- Create `bench/ragbench/fetch.ts`: CLI to download RAGBench rows into `.bench/ragbench/cases.jsonl`.
- Create `bench/ragbench/materialize.ts`: CLI to write case documents locally and optionally into docs-ssh over SSH.
- Create `bench/ragbench/retrieval/text.ts`: tokenization and lexical vector helpers.
- Create `bench/ragbench/retrieval/vector-baseline.ts`: simple local vector-space top-k baseline.
- Create `bench/ragbench/retrieval/docs-ssh-runner.ts`: docs-ssh over SSH runner using `find`, `rg`, and `cat`.
- Create `bench/ragbench/score.ts`: evidence-document scoring and summary output.
- Modify `package.json`: add `bench:ragbench:*` scripts.
- Optional later: Create `bench/ragbench/answer.ts` for answer generation and faithfulness scoring after retrieval metrics are useful.

The benchmark intentionally writes generated data under `.bench/ragbench/`, which stays untracked.

---

### Task 1: Add Shared Benchmark Types

**Files:**
- Create: `bench/ragbench/types.ts`

- [ ] **Step 1: Create the shared type file**

Create `bench/ragbench/types.ts`:

```ts
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
```

- [ ] **Step 2: Verify TypeScript can parse the file**

Run:

```bash
pnpm exec tsc --noEmit
```

Expected: exits 0, because the new file is not imported yet and contains valid TypeScript.

- [ ] **Step 3: Commit**

```bash
git add bench/ragbench/types.ts
git commit -m "bench: Add RAGBench benchmark types" -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

### Task 2: Fetch and Normalize RAGBench Samples

**Files:**
- Create: `bench/ragbench/hf-dataset.ts`
- Create: `bench/ragbench/fetch.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the Hugging Face dataset client**

Create `bench/ragbench/hf-dataset.ts`:

```ts
import type { RagbenchCase, RagbenchDocument } from './types.js'

interface HuggingFaceRowsResponse {
  rows: Array<{
    row: Record<string, unknown>
  }>
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function parseDocuments(value: unknown): RagbenchDocument[] {
  const rawDocuments = Array.isArray(value) ? value : []
  return rawDocuments.map((entry, index) => {
    const text = typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object' && 'text' in entry && typeof entry.text === 'string'
        ? entry.text
        : JSON.stringify(entry)
    const titleMatch = /^Title:\s*(.+)$/m.exec(text)
    return {
      id: String(index),
      text,
      title: titleMatch?.[1]?.trim(),
    }
  })
}

function documentIdsFromSentenceKeys(keys: string[]): string[] {
  const ids = new Set<string>()
  for (const key of keys) {
    const match = /^(\d+)/u.exec(key)
    if (match) ids.add(match[1])
  }
  return [...ids].sort((a, b) => Number(a) - Number(b))
}

function extractSupportingDocumentIds(row: Record<string, unknown>): string[] {
  const candidateFields = [
    'all_relevant_sentence_keys',
    'relevant_sentence_keys',
    'sentence_support_information',
  ]
  for (const field of candidateFields) {
    const value = row[field]
    if (Array.isArray(value)) {
      const flat = value.flat(Infinity).filter((entry): entry is string => typeof entry === 'string')
      const ids = documentIdsFromSentenceKeys(flat)
      if (ids.length > 0) return ids
    }
  }
  return []
}

export function normalizeRagbenchRow(opts: {
  config: string
  index: number
  row: Record<string, unknown>
  split: string
}): RagbenchCase {
  const documents = parseDocuments(opts.row.documents)
  const supportingDocumentIds = extractSupportingDocumentIds(opts.row)
  return {
    caseId: `${opts.config}-${opts.split}-${opts.index}`,
    config: opts.config,
    split: opts.split,
    question: asString(opts.row.question),
    referenceAnswer: asString(opts.row.response),
    documents,
    supportingDocumentIds,
    raw: opts.row,
  }
}

export async function fetchRagbenchRows(opts: {
  config: string
  split: string
  offset: number
  length: number
}): Promise<RagbenchCase[]> {
  const params = new URLSearchParams({
    dataset: 'galileo-ai/ragbench',
    config: opts.config,
    split: opts.split,
    offset: String(opts.offset),
    length: String(opts.length),
  })
  const response = await fetch(`https://datasets-server.huggingface.co/rows?${params}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch RAGBench rows: ${response.status} ${await response.text()}`)
  }
  const payload = await response.json() as HuggingFaceRowsResponse
  return payload.rows.map((entry, index) => normalizeRagbenchRow({
    config: opts.config,
    index: opts.offset + index,
    row: entry.row,
    split: opts.split,
  }))
}
```

- [ ] **Step 2: Add the fetch CLI**

Create `bench/ragbench/fetch.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fetchRagbenchRows } from './hf-dataset.js'

function getArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

const config = getArg('config', 'emanual')
const split = getArg('split', 'test')
const limit = Number(getArg('limit', '50'))
const offset = Number(getArg('offset', '0'))
const output = resolve(getArg('output', '.bench/ragbench/cases.jsonl'))

const cases = await fetchRagbenchRows({ config, split, offset, length: limit })
await mkdir(dirname(output), { recursive: true })
await writeFile(output, cases.map((entry) => JSON.stringify(entry)).join('\n') + '\n')

console.log(JSON.stringify({
  cases: cases.length,
  config,
  output,
  split,
}, null, 2))
```

- [ ] **Step 3: Add pnpm scripts**

Modify `package.json` scripts:

```json
"bench:ragbench:fetch": "tsx bench/ragbench/fetch.ts",
"bench:ragbench:score": "tsx bench/ragbench/score.ts",
"bench:ragbench:vector": "tsx bench/ragbench/retrieval/vector-baseline.ts",
"bench:ragbench:docs-ssh": "tsx bench/ragbench/retrieval/docs-ssh-runner.ts",
"bench:ragbench:materialize": "tsx bench/ragbench/materialize.ts"
```

- [ ] **Step 4: Run fetch smoke**

Run:

```bash
pnpm bench:ragbench:fetch -- --config emanual --split test --limit 5
```

Expected: `.bench/ragbench/cases.jsonl` exists and the JSON output reports `cases: 5`.

- [ ] **Step 5: Commit**

```bash
git add package.json bench/ragbench/hf-dataset.ts bench/ragbench/fetch.ts
git commit -m "bench: Fetch RAGBench samples" -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

### Task 3: Materialize Cases for Local Filesystem and docs-ssh

**Files:**
- Create: `bench/ragbench/materialize.ts`
- Create: `bench/ragbench/README.md`

- [ ] **Step 1: Add materialization CLI**

Create `bench/ragbench/materialize.ts`:

```ts
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { RagbenchCase } from './types.js'

function getArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function readCases(path: string): Promise<RagbenchCase[]> {
  const content = await readFile(path, 'utf8')
  return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as RagbenchCase)
}

async function writeLocalCase(root: string, entry: RagbenchCase): Promise<void> {
  const caseDir = resolve(root, entry.caseId)
  await mkdir(resolve(caseDir, 'documents'), { recursive: true })
  await writeFile(resolve(caseDir, 'question.md'), [
    `# ${entry.caseId}`,
    '',
    `Question: ${entry.question}`,
    '',
    `Reference answer: ${entry.referenceAnswer}`,
    '',
    `Supporting documents: ${entry.supportingDocumentIds.join(', ') || 'unknown'}`,
    '',
  ].join('\n'))
  for (const document of entry.documents) {
    await writeFile(resolve(caseDir, 'documents', `doc-${document.id}.md`), [
      `# Document ${document.id}`,
      '',
      document.title ? `Title: ${document.title}\n` : '',
      document.text,
      '',
    ].join('\n'))
  }
}

function writeRemoteCase(sshCommand: string, root: string, entry: RagbenchCase): void {
  const caseRoot = `${root}/${entry.caseId}`
  spawnSync('sh', ['-lc', `${sshCommand} mkdir -p ${shellQuote(`${caseRoot}/documents`)}`], { stdio: 'inherit' })
  const question = [
    `# ${entry.caseId}`,
    '',
    `Question: ${entry.question}`,
    '',
    `Reference answer: ${entry.referenceAnswer}`,
    '',
    `Supporting documents: ${entry.supportingDocumentIds.join(', ') || 'unknown'}`,
    '',
  ].join('\n')
  spawnSync('sh', ['-lc', `printf %s ${shellQuote(question)} | ${sshCommand} "cat > ${shellQuote(`${caseRoot}/question.md`)}"`], { stdio: 'inherit' })
  for (const document of entry.documents) {
    const body = [`# Document ${document.id}`, '', document.title ? `Title: ${document.title}\n` : '', document.text, ''].join('\n')
    spawnSync('sh', ['-lc', `printf %s ${shellQuote(body)} | ${sshCommand} "cat > ${shellQuote(`${caseRoot}/documents/doc-${document.id}.md`)}"`], { stdio: 'inherit' })
  }
}

const casesPath = resolve(getArg('cases', '.bench/ragbench/cases.jsonl'))
const localRoot = resolve(getArg('local-root', '.bench/ragbench/tree/cases'))
const remoteRoot = getArg('remote-root', '/projects/ragbench/tasks/ragbench-cases')
const sshCommand = process.env.DOCS_SSH_BENCH_SSH_COMMAND
const cases = await readCases(casesPath)

await rm(localRoot, { force: true, recursive: true })
for (const entry of cases) await writeLocalCase(localRoot, entry)

if (sshCommand) {
  spawnSync('sh', ['-lc', `${sshCommand} mkdir -p ${shellQuote(remoteRoot)}`], { stdio: 'inherit' })
  for (const entry of cases) writeRemoteCase(sshCommand, remoteRoot, entry)
}

console.log(JSON.stringify({
  cases: cases.length,
  localRoot,
  remoteRoot: sshCommand ? remoteRoot : null,
}, null, 2))
```

- [ ] **Step 2: Add benchmark README**

Create `bench/ragbench/README.md`:

```md
# RAGBench docs-ssh Benchmark

This benchmark compares two retrieval paths on the same RAGBench samples:

1. `docs-ssh`: documents are placed in a docs-ssh project workspace and retrieved through SSH commands such as `find`, `rg`, and `cat`.
2. `vector`: documents are read locally and ranked with a simple vector-space top-k baseline.

Phase 1 evaluates evidence-document retrieval, not generated answer quality.

## Quick Run

```bash
pnpm bench:ragbench:fetch -- --config emanual --split test --limit 50
pnpm bench:ragbench:materialize
pnpm bench:ragbench:vector
pnpm bench:ragbench:score -- --runs .bench/ragbench/runs/vector.jsonl
```

To run the docs-ssh path, first create a project-scoped SSH session and export the returned command:

```bash
export DOCS_SSH_BENCH_SSH_COMMAND='ssh -i /path/to/id_ed25519 sess_xxx@docs-ssh'
pnpm bench:ragbench:materialize
pnpm bench:ragbench:docs-ssh
pnpm bench:ragbench:score -- --runs .bench/ragbench/runs/docs-ssh.jsonl
```
```

- [ ] **Step 3: Run local materialization smoke**

Run:

```bash
pnpm bench:ragbench:materialize
find .bench/ragbench/tree/cases -maxdepth 3 -type f | head
```

Expected: `question.md` and `documents/doc-*.md` files are listed.

- [ ] **Step 4: Commit**

```bash
git add bench/ragbench/materialize.ts bench/ragbench/README.md
git commit -m "bench: Materialize RAGBench cases" -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

### Task 4: Add Simple Vector Top-k Baseline

**Files:**
- Create: `bench/ragbench/retrieval/text.ts`
- Create: `bench/ragbench/retrieval/vector-baseline.ts`

- [ ] **Step 1: Add lexical vector helpers**

Create `bench/ragbench/retrieval/text.ts`:

```ts
export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 2)
}

export function termFrequency(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

export function cosineScore(query: Map<string, number>, document: Map<string, number>): number {
  let dot = 0
  let queryNorm = 0
  let documentNorm = 0
  for (const value of query.values()) queryNorm += value * value
  for (const value of document.values()) documentNorm += value * value
  for (const [token, value] of query.entries()) dot += value * (document.get(token) ?? 0)
  if (queryNorm === 0 || documentNorm === 0) return 0
  return dot / Math.sqrt(queryNorm * documentNorm)
}
```

- [ ] **Step 2: Add vector baseline runner**

Create `bench/ragbench/retrieval/vector-baseline.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { RagbenchCase, RetrievalRun } from '../types.js'
import { cosineScore, termFrequency, tokenize } from './text.js'

function getArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

async function readCases(path: string): Promise<RagbenchCase[]> {
  const content = await readFile(path, 'utf8')
  return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as RagbenchCase)
}

const casesPath = resolve(getArg('cases', '.bench/ragbench/cases.jsonl'))
const output = resolve(getArg('output', '.bench/ragbench/runs/vector.jsonl'))
const topK = Number(getArg('top-k', '5'))
const cases = await readCases(casesPath)
const runs: RetrievalRun[] = []

for (const entry of cases) {
  const started = Date.now()
  const queryVector = termFrequency(tokenize(entry.question))
  const candidates = entry.documents
    .map((document) => ({
      documentId: document.id,
      path: `.bench/ragbench/tree/cases/${entry.caseId}/documents/doc-${document.id}.md`,
      score: cosineScore(queryVector, termFrequency(tokenize(document.text))),
      textPreview: document.text.slice(0, 240),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
  runs.push({
    caseId: entry.caseId,
    mode: 'vector',
    question: entry.question,
    candidates,
    elapsedMs: Date.now() - started,
    commandCount: 0,
    filesRead: entry.documents.length,
    bytesRead: entry.documents.reduce((sum, document) => sum + Buffer.byteLength(document.text), 0),
    errors: [],
  })
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, runs.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
console.log(JSON.stringify({ cases: runs.length, output }, null, 2))
```

- [ ] **Step 3: Run vector baseline smoke**

Run:

```bash
pnpm bench:ragbench:vector
head -n 1 .bench/ragbench/runs/vector.jsonl
```

Expected: first JSONL row has `mode: "vector"` and at least one candidate.

- [ ] **Step 4: Commit**

```bash
git add bench/ragbench/retrieval/text.ts bench/ragbench/retrieval/vector-baseline.ts
git commit -m "bench: Add vector retrieval baseline" -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

### Task 5: Add docs-ssh Retrieval Runner

**Files:**
- Create: `bench/ragbench/retrieval/docs-ssh-runner.ts`

- [ ] **Step 1: Add SSH command runner**

Create `bench/ragbench/retrieval/docs-ssh-runner.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { RagbenchCase, RetrievalRun } from '../types.js'
import { tokenize } from './text.js'

function getArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function readCases(path: string): Promise<RagbenchCase[]> {
  const content = await readFile(path, 'utf8')
  return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as RagbenchCase)
}

function runRemote(sshCommand: string, remoteCommand: string): { bytes: number, stdout: string } {
  const stdout = execFileSync('sh', ['-lc', `${sshCommand} ${shellQuote(remoteCommand)}`], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  return { bytes: Buffer.byteLength(stdout), stdout }
}

function queryPattern(question: string): string {
  return tokenize(question)
    .slice(0, 8)
    .join('|') || 'the'
}

const casesPath = resolve(getArg('cases', '.bench/ragbench/cases.jsonl'))
const output = resolve(getArg('output', '.bench/ragbench/runs/docs-ssh.jsonl'))
const remoteRoot = getArg('remote-root', '/projects/ragbench/tasks/ragbench-cases')
const topK = Number(getArg('top-k', '5'))
const sshCommand = process.env.DOCS_SSH_BENCH_SSH_COMMAND
if (!sshCommand) throw new Error('Set DOCS_SSH_BENCH_SSH_COMMAND to the sshCommand returned by docs-ssh token login.')

const cases = await readCases(casesPath)
const runs: RetrievalRun[] = []

for (const entry of cases) {
  const started = Date.now()
  let commandCount = 0
  let filesRead = 0
  let bytesRead = 0
  const errors: string[] = []
  const caseRoot = `${remoteRoot}/${entry.caseId}`
  const candidates = []
  try {
    commandCount += 1
    const findResult = runRemote(sshCommand, `find ${caseRoot}/documents -name 'doc-*.md'`)
    bytesRead += findResult.bytes
    const files = findResult.stdout.trim().split('\n').filter(Boolean)
    const pattern = queryPattern(entry.question)
    commandCount += 1
    const rgResult = runRemote(sshCommand, `rg -n -i ${shellQuote(pattern)} ${caseRoot}/documents || true`)
    bytesRead += rgResult.bytes
    const hitPaths = [...new Set(rgResult.stdout.split('\n')
      .map((line) => line.split(':')[0])
      .filter((path) => path.startsWith(caseRoot)))]
    const rankedPaths = [...hitPaths, ...files.filter((path) => !hitPaths.includes(path))].slice(0, topK)
    for (const path of rankedPaths) {
      commandCount += 1
      const catResult = runRemote(sshCommand, `cat ${path}`)
      bytesRead += catResult.bytes
      filesRead += 1
      const match = /doc-(\d+)\.md$/u.exec(path)
      candidates.push({
        documentId: match?.[1] ?? path,
        path,
        score: rankedPaths.length - candidates.length,
        textPreview: catResult.stdout.slice(0, 240),
      })
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  runs.push({
    caseId: entry.caseId,
    mode: 'docs-ssh',
    question: entry.question,
    candidates,
    elapsedMs: Date.now() - started,
    commandCount,
    filesRead,
    bytesRead,
    errors,
  })
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, runs.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
console.log(JSON.stringify({ cases: runs.length, output }, null, 2))
```

- [ ] **Step 2: Run docs-ssh runner smoke**

Create a `ragbench` project and token through the viewer or CLI, then run:

```bash
export DOCS_SSH_TOKEN='dssh_...'
export DOCS_SSH_BENCH_SSH_COMMAND="$(docs-ssh token login --token "$DOCS_SSH_TOKEN" --host docs-ssh --project ragbench --json | jq -r .sshCommand)"
pnpm bench:ragbench:materialize
pnpm bench:ragbench:docs-ssh
head -n 1 .bench/ragbench/runs/docs-ssh.jsonl
```

Expected: first JSONL row has `mode: "docs-ssh"` and at least one candidate.

- [ ] **Step 3: Commit**

```bash
git add bench/ragbench/retrieval/docs-ssh-runner.ts
git commit -m "bench: Add docs-ssh retrieval runner" -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

### Task 6: Score Evidence Retrieval

**Files:**
- Create: `bench/ragbench/score.ts`

- [ ] **Step 1: Add scoring CLI**

Create `bench/ragbench/score.ts`:

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { CaseScore, RagbenchCase, RetrievalRun } from './types.js'

function getArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const content = await readFile(path, 'utf8')
  return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as T)
}

function scoreRun(run: RetrievalRun, expected: string[]): CaseScore {
  const retrieved = run.candidates.map((candidate) => candidate.documentId)
  const firstRelevantIndex = retrieved.findIndex((id) => expected.includes(id))
  return {
    caseId: run.caseId,
    mode: run.mode,
    hitAt1: retrieved.slice(0, 1).some((id) => expected.includes(id)),
    hitAt3: retrieved.slice(0, 3).some((id) => expected.includes(id)),
    hitAt5: retrieved.slice(0, 5).some((id) => expected.includes(id)),
    reciprocalRank: firstRelevantIndex >= 0 ? 1 / (firstRelevantIndex + 1) : 0,
    expectedDocumentIds: expected,
    retrievedDocumentIds: retrieved,
    elapsedMs: run.elapsedMs,
    commandCount: run.commandCount,
    filesRead: run.filesRead,
    bytesRead: run.bytesRead,
    errors: run.errors,
  }
}

const casesPath = resolve(getArg('cases', '.bench/ragbench/cases.jsonl'))
const runsPath = resolve(getArg('runs', '.bench/ragbench/runs/vector.jsonl'))
const output = resolve(getArg('output', runsPath.replace(/\.jsonl$/u, '.scores.json')))
const cases = await readJsonl<RagbenchCase>(casesPath)
const runs = await readJsonl<RetrievalRun>(runsPath)
const expectedByCase = new Map(cases.map((entry) => [entry.caseId, entry.supportingDocumentIds]))
const scores = runs.map((run) => scoreRun(run, expectedByCase.get(run.caseId) ?? []))
const summary = {
  mode: runs[0]?.mode ?? 'unknown',
  cases: scores.length,
  hitAt1: scores.filter((score) => score.hitAt1).length / scores.length,
  hitAt3: scores.filter((score) => score.hitAt3).length / scores.length,
  hitAt5: scores.filter((score) => score.hitAt5).length / scores.length,
  mrr: scores.reduce((sum, score) => sum + score.reciprocalRank, 0) / scores.length,
  avgElapsedMs: scores.reduce((sum, score) => sum + score.elapsedMs, 0) / scores.length,
  avgCommandCount: scores.reduce((sum, score) => sum + score.commandCount, 0) / scores.length,
  avgFilesRead: scores.reduce((sum, score) => sum + score.filesRead, 0) / scores.length,
  avgBytesRead: scores.reduce((sum, score) => sum + score.bytesRead, 0) / scores.length,
  errorCases: scores.filter((score) => score.errors.length > 0).length,
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify({ summary, scores }, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
```

- [ ] **Step 2: Score vector and docs-ssh runs**

Run:

```bash
pnpm bench:ragbench:score -- --runs .bench/ragbench/runs/vector.jsonl --output .bench/ragbench/runs/vector.scores.json
pnpm bench:ragbench:score -- --runs .bench/ragbench/runs/docs-ssh.jsonl --output .bench/ragbench/runs/docs-ssh.scores.json
```

Expected: both commands print `hitAt1`, `hitAt3`, `hitAt5`, `mrr`, and operational averages.

- [ ] **Step 3: Commit**

```bash
git add bench/ragbench/score.ts
git commit -m "bench: Score RAGBench evidence retrieval" -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

### Task 7: Run the First Local Benchmark and Capture Notes

**Files:**
- Modify: `bench/ragbench/README.md`
- Create: `.bench/ragbench/runs/summary.md` locally only; do not commit generated output.

- [ ] **Step 1: Run a 50-case technical-doc subset**

```bash
pnpm bench:ragbench:fetch -- --config emanual --split test --limit 50
pnpm bench:ragbench:materialize
pnpm bench:ragbench:vector
pnpm bench:ragbench:score -- --runs .bench/ragbench/runs/vector.jsonl --output .bench/ragbench/runs/vector.scores.json
```

Expected: vector baseline has non-zero `hitAt3` and writes `.bench/ragbench/runs/vector.scores.json`.

- [ ] **Step 2: Run docs-ssh path on the same cases**

```bash
export DOCS_SSH_BENCH_SSH_COMMAND="$(docs-ssh token login --token "$DOCS_SSH_TOKEN" --host docs-ssh --project ragbench --json | jq -r .sshCommand)"
pnpm bench:ragbench:materialize
pnpm bench:ragbench:docs-ssh
pnpm bench:ragbench:score -- --runs .bench/ragbench/runs/docs-ssh.jsonl --output .bench/ragbench/runs/docs-ssh.scores.json
```

Expected: docs-ssh run has zero `errorCases` and produces hit-rate metrics.

- [ ] **Step 3: Write local benchmark notes**

Create `.bench/ragbench/runs/summary.md` with:

```md
# RAGBench docs-ssh local run

Dataset: galileo-ai/ragbench
Config: emanual
Split: test
Cases: 50

## Vector baseline

```bash
jq .summary .bench/ragbench/runs/vector.scores.json
```

## docs-ssh

```bash
jq .summary .bench/ragbench/runs/docs-ssh.scores.json
```

## Interpretation

- Compare evidence hit rate first.
- Compare command count, files read, bytes read, and elapsed time second.
- Do not claim answer quality until an answer-generation scorer is added.
```

- [ ] **Step 4: Update README with final workflow**

After the first successful run, update `bench/ragbench/README.md` with exact commands and a short interpretation section based on observed metrics.

- [ ] **Step 5: Commit README refinements only**

```bash
git add bench/ragbench/README.md
git commit -m "docs: Document RAGBench benchmark workflow" -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

## Self-Review

- Scope is focused on retrieval/evidence benchmark only. Answer generation and agent write workflows are explicitly left for later.
- The first baseline is a simple local vector-space top-k model. It is deterministic, cheap, and enough to validate the harness before adding embedding providers.
- The docs-ssh runner uses real SSH commands and records operational cost signals.
- The plan avoids production server changes. If `/projects/<slug>/docs` becomes necessary later, add it as a separate product issue rather than hiding it inside the benchmark.
