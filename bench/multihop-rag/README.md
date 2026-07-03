# MultiHop-RAG docs-ssh Benchmark Design

This benchmark compares whether an agent can retrieve evidence from a project
filesystem exposed by docs-ssh, versus RAG-style retrieval over the same corpus.
MultiHop-RAG is the first target because each query requires evidence spread
across multiple documents, which matches the docs-ssh use case better than
single-passage lookup.

References:

- MultiHop-RAG repository: <https://github.com/yixuantt/MultiHop-RAG>
- MultiHop-RAG paper: <https://arxiv.org/abs/2401.15391>

## Goals

- Measure evidence retrieval on a fixed corpus before measuring final answer
  quality.
- Keep the docs-ssh project corpus-only. Gold answers, gold evidence, and case
  labels stay in the benchmark harness.
- Compare shell-native agent search against RAG baselines under explicit budgets.
- Track operational cost: latency, SSH round trips, command count, bytes read,
  model calls, token usage where available, and errors.
- Make the benchmark reproducible from a clean checkout and safe to run in small
  paid batches.

## Non-goals

- This is not a live-web browsing benchmark.
- This does not try to prove vector search is obsolete. The useful comparison is
  docs-ssh agentic search against reasonable lexical, dense, and hybrid RAG
  baselines.
- FRAMES is intentionally deferred. It should reuse this harness once the
  MultiHop-RAG pipeline is stable.

## Repository Policy

Keep the benchmark harness in the repository:

- `bench/multihop-rag/*.ts`
- `bench/multihop-rag/retrieval/*.ts`
- this README
- focused unit tests for parsing, scoring, materialization, and prompt helpers

Do not commit generated benchmark state:

- `.bench/multihop-rag/raw/`
- `.bench/multihop-rag/normalized/`
- `.bench/multihop-rag/tree*/`
- `.bench/multihop-rag/cache/`
- `.bench/multihop-rag/runs/`
- `.bench/multihop-rag/agent/`
- local SSH keys, auth DBs, tokens, or API keys

This keeps the result reproducible without putting dataset snapshots, model
traces, local server state, or credentials in git.

## Data Boundary

The docs-ssh project must contain only the readable corpus:

```text
/projects/multihop-rag/
  README.md
  manifest.json
  corpus/
    news/
      <category>/
        <source>/
          <slugified-title>__<documentId>.md
```

The benchmark harness keeps all evaluation-only data outside the project:

```text
.bench/multihop-rag/
  raw/
  normalized/
    documents.jsonl
    questions.jsonl
    gold.jsonl
  tree-structured/
    corpus/news/<category>/<source>/<slugified-title>__<documentId>.md
    manifest.json
  runs/
    bm25.jsonl
    dense.jsonl
    hybrid.jsonl
    docs-ssh-direct.jsonl
    vector-agent.jsonl
    docs-ssh-agent.jsonl
  agent/
```

Gold answers and support document IDs must never be written under the
materialized corpus tree or the remote `/projects/multihop-rag/` tree.

## Normalized Types

The fetch step converts source data into stable JSONL files:

```ts
interface MultihopDocument {
  documentId: string
  title: string
  text: string
  metadata: Record<string, string | number | boolean | null>
  source: unknown
}

interface MultihopQuestion {
  caseId: string
  question: string
  queryType?: string
  metadata: Record<string, string | number | boolean | null>
  source: unknown
}

interface MultihopGold {
  caseId: string
  answer: string
  supportingDocumentIds: string[]
  supportingEvidence?: Array<{
    documentId: string
    text?: string
    metadata?: Record<string, string | number | boolean | null>
  }>
}

interface RetrievalRun {
  caseId: string
  mode:
    | 'bm25'
    | 'dense'
    | 'hybrid'
    | 'docs-ssh-direct'
    | 'vector-agent'
    | 'docs-ssh-agent'
  candidates: Array<{
    documentId: string
    rank: number
    score?: number
    path?: string
    textPreview?: string
  }>
  elapsedMs: number
  commandCount: number
  sshExecCount: number
  filesRead: number
  bytesRead: number
  modelInputTokens?: number
  modelOutputTokens?: number
  errors: string[]
}
```

Document IDs must be safe path segments. If the source ID is missing or unsafe,
derive `doc_<sha256-prefix>` from stable source fields.

## Runners

### BM25

Local deterministic baseline. This is the first baseline because it is cheap,
fast, reproducible, and stronger than naive keyword matching.

Output: ranked document IDs.

### Dense

Optional embedding baseline. The implementation should cache embeddings under
`.bench/multihop-rag/cache/` and record the embedding model in the run metadata.

Output: ranked document IDs.

Run with:

```bash
OPENAI_API_KEY=... pnpm bench:multihop:run -- \
  --mode dense \
  --limit 10 \
  --top-k 5 \
  --embedding-model text-embedding-3-small \
  --output .bench/multihop-rag/runs/dense-limit10.jsonl
```

### Hybrid

BM25 plus dense retrieval, combined with reciprocal-rank fusion. A reranker can
be added later, but it must be reported as a separate run variant.

Output: ranked document IDs.

Run with:

```bash
OPENAI_API_KEY=... pnpm bench:multihop:run -- \
  --mode hybrid \
  --limit 10 \
  --top-k 5 \
  --hybrid-candidate-k 50 \
  --output .bench/multihop-rag/runs/hybrid-limit10.jsonl
```

### Hybrid rerank

BM25 and dense retrieval are fused first, then the top candidates are reranked by
a small LLM call. This is the strongest RAG-style baseline in the current
harness, but it is also the most expensive.

Run with:

```bash
OPENAI_API_KEY=... pnpm bench:multihop:run -- \
  --mode hybrid-rerank \
  --limit 10 \
  --top-k 5 \
  --hybrid-candidate-k 50 \
  --rerank-top-n 20 \
  --rerank-model gpt-5.4-mini \
  --output .bench/multihop-rag/runs/hybrid-rerank-limit10.jsonl
```

### docs-ssh-direct

Non-agent lower-bound for docs-ssh access overhead. It uses scripted lexical
queries over SSH with `batch`, `rg`, and `read-range`. This is not the product
claim, but it tells us whether the transport and materialized tree are too slow.

Output: ranked document IDs plus command and byte metrics.

### vector-agent

Codex is given a small retrieval tool surface backed by the local RAG index:

```text
search(query, topK)
read-many(documentIds, startLine, endLine)
```

This is the fair comparison for `docs-ssh-agent`: both are agentic and both get a
bounded read API.

### docs-ssh-agent

Codex receives only the question, the docs-ssh SSH command, and the remote
project path. It should use:

```text
bootstrap --json
find
rg
read-range
batch
```

The prompt asks for a strict JSON result:

```json
{
  "candidates": [
    { "documentId": "doc_a", "reason": "...", "confidence": 0.9 },
    { "documentId": "doc_b", "reason": "...", "confidence": null }
  ]
}
```

Nested Codex runs should use an empty working directory and no project docs, so
the only corpus path is the remote docs-ssh project.

By default, `docs-ssh-agent` runs nested Codex with `workspace-write` sandboxing.
The runner copies SSH identity and known-hosts files referenced by the SSH
command into the per-case workspace before writing the `./remote` helper. This
keeps access to local benchmark gold files from being merely prompt-enforced.

## Budgets

Defaults should be small and cheap:

```text
limit: 100 for comparison runs, smaller for smoke runs
model: DOCS_SSH_BENCH_CODEX_MODEL or gpt-5.4-mini
reasoningEffort: low
maxAgentTurns: 1
maxToolCalls: 20
maxReadBytes: 60000
maxWallTimeSec: 240
topK: 5
concurrency: 4 for bulk runs, 1 or 2 for retrying failed cases
```

Large runs should be explicit:

```text
limit: 200
limit: all
```

The scorer must keep errored cases in the denominator unless the case is
structurally invalid.

## Metrics

Retrieval-only metrics:

- `hitAt1`, `hitAt5`, `hitAt10`
- `anyEvidenceRecallAtK`: at least one gold document appears in top K
- `allEvidenceRecallAtK`: every gold document appears in top K
- `evidenceRecallAtK`: fraction of gold documents recovered in top K
- `mrrAt10`
- `averagePrecisionAt10`

Operational metrics:

- average and p95 elapsed time
- average command count
- average SSH exec count
- average files read
- average bytes read
- token usage where available
- error case count and error rate

Answer-generation metrics come later:

- exact match or normalized F1
- cited evidence recall
- citation precision
- answer abstention accuracy when unsupported cases are added

## Reproduction Workflow

Fetch and normalize the first 100 valid cases:

```bash
pnpm bench:multihop:fetch -- --limit 100
```

Materialize the corpus with the structured layout used by the docs-ssh agent:

```bash
pnpm bench:multihop:materialize -- \
  --layout category-source-title \
  --output-root .bench/multihop-rag/tree-structured
```

For a local docs-ssh server backed by this repository's `.bench` workspace, copy
the corpus into the project task tree:

```bash
TARGET=.bench/multihop-rag/local-docs-ssh/workspace/tenants/local/projects/multihop-rag/tasks/multihop-rag-corpus
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -R .bench/multihop-rag/tree-structured/. "$TARGET/"
```

When starting the local server, use `DOCS_SSH_STATE_DIR`; `STATE_DIR` is ignored
by the server config:

```bash
DOCS_SSH_STATE_DIR="$PWD/.bench/multihop-rag/local-docs-ssh/state" \
WORKSPACE_DIR="$PWD/.bench/multihop-rag/local-docs-ssh/workspace" \
SSH_HOST_KEY_PATH="$PWD/.bench/multihop-rag/local-docs-ssh/state/ssh_host_key" \
EXEC_TIMEOUT=300000 \
IDLE_TIMEOUT=300000 \
SESSION_TIMEOUT=7200000 \
pnpm run dev
```

Run the deterministic baseline:

```bash
pnpm bench:multihop:run -- \
  --mode bm25 \
  --limit 100 \
  --top-k 5 \
  --output .bench/multihop-rag/runs/bm25-limit100-top5.jsonl

pnpm bench:multihop:score -- \
  --runs .bench/multihop-rag/runs/bm25-limit100-top5.jsonl \
  --output .bench/multihop-rag/runs/bm25-limit100-top5.summary.json \
  --cases-output .bench/multihop-rag/runs/bm25-limit100-top5.scores.jsonl
```

Run embedding-backed baselines. Use whichever secret wrapper is standard for the
machine, for example `envvault exec --env-file .env-openai -- ...`, or export
`OPENAI_API_KEY` directly:

```bash
pnpm bench:multihop:run -- \
  --mode dense \
  --limit 100 \
  --top-k 5 \
  --output .bench/multihop-rag/runs/dense-limit100-top5.jsonl

pnpm bench:multihop:run -- \
  --mode hybrid \
  --limit 100 \
  --top-k 5 \
  --hybrid-candidate-k 50 \
  --output .bench/multihop-rag/runs/hybrid-limit100-top5.jsonl

pnpm bench:multihop:run -- \
  --mode hybrid-rerank \
  --limit 100 \
  --top-k 5 \
  --hybrid-candidate-k 50 \
  --rerank-top-n 20 \
  --output .bench/multihop-rag/runs/hybrid-rerank-limit100-top5.jsonl
```

Run the docs-ssh agent. The SSH command can come from token login on a hosted
server or from a local test session:

```bash
SSH_COMMAND="$(docs-ssh token login \
  --token "$DOCS_SSH_TOKEN" \
  --host docs-ssh \
  --project multihop-rag \
  --json | jq -r .sshCommand)"

pnpm bench:multihop:agent -- \
  --mode docs-ssh-agent \
  --corpus-layout category-source-title \
  --limit 100 \
  --top-k 5 \
  --max-tool-calls 20 \
  --timeout-ms 240000 \
  --concurrency 4 \
  --trace-dir .bench/multihop-rag/agent/docs-ssh-agent-structured-limit100-c4 \
  --ssh-command "$SSH_COMMAND" \
  --output .bench/multihop-rag/runs/docs-ssh-agent-structured-limit100-c4.jsonl
```

If model capacity errors appear during a high-concurrency run, retry only the
failed cases with `--concurrency 1` or `--concurrency 2`, then merge the
successful retry runs back into the original JSONL before scoring.

Score a docs-ssh run:

```bash
pnpm bench:multihop:score -- \
  --runs .bench/multihop-rag/runs/docs-ssh-agent-structured-limit100-c4-filled.jsonl \
  --output .bench/multihop-rag/runs/docs-ssh-agent-structured-limit100-c4-filled.summary.json \
  --cases-output .bench/multihop-rag/runs/docs-ssh-agent-structured-limit100-c4-filled.scores.jsonl
```

## Implementation Phases

1. Add fetch and normalize. Done in this branch.
   - Download or read MultiHop-RAG data.
   - Write `documents.jsonl`, `questions.jsonl`, and `gold.jsonl`.
   - Add validation for duplicate IDs, unsafe IDs, empty evidence, and missing
     documents.

2. Add materialization. Done in this branch.
   - Write the local corpus tree.
   - Optionally stream the same corpus tree to docs-ssh with tar.
   - Write a project README and manifest that describe corpus layout only.

3. Add scoring. Done in this branch.
   - Score any run JSONL against `gold.jsonl`.
   - Print a compact JSON summary and write detailed per-case scores.

4. Add BM25 and docs-ssh-direct. BM25 is done in this branch.
   - BM25 validates metric plumbing.
   - docs-ssh-direct validates remote tree layout and round-trip cost.

5. Add vector-agent and docs-ssh-agent. Done in this branch.
   - Keep both agent prompts symmetrical.
   - Enforce budgets in the outer runner.
   - Persist prompts, model JSONL events, and final parsed JSON under
     `.bench/multihop-rag/agent/`.

6. Add dense and hybrid. Done in this branch.
   - Dense and hybrid make the baseline credible before publishing results.
   - Record index configuration in each run.

7. Add answer generation.
   - Use retrieved documents only.
   - Separate retrieval miss from reasoning miss.

8. Add FRAMES as a second dataset.
   - Reuse the same normalized schema and runner interfaces.

## Reporting

A publishable result should include:

- dataset name, source commit or snapshot, and case count
- corpus document count and total bytes
- model and reasoning settings for agentic runs
- index settings for RAG runs
- retrieval metrics table
- operational metrics table
- 5 to 10 trace examples that show how docs-ssh-agent searched
- known limitations and failed cases

Avoid claiming docs-ssh is a better retriever than RAG unless hybrid baselines are
included. The stronger claim is narrower: docs-ssh exposes project docs as a
shell-native corpus, and agentic search over that corpus can be measured against
RAG-style retrieval with the same evidence labels.

## First Smoke

On 2026-06-29, a 50-case local BM25 smoke completed against the Hugging Face
`yixuantt/MultiHopRAG` dataset:

```json
{
  "documents": 609,
  "questions": 50,
  "skippedQuestions": 9,
  "allEvidenceRecallAt10": 0.72,
  "allEvidenceRecallAt5": 0.5,
  "anyEvidenceRecallAt1": 0.86,
  "anyEvidenceRecallAt10": 0.96,
  "anyEvidenceRecallAt5": 0.94,
  "evidenceRecallAt10": 0.8683333333333333,
  "evidenceRecallAt5": 0.7566666666666667,
  "mrrAt10": 0.8966666666666667,
  "averagePrecisionAt10": 0.6919444444444447,
  "avgElapsedMs": 4.291555559999997,
  "errorCases": 0
}
```

## 2026-06-30 100-Case Result

Dataset:

- Source: `yixuantt/MultiHopRAG` from Hugging Face
- Requested cases: 100
- Materialized documents: 609
- Corpus layout: `category-source-title`
- Agent model: `gpt-5.4-mini`
- Agent reasoning effort: `low`
- Agent top K: 5
- Agent max tool calls: 20
- Agent bulk concurrency: 4

The initial `docs-ssh-agent` bulk run produced 12 errored cases. Eleven were
model capacity errors (`Selected model is at capacity`) and one timed out. The
12 failed cases were retried at `concurrency=2` and all succeeded. The table
below reports the merged error-free run.

| mode | cases | errors | any@1 | any@5 | all@5 | recall@5 | MRR@10 | avg latency | p95 latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BM25 | 100 | 0 | 0.790 | 0.960 | 0.450 | 0.741 | 0.861 | 7ms | 14ms |
| Dense | 100 | 0 | 0.560 | 0.900 | 0.370 | 0.646 | 0.699 | 850ms | 1454ms |
| Hybrid | 100 | 0 | 0.680 | 0.960 | 0.480 | 0.740 | 0.793 | 194ms | 319ms |
| Hybrid + rerank | 100 | 9 | 0.700 | 0.970 | 0.520 | 0.774 | 0.818 | 1726ms | 2647ms |
| docs-ssh agent | 100 | 0 | 0.910 | 0.990 | 0.730 | 0.884 | 0.947 | 87784ms | 168823ms |

Case-level docs-ssh agent breakdown:

- 73 cases recovered all gold evidence documents in top 5.
- 26 cases recovered at least one, but not all, gold evidence documents in top 5.
- 1 case missed every gold evidence document in top 5.

Interpretation:

- `any@5 = 0.990` means 99 of 100 cases had at least one gold evidence document
  in the top 5.
- `all@5 = 0.730` means 73 of 100 cases had every gold evidence document in the
  top 5.
- The docs-ssh agent was strongest on retrieval quality, especially multi-hop
  evidence coverage, but much slower than RAG-style baselines.
- The useful claim is not that docs-ssh is faster than RAG. It is that exposing
  project docs as a shell-native filesystem lets an agent perform strong
  multi-document retrieval without a vector index.

Context and command-output pressure:

The merged run summary includes lightweight `bytesRead` fields for selected
candidate previews, but those fields do not represent the full amount of tool
output delivered to the nested Codex agent. To estimate context pressure, inspect
the saved agent traces under `.bench/multihop-rag/agent/` and sum
`command_execution` `aggregated_output` bytes from `stdout.log`. Token counts
below use a rough `bytes / 4` approximation, not an exact tokenizer.

| metric | value |
| --- | ---: |
| Median tool output per case | 75.7 KB, approx 18.9k tokens |
| Average tool output per case | 127.6 KB, approx 31.9k tokens |
| p95 tool output per case | 368.5 KB, approx 92.1k tokens |
| Max tool output in one case | 1.45 MB, approx 361.7k tokens |
| Average command executions per case | 6.58 |
| p95 command executions per case | 12 |

Most context pressure came from broad `rg` and `rg --files` output rather than
targeted `read-range` calls:

| command kind | total output | calls |
| --- | ---: | ---: |
| `rg` | 10.8 MB | 461 |
| `read-range` | 1.55 MB | 120 |
| `find` | 0.39 MB | 70 |

This means the current result should not be described as context-efficient. The
more accurate claim is that the docs-ssh agent achieved strong retrieval quality
with high latency and a fat-tail context profile. The next benchmark improvement
should enforce a per-command output cap or truncating remote helper so broad
search commands cannot flood the agent context.
