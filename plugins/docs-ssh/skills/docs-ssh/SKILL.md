---
name: docs-ssh
description: Search, read, and update a docs-ssh project workspace over authenticated HTTPS. Use for project docs, issues, task results, file access, or structured text search on a configured docs-ssh instance.
---

# docs-ssh

## HTTPS workflow

- Use `docs-ssh files` for project-scoped directory listing, metadata, search, file reads and writes, and directory creation.
- The command finds the nearest `.docs-ssh.toml` from the current directory and resolves `viewer_origin` and `project` from it.
- Read the bearer credential from `DOCS_SSH_TOKEN`. Never print it, commit it, or place it in `.docs-ssh.toml`.
- Require the caller or runtime to inject `DOCS_SSH_TOKEN`; do not invoke or assume a credential manager. If the token is absent, stop and ask the caller to provide it.
- Let the command construct URLs and send the bearer credential. Do not build HTTP requests or authorization headers in the skill.
- Treat paths as relative to the project root. Reads may access the whole project; writes and directory creation are limited to `issues/` and `tasks/`.
- Report HTTP `401`, `403`, path restrictions, and read-only rules instead of attempting another transport.
- After writing, read or stat the destination to verify it.

## Commands

- List: `docs-ssh files list [path] --json`
- Stat: `docs-ssh files stat [path] --json`
- Search: `docs-ssh files search <query> [--path <path>] [--glob <glob>]... [--limit <n>] [--mode literal|regex] [--case smart|sensitive|insensitive] --json`
- Read to stdout: `docs-ssh files read <path>`
- Read to a local file: `docs-ssh files read <path> --output <local-path>`
- Write: `docs-ssh files write <path> --input <local-path|-> --json`
- Create directories: `docs-ssh files mkdir <path> --json`

Start by listing the project root and reading `README.md`:

```bash
test -n "$DOCS_SSH_TOKEN"
docs-ssh files list --json
docs-ssh files read README.md
docs-ssh files list tasks --json
docs-ssh files search keyword --path tasks --glob '*.md' --json
```

Use `--json` when consuming list, stat, search, write, or mkdir results. Search JSON contains
structured `path`, `line`, `text`, and `submatches` fields. Read writes raw file bytes to stdout
unless `--output` is given.

The API does not support delete or rename. Use `issues/` for what to do, why, status, and next
action. Use `tasks/` for research, logs, conclusions, generated artifacts, and work results.
