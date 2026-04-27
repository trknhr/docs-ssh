# docs-ssh

Browse local documentation over SSH.

`docs-ssh` is a local-first derivative of `supabase-community/supabase-ssh`. It keeps
the SSH plus `just-bash` sandbox core, but generalizes the mounted docs to any local
folder and prepares the codebase for future ingest adapters.

## Status

Current scope:

- serve a local docs folder over SSH
- ingest additional sources into a local registry
- mount sources at `/sources/<name>`
- expose `/docs` as the default alias
- keep source mounts read-only
- provide `/workspace` as a persistent structured agent workspace
- provide `/tmp` for temporary session-local files

Deferred:

- default-source switching and source removal commands
- HTML/help-center crawling
- hosted-service telemetry and rate limiting

## Quick Start

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Build the viewer assets once:

   ```bash
   pnpm run build:viewer
   ```

3. Generate a host key manually if you want to precreate one:

   ```bash
   pnpm run generate:host-key:local
   ```

   If you skip this step, `docs-ssh` will generate `./ssh_host_key` automatically on first boot.

4. Start the server:

   ```bash
   pnpm run dev
   ```

   This starts the SSH server on `127.0.0.1:2222` and the viewer on `127.0.0.1:3000`.
   If a repo-local `.env` file exists, `docs-ssh` loads it automatically on startup.

   If you want reload-on-save locally, use:

   ```bash
   pnpm run dev:watch
   ```

   If you change files under `viewer/`, rerun `pnpm run build:viewer` before refreshing the browser.

5. Connect from another terminal:

   ```bash
   ssh localhost -p 2222
   ssh localhost -p 2222 ls /docs
   ssh localhost -p 2222 grep -R "getting started" /docs
   ```

6. Open the read-only viewer in a browser:

   ```bash
   # macOS
   open http://localhost:3000

   # Linux
   xdg-open http://localhost:3000
   ```

   The viewer exposes a VS Code-like file tree plus a preview pane for markdown, text/code, and images.
   If OIDC is configured, the top bar also exposes sign-in and sign-out controls for the web session.

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
ssh docs-ssh ls /docs
ssh docs-ssh grep -R "getting started" /docs
```

The distributable skill file at `skills/SKILL.md` assumes this alias-based setup. If you prefer a different alias, update both the SSH config entry and the commands in the copied skill.

## Agent Helper Files

Inside an SSH session, `docs-ssh` exposes three helper commands:

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

## Container

You can run `docs-ssh` in Docker and keep the source registry plus host key on disk.

```bash
docker compose up --build -d
ssh localhost -p 2222 ls /docs
```

Then open `http://localhost:3000` in a browser.

The included `docker-compose.yml` mounts:

- `./docs` -> `/data/docs` as the read-only default docs source
- `./.docs-ssh` -> `/data/state` for ingested sources, registry state, the generated host key, and the default workspace

Useful container commands:

```bash
docker compose exec docs-ssh node dist/src/cli.js sources list
docker compose exec docs-ssh node dist/src/cli.js ingest github --default
docker compose restart docs-ssh
```

If you want to run the image without Compose, the image works with bundled sample docs by default:

```bash
docker build -t docs-ssh .
docker run --rm -p 2222:2222 -p 3000:3000 docs-ssh
```

## Self-Hosting

For a home server, use the dedicated self-hosting compose file so docs, state, and workspace live on separate host paths.

```bash
cp .env.selfhost.example .env.selfhost
docker compose -f docker-compose.selfhost.yml --env-file .env.selfhost up -d --build
```

The self-hosting config uses:

- `DOCS_SSH_DOCS_DIR` for the read-only docs mount
- `DOCS_SSH_STATE_DIR` for ingested source data and the SSH host key
- `DOCS_SSH_WORKSPACE_DIR` for the persistent structured workspace mounted at `/workspace`
- `DOCS_SSH_BIND_IP` to control whether the SSH port binds only to localhost or to your LAN interface
- `DOCS_SSH_VIEWER_BIND_IP` to control whether the HTTP viewer binds only to localhost or to your LAN interface
- `DOCS_SSH_VIEWER_PORT` to control the HTTP viewer port

Example: expose SSH on `2222` and the viewer on `3000` to your LAN.

```bash
cat > .env.selfhost <<'EOF'
DOCS_SSH_BIND_IP=0.0.0.0
DOCS_SSH_PORT=2222
DOCS_SSH_VIEWER_BIND_IP=0.0.0.0
DOCS_SSH_VIEWER_PORT=3000
DOCS_SSH_DOCS_DIR=/srv/docs-ssh/docs
DOCS_SSH_STATE_DIR=/srv/docs-ssh/state
DOCS_SSH_WORKSPACE_DIR=/srv/docs-ssh/workspace
EOF

docker compose -f docker-compose.selfhost.yml --env-file .env.selfhost up -d --build
```

After startup:

```bash
ssh <server-ip> -p 2222
```

Then open `http://<server-ip>:3000` in a browser.

Security note: SSH access is now gated by public keys stored in `auth.sqlite`. The HTTP viewer remains read-only by default, but if your docs are sensitive you should still keep both SSH and the viewer on localhost, your LAN, or behind a private network like Tailscale.

## Ingest Sources

You can ingest more sources into a local registry under `.docs-ssh/`.

```bash
pnpm run ingest -- local-folder ./docs --name project-docs
pnpm run ingest -- git-repo https://github.com/github/docs.git --name github --subdir content --default
pnpm run ingest -- github --default
pnpm run sources:list
```

Mounted paths:

- every source is available at `/sources/<name>`
- the default source is also available at `/docs`
- `/workspace` persists across sessions and includes scaffolded task/library/decision directories
- `/tmp` is writable and resets between SSH sessions

The viewer picks up registry changes on refresh. Existing interactive shell sessions will not see new mounts until you reconnect.

## Workspace Layout

`docs-ssh` seeds `/workspace` with a stable top-level structure for AI agents:

- `README.md` and `_policy.json` describe the layout and writing rules
- `tasks/` for active task-specific work
- `library/` for reusable personal references, playbooks, snippets, and prompts
- `decisions/` for durable cross-task decisions
- `archive/` for completed work
- `shared/` reserved for future multi-user sharing

From the SSH session, the guidance files are read-only and writes are limited to `/workspace/tasks`, `/workspace/library`, `/workspace/decisions`, and `/workspace/archive`. Agents should create new task material under `/workspace/tasks/<task-slug>/` and use `/tmp` for temporary files.

## Configuration

If a repo-local `.env` file exists, both the server entrypoint and the CLI load it automatically before reading these variables.

- `DOCS_DIR`: local directory to mount, default `./docs`
- `DOCS_NAME`: label shown in banners and helper files, default `Documentation`
- `DOCS_SSH_STATE_DIR`: registry and managed source storage dir, default `./.docs-ssh`
- `DOCS_SSH_REGISTRY_PATH`: optional explicit registry file path
- `DOCS_SSH_AUTH_DB_PATH`: auth metadata database path, default `<DOCS_SSH_STATE_DIR>/auth.sqlite`
- `DOCS_SSH_OIDC_ISSUER`: optional OIDC issuer URL for web sign-in
- `DOCS_SSH_OIDC_CLIENT_ID`: optional OIDC client ID for web sign-in
- `DOCS_SSH_OIDC_CLIENT_SECRET`: optional OIDC client secret for web sign-in
- `DOCS_SSH_OIDC_PROVIDER`: auth identity provider label used in `auth_identities`, default `oidc`
- `DOCS_SSH_OIDC_SCOPE`: OIDC scope for web sign-in, default `openid email profile`
- `WORKSPACE_DIR`: persistent structured workspace dir, default `./.docs-ssh/workspace`
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

For a single-tenant VPS setup, bootstrap one default tenant plus one owner principal in the local auth database:

```bash
pnpm run cli -- auth init
pnpm run cli -- auth add-ssh-key ~/.ssh/id_ed25519.pub
pnpm run cli -- auth add-web-identity \
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

Once signed in, the Account panel in the viewer lets the current user register SSH public keys directly into `ssh_keys`. If `auth.sqlite` is still empty, the first successful web sign-in auto-creates the single-tenant owner and then the same viewer session can be used to add SSH keys from the browser.

If there is already at least one local user, unlinked identities are rejected until you prelink them with `auth add-web-identity`.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
