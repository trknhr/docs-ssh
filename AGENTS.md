# Agent Instructions

## Package Manager
- Use **pnpm**: `pnpm install`, `pnpm test`, `pnpm run build`, `pnpm run smoke`

## Git Safety
- Never run `git push` without explicit user confirmation in the same turn.
- Treat `git push origin main`, tag pushes, and `--force` / `--force-with-lease` pushes as requiring confirmation.
- If a push would expose private hostnames, URLs, tokens, or deployment details, stop and ask first.

## Commit Attribution
- AI commits MUST include:

```text
Co-Authored-By: (the agent model's name and attribution byline)
```

## Key Conventions
- Runtime target is Node 24: keep Docker, GitHub Actions, `engines`, and `@types/node` aligned.
- Release images are published from `v*.*.*` tags by the Release workflow.
- Use `pnpm run smoke` before release tags.

## Local Skills
- Use `docs-ssh` skill for project filesystem and SSH workflow. See `plugins/docs-ssh/skills/docs-ssh/SKILL.md`.
