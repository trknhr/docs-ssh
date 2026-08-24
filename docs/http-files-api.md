# HTTP Files API

The HTTP Files API gives agents byte-oriented access to the same project workspace exposed over
SSH and in the Viewer. It is served from the Viewer origin under `/api/v1`.

## Authentication

Every request requires a project-scoped API token:

```http
Authorization: Bearer dssh_...
```

The project slug in the URL must match the token's project. Read operations accept
`project:read` or `project:write`; mutating operations require `project:write`.

## CLI

The `docs-ssh files` command resolves `viewer_origin` and `project` from the nearest
`.docs-ssh.toml` and reads the token from `DOCS_SSH_TOKEN`:

```bash
docs-ssh files list [path] --json
docs-ssh files stat [path] --json
docs-ssh files search <query> --path <path> --glob '*.md' --json
docs-ssh files read <path> [--output <local-path>]
docs-ssh files write <path> --input <local-path|-> --json
docs-ssh files mkdir <path> --json
```

Use repeated `--glob` flags for multiple search filters. `read` emits raw bytes when `--output`
is omitted. The remaining sections describe the underlying HTTP contract.

## Endpoints

Paths are relative to the selected project root. For example, the HTTP path
`tasks/demo/result.md` and the SSH path `/projects/default/tasks/demo/result.md` refer to the same
file when the selected project is `default`.

| Operation | Method and path | Request body |
| --- | --- | --- |
| List a directory | `GET /api/v1/projects/:project/entries?path=:path` | None |
| Get metadata | `GET /api/v1/projects/:project/stat?path=:path` | None |
| Search text | `GET /api/v1/projects/:project/search?q=:query` | None |
| Read bytes | `GET /api/v1/projects/:project/files/:path` | None |
| Read byte metadata | `HEAD /api/v1/projects/:project/files/:path` | None |
| Write bytes | `PUT /api/v1/projects/:project/files/:path` | Raw bytes |
| Create directories | `POST /api/v1/projects/:project/directories` | `{"path":"tasks/demo/artifacts"}` |

Omit `path` from `entries` or `stat` to address the project root. Directory creation is recursive.
`PUT` returns `201` for a new file and `200` when replacing one. File reads use
`application/octet-stream` so text and binary content follow the same contract.

Example metadata response:

```json
{
  "entry": {
    "modifiedAt": "2026-08-17T06:00:00.000Z",
    "name": "result.md",
    "path": "tasks/demo/result.md",
    "size": 42,
    "type": "file"
  },
  "project": "default"
}
```

## Search

Search stays inside the selected project and returns structured matches rather than shell output:

```http
GET /api/v1/projects/default/search?q=needle&path=tasks&mode=literal&case=smart&glob=*.md&limit=100
```

| Parameter | Default | Description |
| --- | --- | --- |
| `q` | Required | Search query, up to 512 UTF-8 bytes. |
| `path` | Project root | Directory to search, relative to the project root. |
| `mode` | `literal` | `literal` for fixed text or `regex` for a regular expression. |
| `case` | `smart` | `smart`, `sensitive`, or `insensitive`. |
| `glob` | None | Optional file glob. Repeat the parameter to provide multiple globs. |
| `limit` | `100` | Global match limit from 1 to 500. |

Example response:

```json
{
  "case": "smart",
  "limit": 100,
  "matches": [
    {
      "line": 12,
      "path": "tasks/demo/result.md",
      "submatches": [
        { "end": 16, "start": 10, "text": "needle" }
      ],
      "text": "Found the needle in this result."
    }
  ],
  "mode": "literal",
  "path": "tasks",
  "project": "default",
  "query": "needle",
  "truncated": false
}
```

`start` and `end` are zero-based offsets within the returned line text. A search with no matches
returns `200` with an empty `matches` array. `truncated` is `true` when more matches exist than the
requested limit.

The current backend runs the sandboxed `just-bash` `rg` command with structured JSON output. The
HTTP contract does not expose raw `rg` flags so the backend can later move to an index without
changing clients. Searches include hidden files, ignore repository ignore files, skip binary files,
exclude in-flight HTTP upload files, and do not follow symbolic links.

## Path and write rules

- API paths must be relative, use forward slashes, and cannot contain `.` or `..` segments.
- Reads and listings stay within the token's project workspace.
- Writes and directory creation are limited to `issues/` and `tasks/`.
- Generated `README.md` files at the project root and directly below `issues/` and `tasks/` are
  read-only.
- Symbolic links are not followed by this API.
- File bodies are limited to 16 MiB.
- Writes stream to a temporary file and replace the destination atomically after the upload
  succeeds. A failed or oversized replacement leaves the previous file intact.

Errors use a stable JSON envelope:

```json
{
  "error": {
    "code": "insufficient_scope",
    "message": "API token is missing required scope \"project:write\"."
  }
}
```

Delete, rename, conditional writes, resumable uploads, and ETags are not part of this first slice.
