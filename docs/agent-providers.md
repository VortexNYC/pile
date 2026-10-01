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
  Per-provider images (`SANDBOX_CURSOR`/`Dockerfile.sandbox-cursor`, and the
  Devin/Codex equivalents) bake each CLI at build time so dispatch skips
  per-run install; verified end-to-end for cursor-cli on `CursorSandbox`
  (VTX-265).

A workspace can also select the backend via `config.computeProvider`
(`"daytona"` | `"cloudflare"`) in the provider upsert — it overrides the
deployment-level `COMPUTE_PROVIDER`.

If unset, the deployment-level `DAYTONA_*` env vars apply, so a self-hosted
deployment can set one compute provider for all workspaces; on a hosted
deployment each workspace brings its own. Sandboxes are deleted when the
session reaches a terminal state, with an `autoStopInterval` safety ceiling
on Daytona (`sleepAfter` on Cloudflare).
Daytona compute path verified live 2026-09-23 (ISS-92) against snapshot vortex-cli-runner-v2 and sandbox label scheme vortex.session.

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

`GET /workspaces/{org}/agent/sessions` returns the full session rows —
including `result` text — which gets heavy on poll loops. Pass `?summary=1`
(also on `GET …/agent/sessions/{id}`) for lane-row scalars only: `id`,
`issueId`, `agentId`, `provider`, `status`, `prUrl`, `prState`, the
timestamps, and the derived `stalled` badge. `pile fleet` and
`pile agent sessions watch` already use it; dashboards and other polling
consumers should too. Push consumers can subscribe to `/realtime` or the
session event stream instead of polling.

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

### Issue progress comment (PILE-290)

Every non-preflight lane keeps **one** comment on its issue
(`externalSource: "agent"`, `externalId: "{sessionId}:progress"`) that is
edited in place rather than re-posted — observability for anyone not running
`pile fleet`. It is posted when the lane first reports `running` and shows:

- the session link (provider URL, else the Pile session route) and the
  `pile agent sessions watch` command;
- the current step — the newest `action`/`thought`/`response`/`error`/
  `elicitation` activity;
- elapsed time plus an ETA from the median duration of the agent's last
  20 completed lanes in the workspace (flagged once overdue);
- branch / PR and the latest task list, when reported.

Activity edits refresh it immediately except `thought`/`response`, which are
throttled to one edit per 30s; no-op polls refresh elapsed/ETA at most every
5 minutes. On a terminal status it freezes with the final duration; the
separate completion/failure result comment still posts.

External lanes feed it through `POST …/agent/sessions/{id}/report` with two
optional fields alongside `status`/`result`/`prUrl`/`branch`:

```json
{
  "step": "Running tests",
  "todos": [
    { "content": "Read issue", "status": "completed" },
    { "content": "Run tests", "status": "in_progress" }
  ]
}
```

`todos` (≤50 items, `pending | in_progress | completed`) replaces the
displayed list wholesale; invalid lists return 400.

## Lane events

Every lane (agent session) has an append-only event stream in the workspace
DO. `GET /workspaces/{org}/agent/sessions/{id}/stream` serves it as raw SSE
(`id:` = event id, `event:` = type, `data:` =
`{id,type,message,payload,createdAt}`). With no `Last-Event-ID` it tails from
the newest event; `Last-Event-ID: 0` replays the whole run. The stream closes
once the session is terminal. Session-event writers: `applyAgentSessionResult`
/ `addAgentActivity` / `createAgentSession` in
`src/workspace/durable-object.ts`, PR sync + nudges in `src/agents/sweep.ts`.

Lifecycle, in order: `created` (a queued lane starts `waiting` and is
promoted to `created`) → `running` ⇄ `waiting` → `completed` | `failed` |
`canceled`. Each field change emits
`session.{field}`; the first transition into a terminal status emits
`session.terminal` then `session.summary`, and a `child.terminal` on the
parent lane if there is one. PR events keep landing after terminal, because
`syncOpenPrSessions` polls GitHub for every session with an open PR.

| type                                   | fires when                                                                                                                                                                                                                                                                                                | payload                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `activity`                             | Any activity is appended (`thought`, `response`, `error`, `elicitation`, …).                                                                                                                                                                                                                              | `{activity}` (the full activity row)                                        |
| `session.status`                       | Session status changes.                                                                                                                                                                                                                                                                                   | `{field, old, new}`                                                         |
| `session.result`                       | Result text changes.                                                                                                                                                                                                                                                                                      | `{field, old, new}`                                                         |
| `session.prUrl`                        | PR URL is first set or changes.                                                                                                                                                                                                                                                                           | `{field, old, new}`                                                         |
| `session.prState`                      | Session PR state changes (runner report or PR sync).                                                                                                                                                                                                                                                      | `{field, old, new}`                                                         |
| `session.branch`                       | Branch changes.                                                                                                                                                                                                                                                                                           | `{field, old, new}`                                                         |
| `session.terminal`                     | First transition from non-terminal to `completed`/`failed`/`canceled`.                                                                                                                                                                                                                                    | `{status}`                                                                  |
| `session.summary`                      | Same transition, right after `session.terminal`. One digest per run (see below).                                                                                                                                                                                                                          | `{status, durationMs, prUrl, branch, agentId, digest?}`                     |
| `session.needs_input`                  | An `elicitation` activity lands, meaning the lane is asking a human. Also notifies the human assignee (or the dispatcher) with `lane_needs_input`.                                                                                                                                                        | `{issueId}`                                                                 |
| `pr.ci_failed`                         | PR sync sees check runs go to `failing` (edge-triggered against the issue's previous `prCheckState`). Also nudges the lane.                                                                                                                                                                               | `{prUrl, headSha, checkState, failingChecks[]}`                             |
| `pr.conflict`                          | PR is open and GitHub reports `mergeable: false`. Deduped per `headSha`. Conflicts confined to the repo's `.pile/config.json` `conflict.generated` paths are fixed by a scripted sandbox run; anything else nudges the lane.                                                                              | `{prUrl, headSha}`                                                          |
| `pr.conflict_fix`                      | Deterministic conflict resolution (PILE-251): the scripted fixer's lifecycle — `started` (sandbox launched, merge+regen in flight) then `resolved`/`source_conflict`/`failed`. Only `source_conflict`/`failed` fall through to the lane.                                                                  | `{prUrl, headSha, state, files?}`                                           |
| `pr.conflict_lane`                     | The conflict needs an agent — source files are in the conflict set, the repo declares no `conflict.generated`, or the fixer failed. Fires `pr.conflict` event automations once per `headSha`; the nudge itself dedupes on delivery.                                                                       | `{prUrl, headSha}`                                                          |
| `pr.branch_update`                     | PR sync saw a managed lane PR (`issue-*` or the issue's linked branch) `behind` the base with no conflicts and fired GitHub update-branch. Deduped per `headSha`.                                                                                                                                         | `{prUrl, headSha}`                                                          |
| `pr.review_requested`                  | PR is open and has requested reviewers. Deduped per `headSha`.                                                                                                                                                                                                                                            | `{prUrl, headSha, reviewers}` (count)                                       |
| `pr.merged` / `pr.closed` / `pr.draft` | PR sync sees the PR state change to a non-`open` value.                                                                                                                                                                                                                                                   | `{prUrl, prState, headSha}`                                                 |
| `prompt.followup`                      | A follow-up prompt was delivered to the live lane: `POST …/prompt`, an issue comment, a PR review, or a CI/conflict nudge.                                                                                                                                                                                | `{prompt}` (route) · `{commentId}` · `{issueId}` · `{issueId, prUrl}`       |
| `prompt.followup_failed`               | The provider rejected a PR-review or CI/conflict follow-up.                                                                                                                                                                                                                                               | `{issueId}` or `{issueId, prUrl}`                                           |
| `prompt.followup_skipped`              | A follow-up was throttled inside the provider's throttle window, or had nowhere to land — lane not resumable (`failed`/`canceled`) or the provider has no follow-up channel.                                                                                                                              | `{commentId}` · `{issueId}` · `{issueId, prUrl}`                            |
| `issue.escalated`                      | Nudge budget exhausted: the lane already took 3 PR nudges (delivered or redispatched) on the current `headSha`, or 5 across its redispatch chain. Fires once per lane; posts an issue comment (lane, what failed, what was tried) and moves the issue to `triage`. No further nudges until a fresh retry. | `{issueId, prUrl, headSha?, reason, rounds, key}`                           |
| `child.terminal`                       | A child lane (`parentSessionId` set) reaches terminal. Written on the **parent's** stream.                                                                                                                                                                                                                | `{childSessionId, childIssueId, status, prUrl, branch, result}` (≤2000 chr) |
| `agent_session.created`                | `createAgentSession` ran for an issue. This is a realtime/webhook event (`emit`), **not** a session-stream row. Siblings: `agent_session.updated/completed/failed/canceled`.                                                                                                                              | `{session, issue}`                                                          |
| type                                   | fires when                                                                                                                                                                                                                                                                                                | payload                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------                                                                                                                              | --------------------------------------------------------------------------- |
| `activity`                             | Any activity is appended (`thought`, `response`, `error`, `elicitation`, …).                                                                                                                                                                                                                              | `{activity}` (the full activity row)                                        |
| `session.status`                       | Session status changes.                                                                                                                                                                                                                                                                                   | `{field, old, new}`                                                         |
| `session.result`                       | Result text changes.                                                                                                                                                                                                                                                                                      | `{field, old, new}`                                                         |
| `session.prUrl`                        | PR URL is first set or changes.                                                                                                                                                                                                                                                                           | `{field, old, new}`                                                         |
| `session.prState`                      | Session PR state changes (runner report or PR sync).                                                                                                                                                                                                                                                      | `{field, old, new}`                                                         |
| `session.branch`                       | Branch changes.                                                                                                                                                                                                                                                                                           | `{field, old, new}`                                                         |
| `session.terminal`                     | First transition from non-terminal to `completed`/`failed`/`canceled`.                                                                                                                                                                                                                                    | `{status}`                                                                  |
| `session.summary`                      | Same transition, right after `session.terminal`. One digest per run (see below).                                                                                                                                                                                                                          | `{status, durationMs, prUrl, branch, agentId, digest?}`                     |
| `session.needs_input`                  | An `elicitation` activity lands, meaning the lane is asking a human. Also notifies the human assignee (or the dispatcher) with `lane_needs_input`.                                                                                                                                                        | `{issueId}`                                                                 |
| `pr.ci_failed`                         | PR sync sees check runs go to `failing` (edge-triggered against the issue's previous `prCheckState`). Also nudges the lane.                                                                                                                                                                               | `{prUrl, headSha, checkState, failingChecks[]}`                             |
| `pr.conflict`                          | PR is open and GitHub reports `mergeable: false`. Deduped per `headSha`. Also nudges the lane.                                                                                                                                                                                                            | `{prUrl, headSha}`                                                          |
| `pr.review_requested`                  | PR is open and has requested reviewers. Deduped per `headSha`.                                                                                                                                                                                                                                            | `{prUrl, headSha, reviewers}` (count)                                       |
| `pr.merged` / `pr.closed` / `pr.draft` | PR sync sees the PR state change to a non-`open` value.                                                                                                                                                                                                                                                   | `{prUrl, prState, headSha}`                                                 |
| `prompt.followup`                      | A follow-up prompt was delivered to the live lane: `POST …/prompt`, an issue comment, a PR review, or a CI/conflict nudge.                                                                                                                                                                                | `{prompt}` (route) · `{commentId}` · `{issueId}` · `{issueId, prUrl}`       |
| `prompt.followup_failed`               | The provider rejected a PR-review or CI/conflict follow-up.                                                                                                                                                                                                                                               | `{issueId}` or `{issueId, prUrl}`                                           |
| `prompt.followup_skipped`              | A follow-up was throttled inside the provider's throttle window, or had nowhere to land — lane not resumable (`failed`/`canceled`) or the provider has no follow-up channel.                                                                                                                              | `{commentId}` · `{issueId}` · `{issueId, prUrl}`                            |
| `child.terminal`                       | A child lane (`parentSessionId` set) reaches terminal. Written on the **parent's** stream.                                                                                                                                                                                                                | `{childSessionId, childIssueId, status, prUrl, branch, result}` (≤2000 chr) |
| `agent_session.created`                | `createAgentSession` ran for an issue. This is a realtime/webhook event (`emit`), **not** a session-stream row. Siblings: `agent_session.updated/completed/failed/canceled`.                                                                                                                              | `{session, issue}`                                                          |

Other rows that also land on the stream: `session.url` /
`session.providerSessionId` (same `{field, old, new}` shape), `issue.prUrl` /
`issue.prState` / `issue.branch` / `issue.status` (issue writeback),
`lane.queued` / `lane.dedupe` (pre-dispatch dedupe), and `log` (runner log
lines, message only).

`session.summary`: the `digest` key appears only when the provider's `result`
is JSON with a `digest` object, e.g.
`{durationSec, filesChanged, commits}`. Plain-text results just omit it.
`durationMs` is measured from session `createdAt`. The event fires exactly
once per run, on the first terminal transition. Later terminal→terminal
updates (a late poll, a webhook replay, cancel after completion) don't emit it
again. A follow-up prompt that moves the session back to `running` starts a
new run, and that run's own terminal transition emits a new summary.

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
  Dedicated `DevinSandbox` per-provider image verified live end-to-end (ISS-90, 2026-09-23).
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
Stream-json live events verified (ISS-99).

Live transcript streaming verified (ISS-98).

## Repo environment contract — `.pile/config.json`

A repo can commit `.pile/config.json` at its root to declare the environment
lanes run in. The file is read at dispatch time through the GitHub contents
API (resolved against the issue's branch when set), and every field is
optional:

```json
{
  "agents": ["devin", "devin-cli"],
  "model": "swe-2",
  "setup": ".pile/setup.sh",
  "env": ["DATABASE_URL", "NPM_TOKEN"]
}
```

| field      | effect                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`   | Allowlist — dispatch with any other agentId is rejected (400).                                                                                 |
| `model`    | Default model when the dispatch request doesn't name one.                                                                                      |
| `setup`    | Documented setup hook. `.pile/setup.sh` runs after clone either way.                                                                           |
| `env`      | Env-var allowlist — caller-supplied `extraEnv` keys not named here are dropped before they reach the lane. Infra env (lane DB etc.) is exempt. |
| `triggers` | Event→lane triggers — see below.                                                                                                               |

### Event→lane triggers

`triggers` maps repo events to lane dispatches — one primitive for review,
triage, plan, mention, and future event-driven lanes:

```json
{
  "triggers": [
    { "on": "pr.opened", "agent": "devin-cli", "prompt": "Review this PR." },
    { "on": "issue.created", "agent": "devin", "prompt": "Triage this issue." },
    {
      "on": "label.added",
      "label": "needs-plan",
      "agent": "devin",
      "model": "swe-2",
      "prompt": "Write an implementation plan."
    },
    { "on": "mention", "agent": "devin-cli", "prompt": "Answer the mention." }
  ]
}
```

| `on`             | fires when                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `issue.created`  | A GitHub issue is opened in the repo (and mirrored into Pile).                                  |
| `pr.opened`      | A pull request is opened.                                                                       |
| `pr.synchronize` | New commits are pushed to a pull request.                                                       |
| `ci.failed`      | The sweep sees a lane PR's checks go red (`pr.ci_failed`).                                      |
| `mention`        | A human comment on a mirrored issue or PR contains `handle` (default `@pile`). Bots never fire. |
| `label.added`    | A label is added to a mirrored issue or a PR — only `label` when set, any label otherwise.      |

Each matching trigger dispatches `agent` (subject to the `agents` allowlist)
with `prompt` plus the event details as lane instructions; `model` falls back
to the top-level `model`, and the `env` allowlist applies. PR events land on
the issue that owns the PR branch; other PRs get a per-PR issue
(`repo:github:<owner>:<repo>:pr:<n>`), created only when a trigger matches.
Triggers are read from the repo's default branch, never the PR head, and are
processed by the same `fireEventAutomations` path as workspace event
automations — which accept these event names as `triggerValue` too. Dispatch
keeps the one-active-lane-per-issue guard, so an event on an issue whose lane
is still running is skipped (logged).

Repositories that also install the Pile GitHub App get a per-repo default
agent: `PATCH /workspaces/{org}/github/installations/{id}` with
`{"defaultAgentId": "devin-cli"}`. Dispatch on an issue in that repo uses it
when the request doesn't name an agent.
