# docs-ssh

Use a project workspace over SSH and a read-only browser viewer.

`docs-ssh` is a local-first derivative of `supabase-community/supabase-ssh`. It keeps
the SSH plus `just-bash` sandbox core, but turns the server into a project workspace
with private notes, issue records, task results, and a read-only web viewer.

## Status

Current scope:

- provide `/home` for private notes and `/projects/<slug>/issues` plus `/projects/<slug>/tasks` for project work
- provide `/tmp` for temporary session-local files
- provide a read-only browser viewer for authenticated project files

Deferred:

- external documentation/source ingestion UX
- HTML/help-center crawling
- hosted-service telemetry and rate limiting

## Quick Start

1. Clone the repository:

   ```bash
   git clone https://github.com/trknhr/docs-ssh.git
   cd docs-ssh
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Build the server CLI and viewer assets once:

   ```bash
   pnpm run build
   ```

4. Link the local CLI into your PATH:

   ```bash
   npm link
   docs-ssh status --json
   ```

   `npm link` creates the global `docs-ssh` command for the cloned repo. The linked command uses `dist/src/cli.js`, so rerun `pnpm run build:server` after editing CLI or server TypeScript.

5. Generate a host key manually if you want to precreate one:

   ```bash
   pnpm run generate:host-key:local
   ```

   If you skip this step, `docs-ssh` will generate `./ssh_host_key` automatically on first boot.

6. Start the server:

   ```bash
   pnpm run dev
   ```

   This starts the SSH server on `localhost:2222` and the viewer on `localhost:3000`.
   If a repo-local `.env` file exists, `docs-ssh` loads it automatically on startup.

   If you want reload-on-save locally, use:

   ```bash
   pnpm run dev:watch
   ```

   If you change files under `viewer/`, rerun `pnpm run build:viewer` before refreshing the browser.

7. Connect from another terminal:

   ```bash
   ssh localhost -p 2222
   ssh localhost -p 2222 bootstrap --json
   ssh localhost -p 2222 ls /projects/<slug>/issues
   ```

8. Open the read-only viewer in a browser:

   ```bash
   # macOS
   open http://localhost:3000

   # Linux
   xdg-open http://localhost:3000
   ```

   The viewer exposes a VS Code-like file tree plus a preview pane for markdown, text/code, and images.
   If OIDC is configured, the top bar also exposes sign-in and sign-out controls for the web session.

## Release Smoke

Before tagging a v0.1.0 build, run the automated smoke script:

```bash
pnpm run smoke
```

This runs the Vitest suite, builds the server and viewer, then verifies the built CLI can execute `status --json`.

Manual release checks still matter for the browser and SSH path:

- sign in through the viewer, select a project, copy `.docs-ssh.toml`, open a raw file, sign out, and reload
- run `docs-ssh login --json`, use the returned `sshCommand`, run `bootstrap --json`, list `/projects/<slug>/issues`, write a task note, and read it back
- confirm the OIDC redirect URI matches the configured viewer origin

## SSH Config Alias

If you plan to distribute a reusable skill file to users, configure a stable SSH alias on the client side instead of hardcoding a host name into the skill content.

Example for a local server:

```sshconfig
Host docs-ssh
  HostName 127.0.0.1
  Port 2222
```

Example for a self-hosted server on your LAN or Tailscale network:

```sshconfig
Host docs-ssh
  HostName <server-host-or-ip>
  Port 2222
```

After that, users can connect and run helper commands through the same alias:

```bash
ssh docs-ssh
ssh docs-ssh bootstrap --json
ssh docs-ssh ls /projects/<slug>/tasks
```

The distributable skill file at `skills/SKILL.md` assumes this alias-based setup. If you prefer a different alias, update both the SSH config entry and the commands in the copied skill.

## Agent Helper Files

Inside an SSH session, `docs-ssh` exposes helper commands:

- `bootstrap --json` prints the current tenant, principal, project, paths, and scopes as a machine-readable session manifest
- `agents` prints a short instructions snippet for `AGENTS.md` or similar tool instruction files
- `skill` prints a reusable `SKILL.md`
- `setup` prints the setup guide with suggested installation paths

You can generate the same content locally from the repo:

```bash
pnpm run helper:agents
pnpm run helper:skill
pnpm run helper:setup
pnpm run agents:append
pnpm run skill:write
```

The checked-in skill expects the `docs-ssh` CLI to be available in `PATH`. For local development, run `pnpm run build` and `npm link` from the cloned repo before installing the skill.

## Container

You can run `docs-ssh` in Docker and keep the auth database, workspace, and host key on disk.

```bash
docker compose up --build -d
ssh localhost -p 2222 bootstrap --json
```

Then open `http://localhost:3000` in a browser.

The included `docker-compose.yml` mounts:

- `./docs` -> `/data/docs` as the optional local docs seed directory
- `./.docs-ssh` -> `/data/state` for auth state, registry state, the generated host key, and the default workspace

Useful container commands:

```bash
docker compose exec docs-ssh node dist/src/cli.js status --json
docker compose exec docs-ssh node dist/src/cli.js auth list-projects
docker compose restart docs-ssh
```

If you want to run the image without Compose, the image works with bundled sample docs by default:

```bash
docker build -t docs-ssh .
docker run --rm -p 2222:2222 -p 3000:3000 docs-ssh
```

## Self-Hosting

For a home server, use the versioned container image and the dedicated self-hosting compose file so docs, state, and workspace live on separate host paths. A hosting server does not need to clone this repository.

```bash
mkdir -p /srv/docs-ssh
cd /srv/docs-ssh

DOCS_SSH_VERSION=v0.1.0
curl -fsSLO "https://raw.githubusercontent.com/trknhr/docs-ssh/${DOCS_SSH_VERSION}/docker-compose.selfhost.yml"
curl -fsSLO "https://raw.githubusercontent.com/trknhr/docs-ssh/${DOCS_SSH_VERSION}/.env.selfhost.example"
cp .env.selfhost.example .env.selfhost
```

The self-hosting config uses:

- `DOCS_SSH_IMAGE` for the published container image, default `ghcr.io/trknhr/docs-ssh:v0.1.0`
- `DOCS_SSH_DOCS_DIR` for the optional local docs seed directory
- `DOCS_SSH_STATE_DIR` for auth state, registry state, and the SSH host key
- `DOCS_SSH_WORKSPACE_DIR` for the persistent structured filesystem backing `/home` and `/projects`
- `DOCS_SSH_BIND_IP` to control whether the SSH port binds only to localhost or to your LAN interface
- `DOCS_SSH_VIEWER_BIND_IP` to control whether the HTTP viewer binds only to localhost or to your LAN interface
- `DOCS_SSH_VIEWER_PORT` to control the HTTP viewer port
- `VIEWER_PUBLIC_ORIGIN` for the public HTTPS viewer URL when the viewer is behind a proxy or tunnel

Example: expose SSH on `2222` and the viewer on `3000` to your LAN.

```bash
cat > .env.selfhost <<'EOF'
DOCS_SSH_BIND_IP=0.0.0.0
DOCS_SSH_PORT=2222
DOCS_SSH_VIEWER_BIND_IP=0.0.0.0
DOCS_SSH_VIEWER_PORT=3000
DOCS_SSH_IMAGE=ghcr.io/trknhr/docs-ssh:v0.1.0
DOCS_SSH_DOCS_DIR=/srv/docs-ssh/docs
DOCS_SSH_STATE_DIR=/srv/docs-ssh/state
DOCS_SSH_WORKSPACE_DIR=/srv/docs-ssh/workspace
# VIEWER_PUBLIC_ORIGIN=https://docs.example.com
EOF

mkdir -p /srv/docs-ssh/docs /srv/docs-ssh/state /srv/docs-ssh/workspace
docker compose -f docker-compose.selfhost.yml --env-file .env.selfhost up -d
```

After startup:

```bash
ssh <server-ip> -p 2222
```

Then open `http://<server-ip>:3000` in a browser.

### Self-Hosted Client SSH Config

Pick one stable SSH host name and publish it with your hosting notes. It is usually the same DNS name or Tailscale name users use for the viewer, but it can be a separate SSH-only host name.

If SSH port `2222` is reachable directly from the client, for example because `DOCS_SSH_BIND_IP=0.0.0.0` and your firewall allows TCP `2222`, users can add:

```sshconfig
Host docs-ssh
  HostName docs.example.com
  Port 2222
  StrictHostKeyChecking accept-new
```

If the viewer is public but SSH stays private on the server, keep `DOCS_SSH_BIND_IP=127.0.0.1` and have users connect through their normal server SSH account:

```sshconfig
Host docs-ssh
  HostName 127.0.0.1
  Port 2222
  ProxyJump user@docs.example.com
  HostKeyAlias docs-ssh-docs-example
  StrictHostKeyChecking accept-new
```

For Tailscale, use the server's tailnet name as the SSH host. Tailscale Funnel can publish the HTTPS viewer, but it does not publish the docs-ssh SSH port; users still need direct tailnet access, a firewall-opened TCP `2222`, or a `ProxyJump` tunnel for SSH.

After adding the alias, users can verify the SSH path:

```bash
ssh docs-ssh bootstrap --json
```

Repo-local client config can point the CLI at both the SSH alias and the public viewer URL:

```toml
# .docs-ssh.toml
server = "docs-ssh"
project = "default"
viewer_origin = "https://docs.example.com"
```

Security note: SSH access is now gated by public keys stored in `auth.sqlite`. The HTTP viewer remains read-only by default, but if your docs are sensitive you should still keep both SSH and the viewer on localhost, your LAN, or behind a private network like Tailscale.

Release images are published by the tag workflow to GitHub Container Registry. For v0.1.0 the hosting image is `ghcr.io/trknhr/docs-ssh:v0.1.0`.

## Filesystem Layout

`docs-ssh` seeds a v2 SSH filesystem with private notes, project work, and temporary areas:

```text
/
  README.md
  home/
    README.md
  projects/
    <project>/
      README.md
      issues/
      tasks/
  tmp/
```

From the SSH session, use `/home` for private personal notes, `/projects/<slug>/issues` for issue records, `/projects/<slug>/tasks/<task-slug>/` for research and work results, and `/tmp` for temporary files.

## Configuration

If a repo-local `.env` file exists, both the server entrypoint and the CLI load it automatically before reading these variables.

- `DOCS_DIR`: optional local docs seed directory, default `./docs`
- `DOCS_NAME`: label shown in banners and helper files, default `Documentation`
- `DOCS_SSH_STATE_DIR`: auth, registry, and host-key state dir, default `./.docs-ssh`
- `DOCS_SSH_REGISTRY_PATH`: optional explicit registry file path
- `DOCS_SSH_AUTH_DB_PATH`: auth metadata database path, default `<DOCS_SSH_STATE_DIR>/auth.sqlite`
- `DOCS_SSH_OIDC_ISSUER`: optional OIDC issuer URL for web sign-in
- `DOCS_SSH_OIDC_CLIENT_ID`: optional OIDC client ID for web sign-in
- `DOCS_SSH_OIDC_CLIENT_SECRET`: optional OIDC client secret for web sign-in
- `DOCS_SSH_OIDC_PROVIDER`: auth identity provider label used in `auth_identities`, default `oidc`
- `DOCS_SSH_OIDC_SCOPE`: OIDC scope for web sign-in, default `openid email profile`
- `WORKSPACE_DIR`: persistent structured filesystem dir, default `./.docs-ssh/workspace`
- `SSH_PORT`: SSH port to listen on, default `2222`
- `SSH_HOST`: interface to bind, default `127.0.0.1`
- `SSH_CONNECT_HOST`: optional host name used in generated helper files, default `SSH_HOST` or `127.0.0.1`
- `SSH_CONNECT_PORT`: optional port used in generated helper files, default `SSH_PORT`
- `VIEWER_PORT`: HTTP viewer port, default `3000`
- `VIEWER_HOST`: HTTP viewer bind interface, default `127.0.0.1`
- `VIEWER_PUBLIC_ORIGIN`: optional public HTTPS origin used for OIDC callback URLs when the viewer is behind a proxy
- `VIEWER_DIST_DIR`: built viewer asset directory, default `./viewer-dist`
- `SSH_HOST_KEY_PATH`: host key path, default `./ssh_host_key`
- `SSH_HOST_KEY`: optional PEM-encoded host key content that overrides `SSH_HOST_KEY_PATH`
- `IDLE_TIMEOUT`: idle session timeout in ms, default `60000`
- `SESSION_TIMEOUT`: max session duration in ms, default `600000`
- `EXEC_TIMEOUT`: per-command timeout in ms, default `10000`

## Auth Bootstrap

v0.1.0 is tenant-aware but optimized for one default tenant in a single deployment. The database and filesystem paths already carry tenant boundaries, but multi-tenant admin UX, tenant switching, invitations, and service-account management are planned for v0.2.0 and later.

For a v0.1.0 single-tenant VPS setup, bootstrap one default tenant plus one owner principal in the local auth database:

```bash
docs-ssh auth init
docs-ssh auth add-ssh-key ~/.ssh/id_ed25519.pub
docs-ssh auth add-web-identity \
  --provider oidc \
  --issuer https://accounts.google.com \
  --subject <oidc-subject>
```

Defaults:

- the auth DB lives at `.docs-ssh/auth.sqlite`
- `auth init` creates tenant slug `default`
- `auth init` creates owner login `owner`

You can override these with CLI flags such as `--db-path`, `--tenant-slug`, `--owner-login`, and `--owner-name`. The older `--instance-slug` and `--instance-name` flags are still accepted as aliases for existing scripts.

`auth add-web-identity` is the prelink step for web sign-in: the OIDC callback only creates a viewer session when the incoming `(provider, issuer, subject)` tuple already exists in `auth_identities`.

If `auth.sqlite` is still empty, the first successful web OIDC sign-in auto-creates a single-tenant owner user and links that identity immediately. Use `auth init` when you want to choose the owner login or bootstrap the auth DB ahead of time.

## Users

One running docs-ssh instance represents one tenant. After the first owner exists, new web users cannot self-register automatically.

Owners can add users from the signed-in viewer Account panel. Use the provider, issuer, and subject shown on the new user's access-request page, choose a login and role, then add the user. The same operation is available from the operator CLI:

```bash
docs-ssh auth add-web-identity \
  --provider google \
  --issuer https://accounts.google.com \
  --subject <oidc-subject> \
  --user <login>
```

## Projects

Projects are server-managed resources. Create them from the signed-in web viewer or with the operator CLI; agents and local config files only select an existing project.

```bash
docs-ssh auth create-project \
  --project slack-ai-assistant-agentcore-migration \
  --display-name "Slack AI assistant AgentCore migration"
docs-ssh auth list-projects
```

To make a local work directory select a project by default, place `.docs-ssh.toml` in that directory or one of its parents:

```toml
server = "docs-ssh"
viewer_origin = "https://docs.example.com"
project = "slack-ai-assistant-agentcore-migration"
```

For local development, `server = "docs-ssh-local"` defaults the viewer origin to `http://localhost:3000`, so `viewer_origin` can be omitted. The CLI reads this file when `docs-ssh login` or `auth create-ssh-session` is run without `--project`. The server still verifies that the project exists and that the principal is a member before issuing a session. A typo in the file fails with `Project "<slug>" was not found`; it does not create a new project.

## Short-Lived SSH Sessions

The preferred v0.1.0 access path is a short-lived SSH session issued from a web-authenticated user. Run `docs-ssh login` from a local work directory. The CLI creates a temporary SSH keypair, opens the browser for Web/OIDC approval, exchanges the approval for an expiring SSH session, and stores the private key locally under `~/.docs-ssh/sessions`.

```bash
docs-ssh login --json
docs-ssh status
ssh -i ~/.docs-ssh/sessions/<server>/<project>/id_ed25519 <session-username>@docs-ssh bootstrap --json
ssh -i ~/.docs-ssh/sessions/<server>/<project>/id_ed25519 <session-username>@docs-ssh cat /projects/<slug>/README.md
docs-ssh logout
```

`docs-ssh login --json` returns `sshCommand`, `identityFile`, `username`, `server`, `project`, and `expiresAt` so agent skills can reuse the session without handling browser cookies directly. This binds the web-authenticated user, selected project, generated public key, TTL, and scopes into a single SSH grant. Long-lived SSH keys remain available through operator/CLI workflows for recovery cases.

## API Tokens

Owners and admins can create project-scoped API tokens from the signed-in viewer Account panel. Select the project first, choose the token scopes, and copy the token immediately after creation; the plaintext secret is only shown once.

Use a token to create a short-lived SSH session without opening a browser:

```bash
docs-ssh token login \
  --token dssh_<secret> \
  --project default \
  --viewer-origin https://docs.example.com \
  --json
```

The command generates a temporary SSH keypair, calls the viewer API with `Authorization: Bearer <token>`, writes the same `~/.docs-ssh/sessions/<server>/<project>/session.json` format as `docs-ssh login`, and prints `sshCommand` in JSON mode.

API tokens are limited to one project. They cannot list, create, update, or archive projects; manage users; or mint other tokens. Creating SSH sessions through a token requires the `ssh-session:create` scope.

## Operator SSH Sessions

Server operators can issue short-lived SSH sessions for agents, workers, or other temporary clients without giving them a long-lived user key. A session is bound to a tenant principal, current project, public key, expiration, and scope list.

Example: create a one-hour read-only project session for an agent key.

```bash
ssh-keygen -t ed25519 -N '' -f /tmp/docs-ssh-session
docs-ssh auth create-ssh-session /tmp/docs-ssh-session.pub \
  --project default \
  --ttl-seconds 3600 \
  --scopes bootstrap:read,project:read
```

Connect with the printed username and the matching private key. Inside the SSH session, run `bootstrap --json` first so the client can read its tenant, principal, project, mounted paths, and scopes.

Use these commands to audit or revoke server-issued sessions:

```bash
docs-ssh auth list-ssh-sessions --all
docs-ssh auth revoke-ssh-session <session-id-or-username>
```

Long-lived keys in `ssh_keys` continue to authenticate the owner into the default project. Short-lived rows in `ssh_sessions` are intended for server-issued access that should expire or be revoked independently.

## Web OIDC Session

If you want the browser viewer to identify the current user, configure an OIDC issuer and prelink that identity in `auth.sqlite`.

Example:

```bash
export DOCS_SSH_OIDC_ISSUER=https://accounts.google.com
export DOCS_SSH_OIDC_CLIENT_ID=<client-id>
export DOCS_SSH_OIDC_CLIENT_SECRET=<client-secret>
export VIEWER_PUBLIC_ORIGIN=https://docs.example.com

pnpm run cli -- auth add-web-identity \
  --provider oidc \
  --issuer "$DOCS_SSH_OIDC_ISSUER" \
  --subject <oidc-subject>
```

After that, the viewer top bar exposes a sign-in link. Successful login creates a signed web session cookie and resolves the user through `auth_identities`.

Once signed in, the Account panel in the viewer lets the current user create short-lived SSH sessions for existing projects. It does not register long-lived SSH public keys from the browser. If `auth.sqlite` is still empty, the first successful web sign-in auto-creates the single-tenant owner and then the same viewer session can be used to create projects and SSH sessions from the browser.

If there is already at least one local user, unlinked identities are rejected until you prelink them with `auth add-web-identity`.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
