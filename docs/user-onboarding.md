# User & Agent Onboarding

End-to-end quickstart for getting a human workspace and its agents connected to Pile. Production host: `https://pile.nyc` (console at `https://app.pile.nyc`).

## 1. Sign up and create a workspace

**Web (humans):** sign in at `https://app.pile.nyc` and visit `/app/onboarding`. The form calls `POST /workspaces/onboard` with `seedStarterIssues: true` and shows the guided checklist — one-time API key, CLI command, and MCP URL.

**API:**

```bash
curl -X POST https://pile.nyc/workspaces/onboard \
  -H "Cookie: better-auth.session_token=…" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme","slug":"acme","seedStarterIssues":true}'
```

Returns `{ workspace, team, token, quickstart }` — `token` is a workspace-scoped admin API key shown only once, and `quickstart` carries `mcpUrl`, a ready-to-paste `cliSetupCommand`, and the seeded starter-issue IDs.

Check provisioning progress any time:

```bash
curl https://pile.nyc/workspaces/{organizationId}/onboarding-checklist \
  -H "Authorization: Bearer $PILE_API_KEY"
# -> { hasApiKey, hasAgentProvider, hasFirstIssue, mcpUrl, pluginManifestUrl }
```

## 2. Configure the pile CLI

```bash
pile config set --base-url https://pile.nyc --api-key $PILE_API_KEY
pile issues list --workspace <organizationId>
```

Config lives in `~/.pile/config.json`; `PILE_BASE_URL` / `PILE_API_KEY` env vars override it.

## 3. Connect MCP

The MCP server is streamable-HTTP at `https://pile.nyc/mcp`. Discovery manifests:

- `GET /.well-known/mcp.json` — agent kit manifest (skills, prompts, resource templates, OAuth endpoints)
- `server.json` (repo root) — MCP registry entry

**Static key auth:** set `Authorization: Bearer $PILE_API_KEY` on every MCP request — easiest for CLIs and scripts.

**OAuth 2.0 (interactive connectors):** Pile is a full authorization server with PKCE. The connector flow is:

1. `GET /.well-known/oauth-authorization-server` → discover `/oauth/authorize`, `/oauth/token`, `/oauth/register`
2. `POST /oauth/register` → dynamic client registration (RFC 7591)
3. `GET /oauth/authorize?client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256` → consent page → 302 with `code`
4. `POST /oauth/token` (`grant_type=authorization_code`, `code_verifier`) → workspace-scoped `access_token`

Useful built-in prompts: `triage-issue`, `morning-brief`, `session-handoff`, `memory-distill`. Useful resources: `pile://workspaces/{org}/agent-context`, `/issues/{id}`, `/documents/{id}`, `/customers/{id}`, `/memory/profile/{entityType}/{entityId}`.

## 4. Connect GitHub App and agent providers

```bash
curl https://pile.nyc/workspaces/{org}/agent/setup-status \
  -H "Authorization: Bearer $PILE_API_KEY"
```

Install the GitHub App via `GET /workspaces/{org}/github/installations`, then configure agent providers (Devin, Cursor, cf-agent) via `/workspaces/{org}/agent-providers/*`. `hasAgentProvider` flips true on the checklist once any provider config exists.

## 5. Use shared workspace memory

`workspace_memory` is durable, cross-session agent memory — facts keyed by `(entityType, entityId)` with `kind`, `validUntil` expiry, and supersede chains:

```bash
# recall — LIKE + BM25 + hybrid semantic (concepts, stems, trigrams)
GET  /workspaces/{org}/memory?entityType=issue&entityId=ISS-1
GET  /workspaces/{org}/memory?search=did+we+sweep+smith+corridor

# write — one fact, a batch, or extraction ("dreaming") from a source
POST /workspaces/{org}/memory          # { entityType, entityId, kind, fact, validUntil? }
POST /workspaces/{org}/memory/batch    # { memories: [...], documentIds: [...] }
POST /workspaces/{org}/memory/extract  # { sessionId|issueId|documentId|text, entityType?, entityId? }

# profile + lifecycle
GET    /workspaces/{org}/memory/profile?entityType=…&entityId=…
PATCH  /workspaces/{org}/memory/{id}   # update fact/kind/validUntil in place
DELETE /workspaces/{org}/memory/{id}   # forget head + superseded history
```

Long-form notes (handoffs, specs, decisions) go to documents — `POST /workspaces/{org}/documents` with `contentFormat: "markdown"` and `issueId` — never repo scratch files.

## 6. Unified search

`POST /workspaces/{org}/search` (or `GET …/search?q=`) returns issues, documents, memories, and tickets in one ranked result set — the same SMI-packed BM25 index behind `memoryRecall`.
