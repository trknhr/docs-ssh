---
name: docs-ssh
description: Search and read docs mounted by docs-ssh over SSH using a stable local alias.
---

# docs-ssh

Use the `docs-ssh` SSH alias from `~/.ssh/config` to inspect mounted docs before making changes.

If your server operator told you to use a different alias, replace `docs-ssh` in the examples below.

Expected SSH config:

```sshconfig
Host docs-ssh
  HostName <server-host-or-ip>
  Port 2222
```

Mounted paths:

- `/docs` -> default source
- `/sources/<name>` -> additional named sources
- `/workspace/README.md` -> workspace layout and writing rules
- `/workspace/_policy.json` -> machine-readable workspace policy
- `/workspace/tasks` -> active task-specific work
- `/workspace/library` -> reusable notes, playbooks, and snippets
- `/workspace/decisions` -> durable cross-task decisions
- `/workspace/archive` -> completed work and retired notes
- `/workspace/shared` -> reserved for future shared workflows
- `/scratch` -> temporary session-local files

Workspace rules:

- Read `/workspace/README.md` before writing files.
- Do not create loose files or new top-level directories under `/workspace`.
- Create active work under `/workspace/tasks/<task-slug>/`.
- Treat `/workspace/shared` as reserved for future shared workflows.
- Use `/scratch` for temporary files.

Example commands:

```bash
ssh docs-ssh find /docs -name '*.md' | head
ssh docs-ssh grep -R "keyword" /docs
ssh docs-ssh cat /workspace/README.md
ssh docs-ssh mkdir -p /workspace/tasks/example-task/artifacts
ssh docs-ssh sh -lc 'echo "- note" >> /workspace/tasks/example-task/notes.md'
```
