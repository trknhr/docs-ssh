---
name: docs-ssh
description: Search and use a docs-ssh project filesystem over SSH using a configured local alias.
---

# docs-ssh

Resolve the SSH target before inspecting the mounted project filesystem:

- Starting from the current working directory, look upward for `.docs-ssh.toml`.
- If the file contains `server = "<alias>"`, use that SSH alias.
- If no config file or server value exists, use `docs-ssh`.
- If the file contains `project = "<slug>"`, treat it as the intended current project when creating or checking SSH sessions.
- Run `docs-ssh status --json` first. If there is no active session, run `docs-ssh login --json`; it opens the browser for Web/OIDC approval and returns the SSH command to use.
- Do not create directories directly under `/projects`; projects are server-managed resources.

Common SSH config:

```sshconfig
Host docs-ssh-local
  HostName localhost
  Port 2222

Host docs-ssh
  HostName <server-host-or-ip>
  Port 2222
```

In this repo, local development normally uses `.docs-ssh.toml` with:

```toml
server = "docs-ssh-local"
project = "docs-ssh"
```

When a scoped SSH session is issued, connect as `<session-username>@<server>` so `/projects/<slug>` contains the configured project. Connecting as the normal local SSH user falls back to that principal's default project.

`docs-ssh login --json` returns `sshCommand`, `identityFile`, `username`, `server`, `project`, and `expiresAt`. Use the returned `sshCommand` as the prefix for SSH commands when available.

Mounted paths:

- `/README.md` -> root filesystem guide and writing rules
- `/home` -> private personal notes for the authenticated principal
- `/projects/<slug>` -> project workspace selected by slug
- `/projects/<slug>/docs` -> read-only default source
- `/projects/<slug>/sources/<name>` -> additional read-only named sources
- `/projects/<slug>/issues` -> issue tracking: what to do, why, status, next action, and result links
- `/projects/<slug>/tasks` -> research and work results
- `/tmp` -> temporary session-local files

Workspace rules:

- Start by running `bootstrap --json`, then read `/README.md` and `/projects/<slug>/README.md` before searching or writing files.
- Use `/home` for private personal notes.
- Use `/projects/<slug>/issues` for issue tracking: what to do, why, status, next action, and result links.
- Use `/projects/<slug>/tasks` for research and work results: logs, conclusions, verification, proposals, and generated artifacts.
- Use `/projects/<slug>/docs` only for polished references that should stay useful long-term.
- Do not create new directories directly under `/projects`; projects are server-managed resources.
- To reduce SSH round trips, pipe newline-separated commands into `batch`; it returns one JSON object per command.
- Use `read-range [-n] <path> <start> <end>` instead of `cat` when you only need a small part of a large file.
- For non-interactive SSH exec writes, prefer remote-side `printf` or `echo` commands over heredocs or `cat > file`.
- After writing a file over SSH, read it back with `cat` or inspect it with `ls -l` to confirm the content arrived.
- Use `/tmp` for temporary files.

Example commands:

```bash
docs-ssh status --json
docs-ssh login --json
ssh <server> bootstrap --json
ssh <server> cat /README.md
ssh <server> cat /projects/<slug>/README.md
ssh <server> ls /projects/<slug>/issues
ssh <server> find /projects/<slug>/docs -name '*.md' | head
ssh <server> grep -R "keyword" /projects/<slug>/docs
ssh <server> read-range -n /README.md 1 80
printf '%s\n' 'find /projects/<slug>/tasks -maxdepth 1 -type f' 'read-range -n /README.md 1 40' | ssh <server> batch
ssh <server> "printf '%s\n' '# Example issue' 'status: open' 'next: inspect docs' > /projects/<slug>/issues/example-issue.md"
ssh <server> mkdir -p /projects/<slug>/tasks/example-task/artifacts
ssh <server> "printf '%s\n' '# Notes' '- item' > /projects/<slug>/tasks/example-task/notes.md"
ssh <server> sh -lc 'echo "- note" >> /projects/<slug>/tasks/example-task/notes.md'
ssh <server> cat /projects/<slug>/tasks/example-task/notes.md
```
