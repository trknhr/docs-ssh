# docs-ssh

Use SSH to expose project docs and agent workspaces through a shell-native
filesystem, with a browser viewer for humans.

Docs: https://trknhr.github.io/docs-ssh/

## Quick Start

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

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
