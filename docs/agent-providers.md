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

| field | maps to |
|---|---|
| `computeApiKey` | `DAYTONA_API_KEY` |
| `computeApiUrl` | `DAYTONA_API_URL` (default `https://app.daytona.io/api`) |
| `computeSnapshot` | `DAYTONA_SNAPSHOT` |
| `computeVolumeId` | `DAYTONA_VOLUME_ID` |

If unset, the outpost queue still works — sessions wait for whatever workers
you've started manually. Everything above falls back to deployment-level env
vars (`DEVIN_TOKEN`, `DEVIN_OUTPOST`, `DAYTONA_*`), so a self-hosted
deployment can set one provider for all workspaces; on a hosted deployment
each workspace brings its own.

## API

| route | perm | notes |
|---|---|---|
| `GET /workspaces/{org}/agent/providers` | `agent:read` | secrets redacted (`hasToken` etc.) |
| `PUT /workspaces/{org}/agent/providers/{agentId}` | `admin` | upsert; unset fields keep existing values |
| `DELETE /workspaces/{org}/agent/providers/{agentId}` | `admin` | revert to deployment defaults |

## Custom agents

Any agent can integrate without a provider at all: the workspace API (issues,
comments, `agent/sessions`, `agent/sessions/{id}/activities`, webhooks, MCP)
is the full surface. Registering a new provider is for agents that want
dispatch + poll through the tracker's provider interface — see
`src/agents/provider.ts`.
