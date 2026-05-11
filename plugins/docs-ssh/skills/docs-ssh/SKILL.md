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
- `/home` -> private personal notes for the authenticated principal
- `/project` -> current project alias
- `/project/docs` -> read-only default source
- `/project/sources/<name>` -> additional read-only named sources
- `/project/issues` -> issue tracking: what to do, why, status, next action, and result links
- `/project/tasks` -> research and work results
- `/projects/default` -> concrete current project path
- `/tmp` -> temporary session-local files

Workspace rules:

- Start by running `bootstrap --json`, then read `/README.md` and `/project/README.md` before searching or writing files.
- Use `/home` for private personal notes.
- Use `/project/issues` for issue tracking: what to do, why, status, next action, and result links.
- Use `/project/tasks` for research and work results: logs, conclusions, verification, proposals, and generated artifacts.
- Use `/project/docs` only for polished references that should stay useful long-term.
- For non-interactive SSH exec writes, prefer remote-side `printf` or `echo` commands over heredocs or `cat > file`.
- After writing a file over SSH, read it back with `cat` or inspect it with `ls -l` to confirm the content arrived.
- Use `/tmp` for temporary files.

Example commands:

```bash
ssh docs-ssh bootstrap --json
ssh docs-ssh cat /README.md
ssh docs-ssh cat /project/README.md
ssh docs-ssh ls /project/issues
ssh docs-ssh find /project/docs -name '*.md' | head
ssh docs-ssh grep -R "keyword" /project/docs
ssh docs-ssh "printf '%s\n' '# Example issue' 'status: open' 'next: inspect docs' > /project/issues/example-issue.md"
ssh docs-ssh mkdir -p /project/tasks/example-task/artifacts
ssh docs-ssh "printf '%s\n' '# Notes' '- item' > /project/tasks/example-task/notes.md"
ssh docs-ssh sh -lc 'echo "- note" >> /project/tasks/example-task/notes.md'
ssh docs-ssh cat /project/tasks/example-task/notes.md
```
