# docs-ssh

Browse local documentation over SSH.

`docs-ssh` is a local-first derivative of `supabase-community/supabase-ssh`. It keeps
the SSH plus `just-bash` sandbox core, but generalizes the mounted docs to any local
folder and prepares the codebase for future ingest adapters.

## Status

Current scope:

- serve a local docs folder over SSH
- ingest additional sources into a local registry
- provide git-repo presets like `github`, `supabase`, `neon`, and `cloudflare`
- mount sources at `/sources/<name>`
- expose `/docs` as the default alias
- keep source mounts read-only
- provide `/workspace` for persistent personal notes
- provide `/scratch` for temporary session-local files

Deferred:

- multi-source registry and switching
- HTML/help-center crawling
- hosted-service telemetry and rate limiting

## Quick Start

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Generate a host key manually if you want to precreate one:

   ```bash
   pnpm run generate:host-key:local
   ```

   If you skip this step, `docs-ssh` will generate `./ssh_host_key` automatically on first boot.

3. Start the server:

   ```bash
   pnpm run dev
   ```

   If you want reload-on-save locally, use:

   ```bash
   pnpm run dev:watch
   ```

4. Connect from another terminal:

   ```bash
   ssh localhost -p 2222
   ssh localhost -p 2222 ls /docs
   ssh localhost -p 2222 grep -R "getting started" /docs
   ```

## Container

You can run `docs-ssh` in Docker and keep the source registry plus host key on disk.

```bash
docker compose up --build -d
ssh localhost -p 2222 ls /docs
```

The included `docker-compose.yml` mounts:

- `./docs` -> `/data/docs` as the read-only default docs source
- `./.docs-ssh` -> `/data/state` for ingested sources, registry state, and the generated host key

Useful container commands:

```bash
docker compose exec docs-ssh node dist/src/cli.js sources list
docker compose exec docs-ssh node dist/src/cli.js ingest github --default
docker compose restart docs-ssh
```

If you want to run the image without Compose, the image works with bundled sample docs by default:

```bash
docker build -t docs-ssh .
docker run --rm -p 2222:2222 docs-ssh
```

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
- `/workspace` is writable and persists across sessions
- `/scratch` is writable and resets between SSH sessions

Existing interactive shell sessions will not see new mounts until you reconnect.

## Configuration

- `DOCS_DIR`: local directory to mount, default `./docs`
- `DOCS_NAME`: label shown in banners and helper files, default `Documentation`
- `DOCS_SSH_STATE_DIR`: registry and managed source storage dir, default `./.docs-ssh`
- `DOCS_SSH_REGISTRY_PATH`: optional explicit registry file path
- `WORKSPACE_DIR`: writable personal workspace dir, default `./.docs-ssh/workspace`
- `SSH_PORT`: SSH port to listen on, default `2222`
- `SSH_HOST`: interface to bind, default `127.0.0.1`
- `SSH_HOST_KEY_PATH`: host key path, default `./ssh_host_key`
- `IDLE_TIMEOUT`: idle session timeout in ms, default `60000`
- `SESSION_TIMEOUT`: max session duration in ms, default `600000`
- `EXEC_TIMEOUT`: per-command timeout in ms, default `10000`

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
