# Agent Providers

The tracker is provider-agnostic at the core: every agent is a registered
provider with a `dispatch`/`poll` contract, and each workspace configures its
own providers. Credentials are per-workspace, stored in that workspace's own
Durable Object, write-only via the API, and never shared between workspaces.

## Adding an agent

No wizard. The API is the form:

1. `GET /workspaces/{org}/agent/providers/catalog` — which agents exist, and
   for each: **hosted cloud** vs **your computer or server**, plus the fields
   that mode needs.
2. `PUT /workspaces/{org}/agent/providers/{agentId}` with `mode` and those
   fields.
3. `POST /workspaces/{org}/agent/providers/{agentId}/health` — the key works.

```bash
# Codex on OpenAI's cloud
curl -X PUT "$BASE/workspaces/$ORG/agent/providers/codex" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"mode":"hosted","token":"<openai api key>"}'

# Codex on your machine (self-hosted executor)
curl -X PUT "$BASE/workspaces/$ORG/agent/providers/codex" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"mode":"byo","token":"<openai api key>"}'
```

`mode` is stored on `config.mode`. Omitting it keeps the old bag-of-fields
upsert (no required-field check). Sending `mode` validates required catalog
fields and stamps provider-specific discriminants (Codex
`environment.type`, etc.).

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
creates a standard hosted Devin session on Devin's infrastructure.

To run Devin on your own compute, use `devin-cli` instead — it runs the
vendor's CLI headlessly inside your Daytona sandbox and bills to your own
Devin account, bypassing the organization sessions API entirely.

## Compute (optional, per-workspace)

The headless CLI providers (`codex-cli`, `devin-cli`, `cursor-cli`) provision a
dedicated sandbox per session on your own compute provider (Daytona is the
reference integration). The `compute*` fields override the deployment-level
env vars:

| field             | maps to                                                  |
| ----------------- | -------------------------------------------------------- |
| `computeApiKey`   | `DAYTONA_API_KEY`                                        |
| `computeApiUrl`   | `DAYTONA_API_URL` (default `https://app.daytona.io/api`) |
| `computeSnapshot` | `DAYTONA_SNAPSHOT`                                       |
| `computeVolumeId` | `DAYTONA_VOLUME_ID`                                      |

Two compute backends exist behind the same runner/result contract
(`src/agents/compute.ts`), selected by `COMPUTE_PROVIDER`:

- `daytona` (default) — Daytona sandboxes via the `DAYTONA_*` env vars above.
- `cloudflare` — Cloudflare Sandbox (Workers Containers) via the Worker's own
  `SANDBOX` binding and `Dockerfile.sandbox` image. No external API key or
  snapshot registry; env vars are injected per-process and the sandbox sleeps
  after `sleepAfter` (4h) if polling stops. `destroy()` runs on terminal
  results, same as Daytona.

A workspace can also select the backend via `config.computeProvider`
(`"daytona"` | `"cloudflare"`) in the provider upsert — it overrides the
deployment-level `COMPUTE_PROVIDER`.

If unset, the deployment-level `DAYTONA_*` env vars apply, so a self-hosted
deployment can set one compute provider for all workspaces; on a hosted
deployment each workspace brings its own. Sandboxes are deleted when the
session reaches a terminal state, with an `autoStopInterval` safety ceiling
on Daytona (`sleepAfter` on Cloudflare).

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

The adapter already sends `env: { type: "pool" }`. That is not ISS-64.
ISS-64 is the missing **controller**: a Daytona snapshot that runs
`agent worker --pool`, a service-account key, and provision/reap of that
sandbox the way Outpost does for Devin. Until that snapshot exists, Cursor
BYOM still cannot clone a private repo from a Pile dispatch. Do not add
more adapter code for this.

Workers need outbound HTTPS only. There is no `metadata` field on v1 agents —
tracker context rides inside the prompt. v1 has no webhooks yet; status is
polled (same as Devin). The legacy v0 API does support HMAC-signed
`statusChange` webhooks if push is ever required. Pile's inbound webhook
route will accept them if Cursor adds v1 push.

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

`POST /workspaces/{org}/agent/sessions/{id}/poll` writes provider status back
and, when a new `prUrl` appears, records it as a session **artifact** (same
path as `POST …/artifacts`).

## Timeouts

A cron sweep cancels running sessions that exceed the workspace provider
`config.timeout` (minutes, default **60**) or go silent for
`config.inactivityTimeout` (minutes, default **20**). Silence is not “no Pile
activity”: the sweep probes `getState` (hash / compute `lastSeen`) or `poll`
before killing, so a Devin session that never streams still lives while the
provider payload changes. A probe error does **not** cancel; max-runtime is
the hard cap.

```json
{ "timeout": 60, "inactivityTimeout": 20 }
```

## Health

`POST /workspaces/{org}/agent/providers/{agentId}/health` probes credentials
and config without starting a session. A bad token should fail here, not
eight hours into a run.

## Webhooks

Providers can push instead of waiting for poll:

- Authenticated: `POST /workspaces/{org}/agent/providers/{agentId}/hooks`
  (workspace API key, `agent:write`).
- Inbound: `POST /webhooks/agent/{org}/{agentId}` with
  `X-Pile-Webhook-Secret` (or `Authorization: Bearer`) matching
  `config.webhookSecret`. The secret is write-only; reads show
  `hasWebhookSecret`.

Payload must include `session_id` / `sessionId` / `id` (provider-side id).
`status`, `result`, `pr_url` are applied onto the matching session and land
on the timeline. Each provider's `parseWebhook` maps its native shape first,
falling back to the generic parser:

- **Devin** — native statuses (`exit` → `completed`, etc.) via `session_id`.
- **Cursor** — `{agent: {id}, run: {id, status}}` or flat
  `agentId`/`runId`; rebuilds the composite `<agentId>/<runId>` session id
  and maps `RUNNING`/`FINISHED`/`ERROR`/etc. Cursor Cloud Agents v1 still
  has no documented webhooks — poll remains the recovery path.
- **Codex** — `id`/`session_id` + OpenAI statuses (`in_progress`,
  `requires_action`, `failed`; `idle` → `completed`).
- **Flue / cf-agent** — `conversationId`/`conversation_id`/`sessionId` plus
  a settlement `outcome` (`completed`/`aborted`/`failed`) or tracker status.
- **codex-cli** — webhook payloads carry the tracker `sessionId`; the
  generic parser covers it.
- **devin-cli** — runs `devin -p` headlessly inside a Daytona sandbox using
  the workspace's `credentials.toml`; poll-only, no webhooks, and does not
  use the Devin organization sessions API. Verified live via Daytona sandbox
  dispatch (ISS-80).
- **cursor-cli** — runs `cursor-agent -p --force --trust` headlessly inside
  a Daytona sandbox using the workspace's Cursor API key; poll-only, does
  not use the Cursor cloud agents API.
  Verified live via Daytona sandbox dispatch (ISS-81).

## Agent environment (ISS-31)

Workspace-scoped files the agent can read without cloning the repo. This is
storage + fetch, **not** prompt injection (ISS-43 was canceled).

Allowed paths: `AGENTS.md`, `skills/<name>.md`, `rules/<name>.md`.

| route                                                   | perm         | notes               |
| ------------------------------------------------------- | ------------ | ------------------- |
| `GET /workspaces/{org}/agent/environment`               | `agent:read` | list                |
| `GET /workspaces/{org}/agent/environment/file?path=`    | `agent:read` | one file            |
| `PUT /workspaces/{org}/agent/environment`               | `admin`      | `{ path, content }` |
| `DELETE /workspaces/{org}/agent/environment/file?path=` | `admin`      |                     |

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

## API

| route                                                     | perm          | notes                                   |
| --------------------------------------------------------- | ------------- | --------------------------------------- |
| `GET /workspaces/{org}/agent/providers/catalog`           | `agent:read`  | agents + hosted/BYO fields              |
| `GET /workspaces/{org}/agent/providers`                   | `agent:read`  | secrets redacted (`hasToken` etc.)      |
| `PUT /workspaces/{org}/agent/providers/{agentId}`         | `admin`       | upsert; `mode` validates catalog fields |
| `DELETE /workspaces/{org}/agent/providers/{agentId}`      | `admin`       | revert to deployment defaults           |
| `POST /workspaces/{org}/agent/providers/{agentId}/health` | `admin`       | credential/config probe, no session     |
| `POST /workspaces/{org}/agent/providers/{agentId}/hooks`  | `agent:write` | authenticated push                      |
| `POST /webhooks/agent/{org}/{agentId}`                    | secret        | inbound push (`config.webhookSecret`)   |

## Custom agents

Any agent can integrate without a provider at all: the workspace API (issues,
comments, `agent/sessions`, `agent/sessions/{id}/activities`, webhooks, MCP)
is the full surface. Registering a new provider is for agents that want
dispatch + poll through the tracker's provider interface — see
`src/agents/provider.ts`.

- Verified end-to-end on Cloudflare Sandbox compute.
