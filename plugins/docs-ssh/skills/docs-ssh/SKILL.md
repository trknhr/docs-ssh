---
name: docs-ssh
description: Search and use a docs-ssh project filesystem over SSH using a stable local alias.
---

# docs-ssh

Use the `docs-ssh` SSH alias from `~/.ssh/config` to inspect the mounted project filesystem before making changes.

If your server operator told you to use a different alias, replace `docs-ssh` in the examples below.

Expected SSH config:

```sshconfig
Host docs-ssh
  HostName <server-host-or-ip>
  Port 2222
```

Mounted paths:

- `/README.md` -> root filesystem guide and writing rules
- `/home` -> private durable work for the authenticated principal
- `/home/agents/codex/handoffs` -> private Codex resume summaries
- `/project` -> current project alias
- `/project/docs` -> read-only default source
- `/project/sources/<name>` -> additional read-only named sources
- `/project/tasks` -> project-scoped task work
- `/project/workspace` -> project-scoped working files
- `/projects/default` -> concrete current project path
- `/shared` -> tenant-wide docs and policies
- `/tmp` -> temporary session-local files

Workspace rules:

- Start by reading `/README.md` and `/project/README.md` before searching or writing files.
- Use `/home` for private durable work.
- Use `/project` for current project work.
- Create project task work under `/project/tasks/<task-slug>/`.
- For non-interactive SSH exec writes, prefer remote-side `printf` or `echo` commands over heredocs or `cat > file`.
- After writing a workspace file over SSH, read it back with `cat` or inspect it with `ls -l` to confirm the content arrived.
- Use `/shared` only for tenant-wide docs and policies.
- Save handoff summaries under `/home/agents/codex/handoffs/` before finishing.
- Do not save raw local agent session data unless the user explicitly opts in.
- Use `/tmp` for temporary files.

Example commands:

```bash
ssh docs-ssh cat /README.md
ssh docs-ssh cat /project/README.md
ssh docs-ssh find /project/docs -name '*.md' | head
ssh docs-ssh grep -R "keyword" /project/docs
ssh docs-ssh mkdir -p /project/tasks/example-task/artifacts
ssh docs-ssh "printf '%s\n' '# Notes' '- item' > /project/tasks/example-task/notes.md"
ssh docs-ssh sh -lc 'echo "- note" >> /project/tasks/example-task/notes.md'
ssh docs-ssh cat /project/tasks/example-task/notes.md
```
