# RAGBench docs-ssh Benchmark

This benchmark builds a retrieval-only comparison for RAGBench samples. It stores the
same cases as local files and, when requested, as docs-ssh task files so runners can
compare evidence-document retrieval on the same inputs.

Generated benchmark data is written under `.bench/ragbench/`. That directory is
ignored and should remain untracked.

## Local Workflow

Fetch a 50-case technical-doc sample:

```bash
pnpm bench:ragbench:fetch -- --config emanual --split test --limit 50
```

Materialize it locally:

```bash
pnpm bench:ragbench:materialize
```

Fetch writes `.bench/ragbench/cases.jsonl`. Materialization reads that JSONL file
and writes:

- `.bench/ragbench/tree/cases/<caseId>/question.md`
- `.bench/ragbench/tree/cases/<caseId>/documents/doc-<document.id>.md`

`question.md` omits the reference answer and support-document labels by default
so agentic runs cannot read the answer key. Pass `--include-labels` only for
debugging generated cases.

Run the local vector baseline:

```bash
pnpm bench:ragbench:vector
```

Score the vector baseline:

```bash
pnpm bench:ragbench:score -- --runs .bench/ragbench/runs/vector.jsonl --output .bench/ragbench/runs/vector.scores.json
```

The score command writes `.bench/ragbench/runs/vector.scores.json` and prints the
summary to stdout.

## Optional docs-ssh Run

The docs-ssh runner needs a project-scoped SSH command in
`DOCS_SSH_BENCH_SSH_COMMAND`. Create a token session for the `ragbench` project
and export the returned `sshCommand` value. `$DOCS_SSH_TOKEN` must be valid for
that project and include `ssh-session:create`, `project:read`, and
`project:write`.

```bash
export DOCS_SSH_BENCH_SSH_COMMAND="$(
  docs-ssh token login --token "$DOCS_SSH_TOKEN" --host docs-ssh --project ragbench --json | jq -r .sshCommand
)"
```

With that variable set, materialize again so the same cases are written to the
remote tree, run docs-ssh retrieval, and score it:

```bash
pnpm bench:ragbench:materialize
pnpm bench:ragbench:docs-ssh
pnpm bench:ragbench:score -- --runs .bench/ragbench/runs/docs-ssh.jsonl --output .bench/ragbench/runs/docs-ssh.scores.json
```

Remote materialization streams generated local case batches over SSH with
`tar -xf -`, so the target server must support non-interactive SSH exec stdin.
Batches default to 900 KiB via `--remote-batch-bytes`, keeping each stdin stream
below the server's default 1 MiB limit.

The default remote root is `/projects/ragbench/tasks/ragbench-cases`. If you use a
different project or remote root, the token/session project must match the
`/projects/<project>/...` remote root, and the root must be passed to both
materialization and retrieval:

```bash
pnpm bench:ragbench:materialize -- --remote-root /projects/ragbench/tasks/ragbench-cases
pnpm bench:ragbench:docs-ssh -- --remote-root /projects/ragbench/tasks/ragbench-cases
```

## Agentic Runs

Agentic runs use Codex per case and score the document IDs returned by the agent.
Set the model explicitly if needed:

```bash
export DOCS_SSH_BENCH_CODEX_MODEL=gpt-5.4-mini
```

The vector-agent mode gives Codex a vector search/read tool. It does not expose
support labels:

```bash
pnpm bench:ragbench:agent:vector -- --limit 10
pnpm bench:ragbench:score -- --runs .bench/ragbench/runs/vector-agent.jsonl
```

The docs-ssh-agent mode gives Codex the docs-ssh SSH command and asks it to
inspect only the case's `documents/` directory:

```bash
export DOCS_SSH_BENCH_SSH_COMMAND="$(
  docs-ssh token login --token "$DOCS_SSH_TOKEN" --host docs-ssh --project ragbench --json | jq -r .sshCommand
)"

pnpm bench:ragbench:materialize
pnpm bench:ragbench:agent:docs-ssh -- --limit 10
pnpm bench:ragbench:score -- --runs .bench/ragbench/runs/docs-ssh-agent.jsonl
```

Agentic runs default to `--limit 10` because they make one Codex call per case.
Use `--limit all` or a larger number for longer paid runs. Per-case prompts and
final model messages are written under `.bench/ragbench/agent/`. The runner also
defaults Codex reasoning effort to `low` for throughput; override with
`--reasoning-effort <value>` or `DOCS_SSH_BENCH_CODEX_REASONING_EFFORT`.
It also treats each case as a one-turn run by default and sets a tool-call budget
of 8. Override with `--max-turns <n>` and `--max-tool-calls <n>` when you need a
different budget. Codex CLI does not expose a native turn-limit flag here, so the
runner records Codex JSONL events and marks a case as errored if the budget is
exceeded.
Nested Codex runs use `--ignore-user-config`, `--ignore-rules`, and `--ephemeral`
so global skills or project rules do not replace the benchmark-provided retrieval
interface. For the cleanest run, point `--codex-home` or
`DOCS_SSH_BENCH_CODEX_HOME` at a temporary Codex home that contains auth but no
skills or plugins. The docs-ssh-agent mode also defaults its nested Codex working
directory to an empty trace workspace so it cannot fall back to local materialized
files.

## Interpretation

Compare evidence hit rates first: `hitAt1`, `hitAt3`, `hitAt5`, and `mrr` measure
whether retrieved document IDs match the extracted RAGBench support labels.
Operational metrics such as `avgElapsedMs`, `avgCommandCount`, `avgFilesRead`, and
`avgBytesRead` are secondary and help explain cost and behavior.

For `*-agent` modes, `avgElapsedMs` includes the Codex call. Command and byte
counts are approximate because the outer runner cannot reliably observe every
tool command the model chose to run.

These runs do not evaluate answer quality. They only score retrieval against the
available support-document labels. If those labels are absent or incomplete, cases
may be skipped or hit rates may understate useful retrieval.

## First Local Smokes

On 2026-06-25, the 50-case `emanual` test workflow completed locally:

```json
{
  "mode": "vector",
  "cases": 50,
  "skippedCases": 0,
  "scoredCases": 50,
  "hitAt1": 0.66,
  "hitAt3": 1,
  "hitAt5": 1,
  "mrr": 0.8066666666666665,
  "avgElapsedMs": 0.26,
  "avgCommandCount": 0,
  "avgFilesRead": 3,
  "avgBytesRead": 2948.94,
  "errorCases": 0
}
```

The same day, a 10-case `emanual` test comparison completed with real docs-ssh
retrieval against `/projects/default/tasks/ragbench-cases-10`.

Vector baseline:

```json
{
  "mode": "vector",
  "cases": 10,
  "skippedCases": 0,
  "scoredCases": 10,
  "hitAt1": 0.4,
  "hitAt3": 1,
  "hitAt5": 1,
  "mrr": 0.6666666666666666,
  "avgElapsedMs": 0.3,
  "avgCommandCount": 0,
  "avgFilesRead": 3,
  "avgBytesRead": 3078.7,
  "errorCases": 0
}
```

docs-ssh:

```json
{
  "mode": "docs-ssh",
  "cases": 10,
  "skippedCases": 0,
  "scoredCases": 10,
  "hitAt1": 0.6,
  "hitAt3": 1,
  "hitAt5": 1,
  "mrr": 0.7666666666666666,
  "avgElapsedMs": 6242.7,
  "avgCommandCount": 5,
  "avgFilesRead": 3,
  "avgBytesRead": 3123.7,
  "errorCases": 0
}
```
