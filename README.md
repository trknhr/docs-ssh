# docs-ssh

Expose project files and agent workspaces over SSH and authenticated HTTP, with a browser viewer for humans.

Docs: https://trknhr.github.io/docs-ssh/

## Why?

Coding agents produce a lot of temporary knowledge:

- implementation plans
- investigation notes
- benchmark results
- task handoffs

This context may be useful for days or weeks, but not forever. Chat history can disappear, while committing every intermediate artifact to Git mixes short-lived notes with durable project documentation.

docs-ssh is a workspace between chat history and Git: persistent enough for agents and humans to revisit, but separate from the source repository. Agents use familiar shell tools over SSH or a direct HTTP Files API, while humans use the browser viewer.

## Learn More

- [Design and motivation: *Project Docs over SSH for AI Agents*](https://dev.to/trknhr/project-docs-over-ssh-for-ai-agents-35jo)
- [MultiHop-RAG benchmark design and results](./bench/multihop-rag/README.md#2026-06-30-100-case-result)
- [Documentation](https://trknhr.github.io/docs-ssh/)

## Install the CLI

Node.js 24 is required.

```bash
npm install --global docs-ssh
docs-ssh --help
```

## Run Locally

```bash
pnpm install
pnpm run build
npm link
pnpm run dev
```

Defaults:

- SSH server: `127.0.0.1:2222`
- Viewer: `http://127.0.0.1:3000`

From another terminal:

```bash
docs-ssh status --json
ssh localhost -p 2222 bootstrap --json
```

## Common Commands

```bash
pnpm test
pnpm run build
pnpm run site:build
pnpm run smoke
```

Useful CLI flows:

```bash
docs-ssh config init
docs-ssh login --json
docs-ssh token login --token dssh_... --host docs-ssh --project default --json
docs-ssh skill --output .agents/skills/docs-ssh/SKILL.md
```

## HTTP Files API

Agents can access the same project files over authenticated HTTP. The `files` command reads
`viewer_origin` and `project` from the nearest `.docs-ssh.toml`, then uses the injected project
API token:

```bash
export DOCS_SSH_TOKEN=dssh_...

docs-ssh files list tasks --json
docs-ssh files stat tasks/http-demo/result.md --json
docs-ssh files search needle --path tasks --glob '*.md' --json
docs-ssh files read tasks/http-demo/result.md
docs-ssh files mkdir tasks/http-demo --json
docs-ssh files write tasks/http-demo/result.md --input result.md --json
```

The token must belong to the project. Reads require `project:read`; writes and directory creation
require `project:write`. `read` writes raw bytes to stdout or to the path passed with `--output`;
the other operations support structured `--json` output. HTTP writes share storage with SSH and
the Viewer. See the [HTTP Files API reference](./docs/http-files-api.md) for endpoints, path rules,
and response shapes.

## HTML Artifacts

Have an agent store a self-contained HTML file in the remote task artifact directory, then publish
that virtual path from the CLI:

```bash
# Remote source: /projects/<configured-project>/tasks/demo/artifacts/index.html
docs-ssh artifact publish tasks/demo/artifacts/index.html
```

The project comes from `.docs-ssh.toml`. Publishing returns a stable Viewer URL. Publishing the
same source path again creates a new immutable version at that URL.

```bash
docs-ssh artifact list
docs-ssh artifact versions <artifact-id>
docs-ssh artifact share <artifact-id> project
docs-ssh artifact share <artifact-id> private
```

Artifacts currently support single-file `.html` and `.htm` documents below
`tasks/<task>/artifacts/`. Inline JavaScript runs in a sandbox with external network access,
forms, popups, and parent-page access disabled.

## Notes

- Runtime target is Node 24.
- Matching `v*.*.*` tags publish the Docker image and npm package through the Release workflow.
- Keep the tag and `package.json` version aligned.
- Use `pnpm run smoke` before release tags.

## Design FAQ

### Why not Git?

Git is still the right home for durable docs that should evolve with the code, such as READMEs, runbooks, and ADRs. docs-ssh is for intermediate work that is useful now but likely to become stale: discarded plans, investigation traces, verification results, and handoff notes.

### Why not SQLite?

Workspace source content stays file-based so humans and agents can inspect and edit it with ordinary tools. docs-ssh uses SQLite for authentication, sessions, Artifact metadata, and immutable published Artifact revisions.

### Why not MCP?

MCP is an integration protocol, not a storage policy. docs-ssh deliberately uses an interface that agents already understand: SSH plus filesystem commands. The two approaches are complementary; an MCP server could expose the same workspace.

### Why SSH?

Agents already know how to use `ls`, `find`, `rg`, and small file reads. SSH makes those operations remote, authenticated, scriptable, and easy to trace, without requiring a project-specific client. The browser viewer remains available for humans.

### Why HTTP too?

Some agent sandboxes can make HTTP requests more easily than they can open an interactive SSH session. The HTTP Files API exposes the same project-scoped storage without requiring a shell, while SSH remains available for exploration and shell-native workflows.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
