# Multi-Tenant SSH Architecture Notes

このメモは、`docs-ssh` を将来的に multi-tenant / service-account / agent-friendly に伸ばすための設計整理です。

現時点の結論は、HTTP API を主な data plane にするのではなく、API は bootstrap/control plane に絞り、実作業は SSH 経由に寄せる、です。AI agent にとっては `ssh` で入った先に `/README.md`, `/home`, `/project`, `/projects`, `/shared`, `/tmp` が見える方が扱いやすいです。

## 用語

- `deployment`: 実際に動いている docs-ssh のプロセスと SQLite DB。今は 1 deployment = 1 SQLite DB。
- `tenant`: データ境界。個人、チーム、org など。将来は 1 deployment に複数 tenant を入れる。
- `principal`: 認証・認可の主体。human user, service account, agent session などを同列に扱うための抽象。
- `user`: human principal。OIDC login や browser session を持つ。
- `service account`: machine / agent / CI 用 principal。人間 user とは別に払い出す。
- `ssh session`: 短命 SSH access。public key と TTL を持ち、principal と tenant に紐づく。

## 基本方針

- 当面は SQLite 1つに複数 tenant を入れる設計にする。
- 複数 deployment が必要になったら、その時点で DB を共有化する。
- `instance` という概念は混乱しやすいので、論理境界は `tenant` に寄せる。
- `users` は tenant から独立させ、`memberships` で tenant 所属と role を表す。
- `auth_identities` と長期 `ssh_keys` は principal に紐づける。
- tenant は複数 project を持てる。
- project 共有データは `/project` / `/projects/<slug>` に見せる。
- principal 専用データは `/home` に見せる。
- tenant 共有データは `/shared` に見せる。

## 目指すモデル

```text
deployment
  └─ sqlite db
      ├─ tenant A
      │   ├─ human user
      │   ├─ service account
      │   ├─ projects
      │   ├─ shared docs / policies
      │   └─ home per principal
      └─ tenant B
          ├─ human user
          ├─ service account
          ├─ projects
          ├─ shared docs / policies
          └─ home per principal
```

DB は概ね以下の方向に整理する。

```text
tenants
principals
users
service_accounts
memberships
auth_identities
ssh_keys
ssh_sessions
api_tokens
service_account_identities
projects
project_sources
tenant_shared_sources
```

`principals.kind` はまず `user | service_account` で十分です。将来必要なら `agent_session` を足します。

## Human User

human user の primary UX は Web/OIDC に寄せるのがよいです。端末ごとに長期 SSH 公開鍵を登録させるのは面倒なので、最終的には Web/OIDC から短命 SSH session を払い出す動線を主にします。

長期 SSH key 登録は advanced option として残します。

```text
normal flow:
  1. browser で OIDC login
  2. Web から SSH session を作る
  3. 一時 SSH key / ssh command を使って接続
  4. TTL で失効

advanced flow:
  1. browser で OIDC login
  2. 自分の public key を登録
  3. 以後は通常の ssh client で接続
```

SSH server 側は、長期 key と短命 session key の両方を publickey auth として扱えばよいです。

```text
publickey auth:
  1. active ssh_session に一致するか
  2. registered ssh_key に一致するか
```

## Service Account

service account は human user の API token ではなく、独立した principal として払い出します。これは agent / CI / external worker が人間の権限に強く依存しないようにするためです。

service account の基本認証は2段です。

```text
control plane:
  API key or federated OIDC

data plane:
  short-lived SSH session
```

### Static API Key

最初の実装としては static API key が簡単です。service account は long-lived API key を持ち、それを使って短命 SSH session を作ります。

```http
POST /api/v1/ssh-sessions
Authorization: Bearer dssh_sa_...
Content-Type: application/json

{
  "publicKey": "ssh-ed25519 AAAA...",
  "ttlSeconds": 3600
}
```

response:

```json
{
  "sessionId": "sess_...",
  "tenant": "default",
  "principal": "open-claw-runner",
  "ssh": {
    "host": "docs.example.com",
    "port": 2222,
    "username": "sess_...",
    "knownHosts": "docs.example.com ssh-ed25519 AAAA..."
  },
  "expiresAt": "2026-04-21T12:00:00Z"
}
```

service account 側は起動時に keypair を生成し、public key だけを API に送ります。private key は docs-ssh に送らず、server にも保存しません。

```text
agent:
  1. ephemeral SSH keypair を生成
  2. public key を API に送る
  3. SSH 接続情報を受け取る
  4. private key で SSH 接続する
  5. TTL 後に session は無効
```

### Federated OIDC

より secure な本命は、service account にも OIDC / workload identity federation を入れることです。server に long-lived API key を置かず、GitHub Actions, Kubernetes, GCP, Azure, AWS role などから短命 credential を交換します。

```text
1. workload が platform から OIDC token を取得
2. docs-ssh に token exchange
3. docs-ssh が issuer / audience / subject / claims を検証
4. service account に map
5. short-lived API session を発行
6. API session で short-lived SSH session を作る
7. 以降は SSH
```

```http
POST /api/v1/token/exchange
Content-Type: application/json

{
  "provider": "github-actions",
  "idToken": "eyJ...",
  "requestedTtlSeconds": 900
}
```

response:

```json
{
  "accessToken": "dssh_sts_...",
  "expiresAt": "2026-04-21T12:00:00Z"
}
```

その後、short-lived API session で SSH session を作ります。

```http
POST /api/v1/ssh-sessions
Authorization: Bearer dssh_sts_...
Content-Type: application/json

{
  "publicKey": "ssh-ed25519 AAAA...",
  "ttlSeconds": 3600
}
```

`service_account_identities` は provider ごとに claim mapping を持てるようにします。

```text
service_account_identities
  service_account_id
  provider
  issuer
  audience
  subject
  claim_rules
```

## SSH-First Data Plane

API は filesystem の通常 read/write を主目的にしません。API は最初の接続情報、current project、policy を返す control plane にします。

```text
API:
  - login / token exchange
  - ssh session 作成
  - bootstrap manifest 取得
  - session revoke
  - admin 操作

SSH:
  - `/README.md` を読む
  - `/home` で principal 専用の作業を読む/書く
  - `/project` で current project の docs / tasks / workspace を読む/書く
  - `/projects` でアクセス可能な project を横断する
  - `/shared` で tenant 共有 docs / policies を読む
  - grep / find / cat / shell 操作
  - AI agent の実作業
```

bootstrap manifest は以下のような内容にします。

```json
{
  "tenant": "default",
  "principal": "open-claw-runner",
  "project": {
    "slug": "foo",
    "root": "/project"
  },
  "ssh": {
    "host": "docs.example.com",
    "port": 2222,
    "username": "sess_...",
    "knownHosts": "docs.example.com ssh-ed25519 AAAA..."
  },
  "paths": {
    "rootReadme": "/README.md",
    "home": "/home",
    "project": "/project",
    "projects": "/projects",
    "shared": "/shared",
    "tmp": "/tmp",
    "agentState": "/home/agents/codex",
    "agentHandoffs": "/home/agents/codex/handoffs"
  },
  "recommendedCommands": [
    "cat /README.md",
    "cat /project/README.md",
    "find /project/tasks -maxdepth 2 -type f",
    "find /home/agents/codex/handoffs -maxdepth 1 -type f"
  ]
}
```

## Home And Project Scope

`/home` は tenant と principal ごとに分離します。agent や人間が自由に使う永続領域はここです。

```text
state/
  tenants/
    <tenant-id>/
      principals/
        <principal-id>/
          home/
```

SSH 内では常に `/home` として見せますが、実体 path は authenticated principal によって変わります。

```text
human user A:
  /home -> state/tenants/<tenant>/principals/<principal-a>/home

service account B:
  /home -> state/tenants/<tenant>/principals/<principal-b>/home
```

`/project` は SSH session 作成時に選ばれた current project の alias です。複数 project を見る場合は `/projects/<slug>` を使います。

```text
state/
  tenants/
    <tenant-id>/
      projects/
        <project-slug>/
          docs/
          tasks/
          workspace/
          agents/
```

```text
selected project foo:
  /project -> state/tenants/<tenant>/projects/foo
  /projects/foo -> state/tenants/<tenant>/projects/foo
```

`/shared` は tenant 全体で共有する docs / policies の置き場です。project に閉じない情報だけを置きます。

```text
state/
  tenants/
    <tenant-id>/
      shared/
        docs/
        policies/
```

```text
tenant shared:
  /shared -> state/tenants/<tenant>/shared
```

## Agent State Scope

agent の handoff / resume 用の永続領域は `/home/agents/<agent-name>` に置きます。

```text
state/
  tenants/
    <tenant-id>/
      principals/
        <principal-id>/
          home/
            agents/
              <agent-name>/
                handoffs/
                sessions/
                  raw/
                artifacts/
```

project に共有したい agent 成果物は `/project/agents/<agent-name>` に置きます。

```text
state/
  tenants/
    <tenant-id>/
      projects/
        <project-slug>/
          agents/
            <agent-name>/
              handoffs/
              artifacts/
```

raw session data は `/home/agents/<agent-name>/sessions/raw` だけに置きます。`/project` や `/shared` に raw session data を置くのは避けます。

## Scopes

最初から scopes を持たせます。細かくしすぎず、まずは以下くらいで十分です。

```text
bootstrap:read
home:read
home:write
project:read
project:write
projects:read
shared:read
sources:read
sources:write
ssh_sessions:create
admin
```

SSH session 作成時には、API token / OIDC exchange で得た principal, current project, scopes を session にコピーします。SSH 接続後の shell では、その scopes に応じて mount や write path を制限します。

project write は project membership / role によって制限します。個人用の `/home` write と、project 共有の `/project` write は別権限として扱います。

## 実装順

1. `instances` を `tenants` に寄せる
2. `principals` を追加する
3. `users` を `principal_id` にぶら下げる
4. `ssh_keys` を `user_id` から `principal_id` に寄せる
5. `projects` を追加する
6. `/home` を `tenant_id + principal_id` で分離する
7. `/project` と `/projects/<slug>` を current project / accessible projects として mount する
8. `/shared` を tenant shared area として mount する
9. root `/README.md`, `/home/README.md`, `/project/README.md`, `/shared/README.md` を生成する
10. `service_accounts` を追加する
11. `api_tokens` を追加する
12. `ssh_sessions` を追加する
13. `POST /api/v1/ssh-sessions` を追加する
14. SSH publickey auth で `ssh_sessions` を見る
15. SSH helper として `bootstrap --json` を追加する
16. service account OIDC federation を追加する

最初の大きな境界変更は `/home` の分離と root README の導入です。これができると、human user と service account の両方を同じ SSH-first filesystem に載せやすくなります。

## 残すもの

- 長期 SSH key 登録は残す。power user / break-glass / 手動運用に便利。
- static API key も残す。ローカル・小規模・手動 setup では簡単。
- OIDC federation は本命だが、初期実装では後回しでよい。

## 現時点の判断

- API-only filesystem access にはしない。
- SSH を AI agent 用 data plane として主役にする。
- API は session-manager 的な役割に寄せる。
- 人間 user も service account も、最終的には短命 SSH session を主導線にする。
- ただし長期 SSH key は advanced option として残す。

## Tenant Filesystem Model

現行の flat な top-level mount は用途が曖昧になりやすいので、後方互換は気にせず廃止する方向にします。特に個人用領域と project 共有領域が path から分かりにくいです。

新しい SSH root は、個人領域と project 共有領域が top-level で分かる構成にします。

```text
/
  README.md
  home/
  project/
  projects/
  shared/
  tmp/
```

各 directory の意味は以下です。

```text
/README.md
  Agent と人間が最初に読む guide。directory policy、current project、write rules、handoff rules を書く。

/home/
  ログイン中 principal 専用の永続領域。human user でも service account でも同じ概念。

/project/
  現在選択中 project の alias。通常の agent 作業はここを見ればよい。

/projects/
  アクセス可能な project 一覧。複数 project を横断する時だけ使う。

/shared/
  tenant 全体で共有される docs / notes / policies。

/tmp/
  session-local または短命の一時領域。永続保存を期待しない。handoff / resume 用の成果物は `/home` か `/project` に移す。
```

`/home` は principal ごとに実体 path を分けます。SSH 内では常に `/home` として見せます。

```text
human user A:
  /home -> state/tenants/<tenant>/principals/<principal-a>/home

service account B:
  /home -> state/tenants/<tenant>/principals/<principal-b>/home
```

`/project` は SSH session 作成時に選ばれた current project を指します。agent に `/projects/<slug>/...` を毎回意識させると迷いやすいので、通常は `/project` を使います。

```text
selected project foo:
  /project -> state/tenants/<tenant>/projects/foo
```

## Directory Layout

初期 scaffold は以下の程度にします。

```text
/
  README.md
  home/
    README.md
    workspace/
    tasks/
    docs/
    agents/
      <agent-name>/
        README.md
        handoffs/
        sessions/
          raw/
        artifacts/
  project/
    README.md
    docs/
    tasks/
    workspace/
    agents/
      <agent-name>/
        handoffs/
        artifacts/
  projects/
    <project-slug>/
      README.md
      docs/
      tasks/
      workspace/
      agents/
        <agent-name>/
          handoffs/
          artifacts/
  shared/
    README.md
    docs/
    policies/
  tmp/
```

`skills/` directory は SSH filesystem にはいったん作らないことにします。project 固有の作業手順や instruction は、当面 `/README.md`, `/project/README.md`, `/project/docs/` に寄せます。

一方で、agent 側に入れる薄い integration skill は初期から提供します。これは docs-ssh server 上の skill directory を直接読ませるものではなく、Codex / Claude / Cursor / Gemini などのローカル agent runtime に install する entrypoint です。

`context.json` も初期実装では作りません。machine-readable metadata が必要になったら、`bootstrap --json` の返却値として足します。directory policy はまず `/README.md` に集約します。

## Agent State And Resume

agent の resume / handoff 用 state は、session root ではなく `/home/agents/<agent-name>/` に置きます。`session` という名前は短命接続に見えるため、PC を跨いだ resume 用の永続 state には合いません。

```text
/home/agents/codex/
  README.md
  handoffs/
  sessions/
    raw/
  artifacts/
```

基本方針は以下です。

- `handoffs/` は default で使う。作業終了時に、人間や別 PC の agent が resume できる要約を書く。
- `artifacts/` は agent run の成果物、調査ログ、生成物を置く。
- `sessions/raw/` は user opt-in のみ。agent の生 session data は token、cookie、local path、private repo 内容を含む可能性があるため、default では保存しない。
- 生 session data は `/home` 配下だけ許可する。`/project` や `/shared` に raw session data を置くのは避ける。

project 共有したい引き継ぎは `/project/agents/<agent-name>/handoffs/` に要約だけ置きます。raw session data は共有しません。

## Agent Bootstrap UX

docs-ssh 側の理想的な user flow は以下です。

```text
初回:
  1. user が docs-ssh に Web/OIDC login する
  2. user が SSH key または short-lived SSH session をセットアップする
  3. user が手元の agent に最小限の docs-ssh integration を入れる

毎回:
  1. user が agent を起動する
  2. user が「docs-ssh の project X の task Y を更新して」と依頼する
  3. agent integration が project X を選んで SSH session / bootstrap を実行する
  4. agent が `/README.md` と `/project/README.md` を読む
  5. agent が `/project/tasks/Y` と必要な `/project/docs` を読む
  6. agent が作業する
  7. agent が `/home/agents/<agent>/handoffs/` に resume 用 summary を残す
  8. 必要なら `/project/tasks/Y` に project 共有の成果物を残す
```

`bootstrap` は HTTP API や MCP ではなく、まず SSH helper command として提供するのがシンプルです。

```bash
ssh docs-ssh bootstrap --agent codex --project foo --task onboarding-flow
ssh docs-ssh bootstrap --agent codex --project foo --task onboarding-flow --json
```

`bootstrap --json` は将来、agent integration が機械的に読むために使います。ただし初期段階では `/README.md` を読むだけでもよいです。

返す metadata は以下のような最小限で十分です。

```json
{
  "tenant": "default",
  "project": {
    "slug": "foo",
    "root": "/project"
  },
  "paths": {
    "rootReadme": "/README.md",
    "home": "/home",
    "project": "/project",
    "projects": "/projects",
    "shared": "/shared",
    "tmp": "/tmp",
    "agentState": "/home/agents/codex",
    "agentHandoffs": "/home/agents/codex/handoffs",
    "agentRawSessions": "/home/agents/codex/sessions/raw"
  },
  "rules": {
    "readFirst": ["/README.md", "/project/README.md"],
    "rawSessionsDefault": false,
    "writeHandoffOnExit": true
  }
}
```

## Agent Integration Scope

agent native skill / plugin は初期から提供します。ただし、docs-ssh core filesystem に remote skill directory を持たせて各 runtime に直接読ませる設計にはしません。Codex, Claude, Cursor, Gemini などで install 形式が違うため、docs-ssh 側は thin skill を配布し、project 固有の instruction は SSH 上の README / docs に置きます。

当面の docs-ssh integration は薄くします。責務は「bootstrap して、読むべき README を読み、決まった場所に handoff を残す」だけです。

```text
local agent integration:
  - docs-ssh への接続 alias を知っている
  - project / task を bootstrap に渡せる
  - `/README.md` と `/project/README.md` を読む
  - handoff を `/home/agents/<agent>/handoffs/` に書く
  - raw session data は user opt-in なしに保存しない

docs-ssh server:
  - native skill directory は提供しない
  - MCP server も初期実装では提供しない
  - filesystem と README と SSH helper command を契約にする
  - thin skill の template / export command は提供する
```

配布経路は複数持てるようにします。

```text
npx installer:
  npx docs-ssh-skills install codex --alias docs-ssh
  npx docs-ssh-skills install claude --alias docs-ssh

gh extension:
  gh extension install trknhr/gh-docs-ssh
  gh docs-ssh skill install codex --alias docs-ssh

ssh export fallback:
  ssh docs-ssh skill --agent codex > ~/.codex/skills/docs-ssh/SKILL.md
```

`npx` と `gh` は installer / updater として扱います。runtime が実際に読む skill file はローカルに置きます。これにより、agent runtime の skill discovery は通常通り local filesystem に任せられます。

最初に提供する skill は以下の内容にします。

```md
---
name: docs-ssh
description: Use when the user asks to inspect, update, or continue work in a docs-ssh project or task over SSH.
---

# docs-ssh

Use docs-ssh as the SSH-first filesystem for project docs, tasks, private work, and handoffs.

## Start

1. Determine the requested project and task from the user request.
2. Run `ssh docs-ssh bootstrap --agent codex --project <project> --task <task> --json`.
3. Read `/README.md`.
4. Read `/project/README.md`.
5. If a task was provided, inspect `/project/tasks/<task>/`.

## Paths

- Use `/home` for private durable work for the current principal.
- Use `/home/agents/codex/handoffs/` for resume summaries.
- Use `/project` for the selected project.
- Use `/project/tasks/<task>/` for project-scoped task work.
- Use `/project/docs/` for project docs.
- Use `/shared` only for tenant-wide docs and policies.
- Use `/tmp` for temporary files.

## Rules

- Do not assume legacy top-level docs, tasks, or workspace paths exist.
- Do not use HTTP APIs for normal docs or workspace file operations.
- Do not save raw local agent session data unless the user explicitly opts in.
- If saving raw session data is requested, write it only under `/home/agents/codex/sessions/raw/`.
- Before finishing, write a handoff summary under `/home/agents/codex/handoffs/`.

## Handoff

The handoff should include:

- user request
- selected project and task
- files read
- files changed
- current status
- next action
- blockers or open questions
```

agent 名だけは installer が置換します。Codex なら `codex`、Claude なら `claude` です。skill の本質は全 runtime で同じにし、各 runtime 固有の frontmatter / install path だけを installer 側で吸収します。

これにより、docs-ssh は agent runtime に依存しない SSH-first filesystem として保ちつつ、初回 UX では `npx` / `gh` / `ssh export` で薄い skill をすぐ入れられます。
