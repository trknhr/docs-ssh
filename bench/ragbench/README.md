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

The default remote root is `/projects/ragbench/tasks/ragbench-cases`. If you use a
different project or remote root, the token/session project must match the
`/projects/<project>/...` remote root, and the root must be passed to both
materialization and retrieval:

```bash
pnpm bench:ragbench:materialize -- --remote-root /projects/ragbench/tasks/ragbench-cases
pnpm bench:ragbench:docs-ssh -- --remote-root /projects/ragbench/tasks/ragbench-cases
```

## Interpretation

Compare evidence hit rates first: `hitAt1`, `hitAt3`, `hitAt5`, and `mrr` measure
whether retrieved document IDs match the extracted RAGBench support labels.
Operational metrics such as `avgElapsedMs`, `avgCommandCount`, `avgFilesRead`, and
`avgBytesRead` are secondary and help explain cost and behavior.

These runs do not evaluate answer quality. They only score retrieval against the
available support-document labels. If those labels are absent or incomplete, cases
may be skipped or hit rates may understate useful retrieval.

## First Local Smoke

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

The docs-ssh run was skipped for that smoke because
`DOCS_SSH_BENCH_SSH_COMMAND` was not set in the shell.
