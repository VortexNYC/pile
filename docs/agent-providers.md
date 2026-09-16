# Agent Providers

The tracker is provider-agnostic at the core: every agent is a registered
provider with a `dispatch`/`poll` contract, and each workspace configures its
own providers. Credentials are per-workspace, stored in that workspace's own
Durable Object, write-only via the API, and never shared between workspaces.

## Devin Cloud (hosted)

The default path. A workspace supplies its own Devin API credentials; sessions
run on Devin's hosted infrastructure. No outpost, no self-hosted workers.

```bash
curl -X PUT "$BASE/workspaces/$ORG/agent/providers/devin" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "token": "<devin service-user api key>",
    "providerOrgId": "org-…"
  }'
```

Then `POST /workspaces/$ORG/issues/{id}/dispatch` with `{"agentId":"devin"}`
creates a standard hosted Devin session (no `platform` field is sent unless an
outpost is configured).

## Devin Outposts (self-hosted)

Outposts are a **Devin-native primitive**: a named pool of workers you run
yourself (`devin worker start`), claimed through Devin's fleet API. The tracker
supports targeting an outpost instead of hosted Devin Cloud.

Setup for a workspace:

1. In Devin Cloud → org **Settings → Environment → Outposts → Create outpost**,
   pick a name and platform (`linux`). Devin shows the outpost token **once**.
2. Configure the provider on the tracker:

```bash
curl -X PUT "$BASE/workspaces/$ORG/agent/providers/devin" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "token": "<devin service-user api key>",
    "providerOrgId": "org-…",
    "outpost": "my-outpost-name",
    "outpostId": "outpost_env-…",
    "outpostToken": "cog_…"
  }'
```

3. Run workers wherever you like: `devin worker start --outpost=<outpostId>
--token=<outpostToken>`. Each worker serves one session at a time — run N
   workers for N concurrent sessions, or let a compute integration provision a
   worker per session (see below).

Dispatch then sends `platform: <outpost>` and the session is queued on the
outpost's fleet endpoint until one of your workers claims it.

## Compute provisioning (optional, per-workspace)

When `compute*` fields are set, dispatch additionally provisions a dedicated
worker sandbox per session on your own compute provider (Daytona is the
reference integration): snapshot image → `devin worker start --session=<id>`
→ sandbox deleted when the session ends. Fields:

| field             | maps to                                                  |
| ----------------- | -------------------------------------------------------- |
| `computeApiKey`   | `DAYTONA_API_KEY`                                        |
| `computeApiUrl`   | `DAYTONA_API_URL` (default `https://app.daytona.io/api`) |
| `computeSnapshot` | `DAYTONA_SNAPSHOT`                                       |
| `computeVolumeId` | `DAYTONA_VOLUME_ID`                                      |

If unset, the outpost queue still works — sessions wait for whatever workers
you've started manually. Everything above falls back to deployment-level env
vars (`DEVIN_TOKEN`, `DEVIN_OUTPOST`, `DAYTONA_*`), so a self-hosted
deployment can set one provider for all workspaces; on a hosted deployment
each workspace brings its own.

### Smoke-testing a provisioned sandbox

Dispatch a trivial task to the outpost and, from inside the session, run
`bash scripts/outpost-smoke.sh`. It confirms:

- `DAYTONA_SANDBOX_ID`, `OUTPOST_ID` and `SESSION_ID` (the env
  `provisionOutpostWorker` sets on the sandbox) are present, i.e. the sandbox
  was created for this session rather than being a manually started worker.
- `devin worker start` is running and pinned to `--session=$SESSION_ID`.
- `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` are set when the issue's repo has a git
  identity, and node/pnpm meet the repo's requirements (warnings only).

Then confirm the session reaches the user (a message or PR arrives), and the
sandbox disappears from `GET $DAYTONA_API_URL/sandbox` after the session ends.

The snapshot must ship the toolchain the target repo needs; the worker itself only
adds the `devin` binary. For this repo that means Node `>=20.12` and
`pnpm` (see `engines` / `packageManager` in `package.json`).

## Cursor Cloud Agents

The `cursor` provider targets Cursor's Cloud Agents v1 API
(`POST https://api.cursor.com/v1/agents`). `token` is a Cursor API key
(user or enterprise service account).

```bash
curl -X PUT "$BASE/workspaces/$ORG/agent/providers/cursor" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "token": "<cursor api key>",
    "config": {
      "repoUrl": "https://github.com/org/repo",
      "startingRef": "main",
      "autoCreatePR": true
    }
  }'
```

Dispatch → durable agent + run (`providerSessionId` is `bc-…/run-…`); poll maps
`CREATING/RUNNING/FINISHED/ERROR/CANCELLED/EXPIRED` onto tracker statuses and
lifts `git.branches[].prUrl` into `url`. `config.repoUrl` is the default repo;
an issue's `repo` field overrides it. Model per dispatch via `model`.

**Self-hosted (BYOM).** Cursor's equivalent of a Devin outpost — workers you
run that execute tool calls while the agent loop stays in Cursor's cloud:

- `config.env: {"type":"machine","name":"<worker name>"}` — a _My Machines_
  worker (`agent worker --name <name> --api-key <user key> start`), bound to
  the repos in its `--worker-dir` checkouts. Personal/user API key.
- `config.env: {"type":"pool","name":"<pool>"}` — a _Team Pool_ worker
  (`agent worker --pool <name> start`). Requires a Cursor Enterprise
  **service account** key — personal keys can't start pool workers.

Workers need outbound HTTPS only. There is no `metadata` field on v1 agents —
tracker context rides inside the prompt. v1 has no webhooks yet; status is
polled (same as Devin). The legacy v0 API does support HMAC-signed
`statusChange` webhooks if push is ever required.

## cf-agent (Cloudflare Agents SDK workers)

The `cf-agent` provider targets any worker exposing the Agents SDK router shape
(`GET {agentsPath}/{agent}/{conversation}` → `messages` + `settlements`) plus a
dispatch route. The flue worker is the reference implementation; `flue` is a
registered alias of the same provider.

```bash
curl -X PUT "$BASE/workspaces/$ORG/agent/providers/cf-agent" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "token": "<bearer expected by the agent worker's dispatch route>",
    "config": {
      "endpoint": "https://my-agent.workers.dev",
      "agent": "engineering",
      "dispatchPath": "/dispatch/pile",
      "agentsPath": "/agents"
    }
  }'
```

`config.endpoint: "service-binding"` routes over the deployment's
`FLUE_WORKER` binding instead of the public URL — required for same-account
`workers.dev` targets, which Cloudflare blocks over the edge (error 1042).
Write-back is push-style: the worker PATCHes the session and POSTs activities;
`poll` is the recovery path (maps conversation `settlements` onto
`completed/failed/canceled`).

## Watching a session

`GET /workspaces/{org}/agent/sessions/{id}/stream` streams the activity log as
a Vercel AI SDK **UI-message-stream** (`x-vercel-ai-ui-message-stream: v1`)
SSE feed: `thought`→`reasoning-*`, `response`→`text-*`, `error`→`error`,
other types→`data-{type}` parts — consumable by any `useChat`-compatible
client. The stream **live-tails**: after replaying history it emits new
activities as they land (2s DO poll), closes with `data-session-status` +
`finish` when the session reaches a terminal status or a ~90s budget expires
— reconnect for a continued tail.

`POST /workspaces/{org}/agent/sessions/{id}/cancel` cancels a session:
provider-side termination when the provider supports it (Cursor `runs/{id}/
cancel`, Devin `DELETE /sessions/{id}`), then the local session is marked
`canceled` either way.

## Codex (OpenAI Agents API)

The `codex` provider targets the OpenAI Agents API
(`https://api.openai.com/v1/agents/sessions`). The workspace token is the
OpenAI API key.

```bash
curl -X PUT "$BASE/workspaces/$ORG/agent/providers/codex" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "token": "<OpenAI API key>",
    "config": {
      "environment": { "type": "openai_hosted" }
    }
  }'
```

Dispatch creates a managed-harness session. Poll maps `in_progress` →
`running`, `requires_action` → `waiting`, `failed` → `failed`, and `idle` +
assistant output → `completed`. If the final assistant message contains a GitHub
PR URL, it is lifted into `prUrl`.

`config.environment` can be set to `{"type":"self_hosted", ...}` for
repositories that require a private checkout; the workspace must then start and
connect an OpenAI executor to `session.environment.remote_url`.

## Codex CLI Cloud (ChatGPT subscription)

The `codex-cli` provider runs the authenticated Codex CLI in a dedicated
Daytona sandbox, submits work with `codex cloud exec`, and polls Codex Cloud
until the task is ready or applied. It is intended for a ChatGPT subscription
rather than an OpenAI API key.

Configure these deployment or workspace-effective environment values:

| variable              | purpose                                                                    |
| --------------------- | -------------------------------------------------------------------------- |
| `CODEX_AUTH_JSON_B64` | Base64-encoded contents of the ChatGPT-authenticated `~/.codex/auth.json`. |
| `CODEX_CLI_ENV_ID`    | Codex Cloud environment ID used by `codex cloud exec`.                     |
| `DAYTONA_API_KEY`     | Daytona API and Toolbox bearer token.                                      |
| `DAYTONA_API_URL`     | Optional Daytona API URL; defaults to `https://app.daytona.io/api`.        |
| `DAYTONA_SNAPSHOT`    | Optional sandbox snapshot; defaults to `daytona-vm-small`.                 |
| `CODEX_CLI_MODEL`     | Optional default model; a model supplied during dispatch takes precedence. |

The sandbox writes the authenticated Codex home directory under its writable
`HOME`, installs the Codex CLI if needed, creates the issue branch, then runs
`codex cloud exec --env <environment> --branch <branch> -`. When Codex Cloud
finishes, the runner records its terminal state, branch, task summary, and PR
URL for the provider poller. The GitHub App installation token and the issue's
configured git identity are passed into the sandbox so Codex can push the
branch and create the PR.

## API

| route                                                | perm         | notes                                     |
| ---------------------------------------------------- | ------------ | ----------------------------------------- |
| `GET /workspaces/{org}/agent/providers`              | `agent:read` | secrets redacted (`hasToken` etc.)        |
| `PUT /workspaces/{org}/agent/providers/{agentId}`    | `admin`      | upsert; unset fields keep existing values |
| `DELETE /workspaces/{org}/agent/providers/{agentId}` | `admin`      | revert to deployment defaults             |

## Custom agents

Any agent can integrate without a provider at all: the workspace API (issues,
comments, `agent/sessions`, `agent/sessions/{id}/activities`, webhooks, MCP)
is the full surface. Registering a new provider is for agents that want
dispatch + poll through the tracker's provider interface — see
`src/agents/provider.ts`.
