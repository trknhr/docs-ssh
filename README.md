# docs-ssh

Use SSH to expose project docs and agent workspaces through a shell-native filesystem, with a browser viewer for humans.

Docs: https://trknhr.github.io/docs-ssh/

## Why?

Coding agents produce a lot of temporary knowledge:

- implementation plans
- investigation notes
- benchmark results
- task handoffs

This context may be useful for days or weeks, but not forever. Chat history can disappear, while committing every intermediate artifact to Git mixes short-lived notes with durable project documentation.

docs-ssh is a workspace between chat history and Git: persistent enough for agents and humans to revisit, but separate from the source repository. Agents explore it with familiar shell tools over SSH, while humans can use the browser viewer.

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

## Notes

- Runtime target is Node 24.
- Release images are published from `v*.*.*` tags.
- Use `pnpm run smoke` before release tags.

## Design FAQ

### Why not Git?

Git is still the right home for durable docs that should evolve with the code, such as READMEs, runbooks, and ADRs. docs-ssh is for intermediate work that is useful now but likely to become stale: discarded plans, investigation traces, verification results, and handoff notes.

### Why not SQLite?

docs-ssh does use SQLite for authentication and session metadata. Workspace content stays file-based so humans and agents can inspect it with ordinary tools without a database-specific query layer.

### Why not MCP?

MCP is an integration protocol, not a storage policy. docs-ssh deliberately uses an interface that agents already understand: SSH plus filesystem commands. The two approaches are complementary; an MCP server could expose the same workspace.

### Why SSH?

Agents already know how to use `ls`, `find`, `rg`, and small file reads. SSH makes those operations remote, authenticated, scriptable, and easy to trace, without requiring a project-specific client. The browser viewer remains available for humans.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
