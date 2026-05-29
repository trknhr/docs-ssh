# API Access Pattern Design

## Context

`v0.2.0-api-access-pattern` needs a non-browser access path for scripts,
agents, and integrations. The existing auth schema already has an unused
`api_tokens` table, while viewer routes currently rely on signed web session
cookies. The first useful consumer is creating a short-lived SSH session without
opening the browser.

## Decision

Use project-scoped API tokens only for v0.2.0.

An API token is bound to one tenant project and one owning user principal. It cannot
create, update, archive, or list-manage projects outside that project context,
and it cannot manage users. This keeps leaked-token blast radius limited to the
selected project and selected scopes.

## Token Model

- Store only a token hash in SQLite.
- Show the plaintext token exactly once after creation.
- Track label, project, scopes, created time, optional expiry, revoked time, and
  last successful use time.
- Use these scopes:
  - `project:read`
  - `project:write`
  - `sources:read`
  - `ssh-session:create`
- Reject expired or revoked tokens with 401.
- Reject scope mismatches or project mismatches with 403.

## API Surface

Browser session endpoints:

- `GET /api/tokens?project=<slug>` lists current user's tokens for a project.
- `POST /api/tokens` creates a token for a selected project.
- `DELETE /api/tokens?id=<id>` revokes a token owned by the current user.

Bearer token endpoints:

- `/api/tree`
- `/api/file`
- `/api/raw`
- `POST /api/ssh-sessions`

Bearer tokens are not accepted for `/api/projects`, `/api/users`, token
management, or any tenant-wide operation.

## CLI Flow

Add a small token-backed client path after the server-side model works.

- Save a server origin, project slug, and API token in local config.
- Use that token to request a short-lived SSH session for the selected project.
- Keep browser login as the default path for interactive users.

## Viewer Flow

Add a selected-project token panel for signed-in owners and admins:

- Create token with label, scopes, and optional expiry.
- Show plaintext token once after creation.
- List token metadata without exposing hashes or plaintext.
- Revoke tokens.

## Testing

- Store tests cover create, list, authenticate, expiry, revoke, project mismatch,
  scope mismatch, and last-use updates.
- Viewer server tests cover browser token management and Bearer token access to
  SSH session creation.
- CLI tests cover storing token config and using it to create an SSH session
  once the server route exists.
