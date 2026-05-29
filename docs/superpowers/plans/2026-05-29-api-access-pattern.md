# API Access Pattern Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project-scoped API tokens that let scripts create short-lived SSH sessions without a browser.

**Architecture:** Extend `AuthStore` with token create/list/authenticate/revoke methods, then let selected viewer API routes accept either a signed browser cookie or a valid Bearer token. Keep token power project-scoped and explicitly block Bearer tokens from project management, user management, and token management.

**Tech Stack:** TypeScript, Node 24 crypto, better-sqlite3 migrations, Vitest, React viewer, existing `fetch` CLI helpers.

---

## File Structure

- Modify `src/auth/store.ts`: schema v5, token types, token hashing, token methods, and migration.
- Modify `src/auth/store.test.ts`: token model and authorization behavior tests.
- Modify `src/viewer/server.ts`: `/api/tokens`, Bearer-token authentication, token-scoped `/api/tree`, `/api/file`, `/api/raw`, and `/api/ssh-sessions`.
- Modify `src/viewer/server.test.ts`: browser token management and Bearer SSH-session creation tests.
- Modify `viewer/src/types.ts`: token payload types.
- Modify `viewer/src/api.ts`: token create/list/revoke client helpers.
- Modify `viewer/src/App.tsx`: selected-project token panel.
- Modify `viewer/src/styles.css`: token panel styles.
- Modify `src/cli.ts`: token-backed login path.
- Modify `README.md`: document API token usage after behavior is verified.

### Task 1: AuthStore Token Model

**Files:**
- Modify: `src/auth/store.ts`
- Test: `src/auth/store.test.ts`

- [ ] **Step 1: Write failing store tests**

Add tests that create a project token, list it without plaintext, authenticate it, update `lastUsedAt`, reject wrong project, reject missing scope, and reject revoked tokens.

```ts
it('creates and authenticates project-scoped API tokens', async () => {
  const tempDir = await createTempDir()
  const authStore = createAuthStore({ dbPath: resolve(tempDir, 'auth.sqlite') })
  authStore.ensureSingleTenantOwner({ ownerLogin: 'alice', ownerName: 'Alice' })
  authStore.createProject({ displayName: 'Product Docs', slug: 'product-docs', userLogin: 'alice' })

  const created = authStore.createApiToken({
    label: 'agent token',
    projectSlug: 'product-docs',
    scopes: ['project:read', 'sources:read', 'ssh-session:create'],
    userLogin: 'alice',
  })

  expect(created.token).toMatch(/^dssh_/)
  expect(created.projectSlug).toBe('product-docs')
  expect(created.lastUsedAt).toBeNull()

  const listed = authStore.listApiTokens({ projectSlug: 'product-docs', userLogin: 'alice' })
  expect(listed).toHaveLength(1)
  expect('token' in listed[0]).toBe(false)

  const authenticated = authStore.authenticateApiToken(created.token, {
    projectSlug: 'product-docs',
    requiredScopes: ['ssh-session:create'],
  })
  expect(authenticated?.token.id).toBe(created.id)
  expect(authenticated?.principalSession.project.slug).toBe('product-docs')

  const afterUse = authStore.listApiTokens({ projectSlug: 'product-docs', userLogin: 'alice' })[0]
  expect(afterUse.lastUsedAt).toEqual(expect.any(String))

  expect(() => authStore.authenticateApiToken(created.token, { projectSlug: 'default' }))
    .toThrow('API token is not valid for project "default".')
  expect(() => authStore.authenticateApiToken(created.token, {
    projectSlug: 'product-docs',
    requiredScopes: ['project:write'],
  })).toThrow('API token is missing required scope "project:write".')

  const revoked = authStore.revokeApiToken({ id: created.id, userLogin: 'alice' })
  expect(revoked.revokedAt).toEqual(expect.any(String))
  expect(authStore.authenticateApiToken(created.token, { projectSlug: 'product-docs' })).toBeNull()
})
```

- [ ] **Step 2: Run test to verify RED**

Run: `pnpm vitest run src/auth/store.test.ts -t "project-scoped API tokens"`

Expected: TypeScript or runtime failure because `createApiToken` is not defined.

- [ ] **Step 3: Implement token schema and store methods**

Add `AUTH_SCHEMA_VERSION = 5`, add `project_id`, `scopes`, and `last_used_at` to `api_tokens`, and add a v4 to v5 migration. Add exported types:

```ts
export type AuthApiTokenScope = 'project:read' | 'project:write' | 'sources:read' | 'ssh-session:create'

export interface AuthApiToken {
  createdAt: string
  expiresAt: string | null
  id: string
  label: string | null
  lastUsedAt: string | null
  projectSlug: string
  revokedAt: string | null
  scopes: AuthApiTokenScope[]
  tenantId: string
}

export interface CreatedAuthApiToken extends AuthApiToken {
  token: string
}
```

Implement methods on `AuthStore`:

```ts
createApiToken(input: CreateApiTokenInput): CreatedAuthApiToken
listApiTokens(opts?: ListApiTokensOptions): AuthApiToken[]
authenticateApiToken(token: string, opts?: AuthenticateApiTokenOptions): AuthApiTokenSession | null
revokeApiToken(input: RevokeApiTokenInput): AuthApiToken
```

Use `randomBytes(32).toString('base64url')` for secrets and `sha256` for hashes.

- [ ] **Step 4: Run store tests to verify GREEN**

Run: `pnpm vitest run src/auth/store.test.ts`

Expected: all store tests pass.

### Task 2: Viewer Token Management and Bearer Auth

**Files:**
- Modify: `src/viewer/server.ts`
- Test: `src/viewer/server.test.ts`

- [ ] **Step 1: Write failing server tests**

Add a test that signs in as owner, creates a project token through `/api/tokens`, confirms plaintext is returned once, lists metadata without plaintext, uses `Authorization: Bearer <token>` to create an SSH session, and confirms `/api/projects` rejects the same Bearer token.

```ts
const createTokenResponse = await fetchWithCookies(`${viewer.baseUrl}/api/tokens`, jar, {
  body: JSON.stringify({
    label: 'agent token',
    project: 'product-docs',
    scopes: ['project:read', 'sources:read', 'ssh-session:create'],
  }),
  headers: { 'Content-Type': 'application/json' },
  method: 'POST',
})
expect(createTokenResponse.status).toBe(200)
const createTokenPayload = await createTokenResponse.json() as {
  token: { id: string; project: string; token: string }
}
expect(createTokenPayload.token.token).toMatch(/^dssh_/)

const bearerSessionResponse = await fetch(`${viewer.baseUrl}/api/ssh-sessions`, {
  body: JSON.stringify({
    project: 'product-docs',
    publicKey: keyPair.public,
  }),
  headers: {
    Authorization: `Bearer ${createTokenPayload.token.token}`,
    'Content-Type': 'application/json',
  },
  method: 'POST',
})
expect(bearerSessionResponse.status).toBe(200)
```

- [ ] **Step 2: Run test to verify RED**

Run: `pnpm vitest run src/viewer/server.test.ts -t "API tokens"`

Expected: 404 or 401 because `/api/tokens` and Bearer auth do not exist.

- [ ] **Step 3: Implement `/api/tokens`**

Add `isApiTokenRoute = url.pathname === '/api/tokens'`, allow POST and DELETE in the method gate, and implement:

- `GET /api/tokens?project=<slug>`: signed browser session only.
- `POST /api/tokens`: signed browser session only, owner/admin only.
- `DELETE /api/tokens?id=<id>`: signed browser session only.

Return token metadata with field names used by the viewer:

```ts
{
  createdAt,
  expiresAt,
  id,
  label,
  lastUsedAt,
  project,
  revokedAt,
  scopes,
  token // create response only
}
```

- [ ] **Step 4: Implement Bearer auth for project routes**

Add helpers:

```ts
function getBearerToken(request: IncomingMessage): string | null
function requireApiTokenScope(session: AuthApiTokenSession, scope: AuthApiTokenScope): void
```

For `/api/tree`, `/api/file`, and `/api/raw`, accept a Bearer token when no cookie session exists. Resolve the project from `?project=` or `?path=` and require `project:read`; require `sources:read` when source mounts are included.

For `POST /api/ssh-sessions`, accept either a cookie session or a Bearer token. Bearer mode requires `ssh-session:create`, forces the token project, and rejects a different requested project with 403.

- [ ] **Step 5: Run server tests**

Run: `pnpm vitest run src/viewer/server.test.ts`

Expected: all viewer server tests pass.

### Task 3: Viewer Token Panel

**Files:**
- Modify: `viewer/src/types.ts`
- Modify: `viewer/src/api.ts`
- Modify: `viewer/src/App.tsx`
- Modify: `viewer/src/styles.css`

- [ ] **Step 1: Add viewer client types and API helpers**

Add `ViewerApiToken`, `ViewerApiTokenListResponse`, and `ViewerApiTokenMutationResponse` to `viewer/src/types.ts`. Add `getApiTokens`, `createApiToken`, and `revokeApiToken` to `viewer/src/api.ts`.

- [ ] **Step 2: Add selected-project token panel**

In `viewer/src/App.tsx`, load tokens when the selected project changes and the session role is owner/admin. Add controls for label and scope checkboxes. After create, show the plaintext token in a readonly field until the next token action or project change.

- [ ] **Step 3: Add CSS**

Add compact table/panel styles to `viewer/src/styles.css`. Keep it consistent with the existing users/projects panels.

- [ ] **Step 4: Build viewer**

Run: `pnpm run build:viewer`

Expected: Vite build succeeds.

### Task 4: CLI Token Login

**Files:**
- Modify: `src/cli.ts`
- Test: add focused CLI behavior to an existing CLI-adjacent test file or add `src/cli-token.test.ts` if direct CLI testing is clearer.

- [ ] **Step 1: Add failing CLI test**

Cover token-backed SSH session creation against a fake local viewer endpoint. The CLI should send `Authorization: Bearer <token>` to `/api/ssh-sessions`, write the same `session.json` shape as browser login, and print JSON when `--json` is used.

- [ ] **Step 2: Implement CLI command**

Add `docs-ssh token login` with flags:

```text
docs-ssh token login --token <token> [--project <slug>] [--server <alias>] [--viewer-origin <url>] [--ttl-seconds <n>] [--json]
```

Generate a temporary SSH keypair exactly like `docs-ssh login`, call `POST /api/ssh-sessions` with Bearer token, and persist the resulting session file.

- [ ] **Step 3: Run CLI tests**

Run: `pnpm vitest run src/cli-token.test.ts`

Expected: token login test passes.

### Task 5: Docs and Full Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document API token flow**

Add a short `API Tokens` section after short-lived SSH sessions. Include viewer creation, token-backed CLI login, and the project-scoped limitation.

- [ ] **Step 2: Run full verification**

Run:

```bash
pnpm vitest run src/auth/store.test.ts src/viewer/server.test.ts
pnpm run build
pnpm run smoke
```

Expected: all tests pass, build succeeds, and smoke exits 0.
