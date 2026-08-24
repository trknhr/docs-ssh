---
name: docs-ssh
description: Search, read, and update a docs-ssh project workspace over authenticated HTTPS. Use for project docs, issues, task results, file access, or structured text search on a configured docs-ssh instance.
---

# docs-ssh

## Resolve the project

Starting from the current directory, find the nearest `.docs-ssh.toml` and read:

- `viewer_origin` as the HTTPS origin.
- `project` as the project slug.

Use the configured project for every request. Access the project only through the HTTPS Files API.

## HTTPS authentication

Read the bearer credential from `DOCS_SSH_TOKEN`. Never print it, commit it, place it in
`.docs-ssh.toml`, or use a verbose HTTP client.

Require the caller or runtime to inject `DOCS_SSH_TOKEN`. Do not invoke or assume a particular
credential manager. If the token is absent, stop and ask the caller to provide it.

Send the Authorization header through curl config on stdin so the token is not included in curl's
command arguments:

```bash
export DOCS_SSH_ORIGIN='<viewer_origin from .docs-ssh.toml>'
export DOCS_SSH_PROJECT='<project from .docs-ssh.toml>'

test -n "$DOCS_SSH_TOKEN"
docs_http() {
  printf "header = \"Authorization: Bearer %s\"\n" "$DOCS_SSH_TOKEN" |
    curl --config - --fail-with-body --silent --show-error "$@"
}

base="$DOCS_SSH_ORIGIN/api/v1/projects/$DOCS_SSH_PROJECT"
docs_http "$base/entries"
docs_http --get "$base/search" \
  --data-urlencode "q=keyword" \
  --data-urlencode "path=tasks" \
  --data-urlencode "glob=*.md"
```

Do not use stdin as an upload body while curl config also uses stdin; upload from a file with
`--data-binary @<file>`.

## HTTP Files API

All paths are project-relative. URL-encode project names, paths, queries, and globs; use
`--get --data-urlencode` for query parameters.

- List: `GET /api/v1/projects/:project/entries?path=:path`
- Stat: `GET /api/v1/projects/:project/stat?path=:path`
- Search: `GET /api/v1/projects/:project/search?q=:query`
- Read: `GET /api/v1/projects/:project/files/:path`
- Write: `PUT /api/v1/projects/:project/files/:path` with raw bytes
- Create directories: `POST /api/v1/projects/:project/directories` with
  `{"path":"tasks/example"}`

For search, optional parameters are `path`, repeated `glob`, `limit`, `mode=literal|regex`, and
`case=smart|sensitive|insensitive`. Consume structured `path`, `line`, `text`, and `submatches`
fields rather than parsing shell output.

Start by listing the project root and reading `README.md`. Reads may access the whole project.
Writes and directory creation are limited to `issues/` and `tasks/`; generated README files are
read-only. The API does not support delete or rename. After writing, read or stat the destination
to verify it.

Use `issues/` for what to do, why, status, and next action. Use `tasks/` for research, logs,
conclusions, generated artifacts, and work results.
