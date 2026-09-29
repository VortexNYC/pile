# Onboarding — agent setup checklist

Everything a workspace needs to go from zero to a dispatched lane. Every step
is an API call; `GET /workspaces/{org}/agent/setup-status` is the machine-
readable version of this checklist — it reports `ready`/`missing` per provider.

```bash
BASE=https://pile.nyc
ORG=your_org_id
KEY=your_workspace_api_key
```

## 1. Workspace + API key

Create a workspace and mint an API key with `agent:read`, `agent:write`, and
`admin` permissions (tokens endpoint under `/workspaces/{org}/tokens`).

## 2. GitHub

Install the Pile GitHub App on the repos lanes will touch, then link the
installation:

```bash
curl -X POST "$BASE/workspaces/$ORG/github/installations" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"installationId": "<numeric id>"}'
```

Per repo, optionally pin a default agent and a `.pile/config.json` contract —
see `docs/agent-providers.md` ("Repo environment contract").

## 3. Provider credentials

```bash
curl "$BASE/workspaces/$ORG/agent/providers/catalog" \
  -H "Authorization: Bearer $KEY"            # which agents exist + required fields

curl -X PUT "$BASE/workspaces/$ORG/agent/providers/devin" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"mode":"hosted","token":"<provider api key>"}'

curl -X POST "$BASE/workspaces/$ORG/agent/providers/devin/health" \
  -H "Authorization: Bearer $KEY"            # credential probe, no session
```

## 4. Git identity (for lane-authored commits)

```bash
curl -X POST "$BASE/workspaces/$ORG/git/identities" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"repo":"owner/repo","name":"My Bot","email":"bot@example.com","githubUsername":"my-bot"}'
```

Name/email (+ optional signing-key reference and GitHub username) lanes sign
commits with.

## 5. Readiness check

```bash
curl "$BASE/workspaces/$ORG/agent/setup-status" -H "Authorization: Bearer $KEY"
# → {"githubConnected": true, "providers": [{"agentId":"devin","ready":true,"missing":[]}]}
```

## 6. First dispatch

```bash
ISSUE=$(curl -X POST "$BASE/workspaces/$ORG/issues" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"title":"first lane","repo":"owner/repo"}' | jq -r .id)

curl -X POST "$BASE/workspaces/$ORG/issues/$ISSUE/dispatch" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{}'
```

Watch the lane's event stream:
`GET /workspaces/{org}/agent/sessions/{id}/stream`.

## External agents

Agents Pile didn't dispatch register themselves instead — see
`POST /workspaces/{org}/agent/sessions/register` (returns a lane token for
`/report` + `/logs`). Pile tracks them like any dispatched lane.
