# RAGBench docs-ssh Benchmark

This benchmark builds a retrieval-only comparison for RAGBench samples. Phase 1 stores the same cases as local files and, when requested, as docs-ssh task files so later runners can compare evidence-document retrieval on the same inputs.

Generated benchmark data is written under `.bench/ragbench/` and should remain untracked.

## Quick Run

Fetch a small sample:

```bash
pnpm bench:ragbench:fetch -- --config emanual --split test --limit 50
```

Materialize it locally:

```bash
pnpm bench:ragbench:materialize
```

Fetch writes `.bench/ragbench/cases.jsonl`. Materialization reads that JSONL file and writes:

- `.bench/ragbench/tree/cases/<caseId>/question.md`
- `.bench/ragbench/tree/cases/<caseId>/documents/doc-<document.id>.md`

To also write the same tree through docs-ssh, export a project-scoped SSH command first:

```bash
export DOCS_SSH_BENCH_SSH_COMMAND='ssh -i /path/to/id_ed25519 sess_xxx@docs-ssh'
pnpm bench:ragbench:materialize
```

The default remote root is `/projects/ragbench/tasks/ragbench-cases`. Override paths with:

```bash
pnpm bench:ragbench:materialize -- --cases .bench/ragbench/cases.jsonl --local-root .bench/ragbench/tree/cases --remote-root /projects/ragbench/tasks/ragbench-cases
```

Later tasks add the vector baseline, docs-ssh retrieval runner, and scoring commands.
