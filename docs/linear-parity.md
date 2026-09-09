# Linear API / CLI / MCP / Docs — Parity Audit

This is the durable gap map for replacing Linear operationally. It is based on Linear's public GraphQL schema (`packages/sdk/src/schema.graphql` from `linear/linear`) and the Vortex codebase at the time of writing.

## Methodology

- Parsed the Linear SDK SDL with `graphql`'s `buildSchema`.
- Counts root fields: **170 queries**, **374 mutations**, **82 subscriptions**.
- Cross-referenced with Vortex `src/api/*.ts`, `src/global/schema.ts`, `src/mcp/mcp-tools.ts`, and `ROADMAP.md`.
- Status legend:
  - **Done** — shipped and wired in the API/DO/schema.
  - **Partial** — model or route exists, but coverage is thin.
  - **Missing** — not implemented.
  - **N/A** — not in scope for the backend-first target (e.g., native mobile UI).

## Executive summary

Vortex covers the core issue-tracking surface (issues, comments, labels, states, projects, cycles, attachments, history, subscribers, relations, reactions, batch updates) plus roadmaps, initiatives, a working GitHub integration, Linear migration, Better Auth session support, and a multi-provider agent dispatch layer (Devin cloud/outpost, Cursor cloud/BYOM, cf-agent) with cancel and live session streaming. The biggest gaps versus Linear are:

1. **Teams** — Linear is multi-team inside an organization. Vortex has workspaces (Better Auth organizations) and teams, with per-team issue scoping and visibility.
2. **Notifications & delivery preferences** — Linear has user notifications, delivery preferences, and outgoing webhooks. Vortex has in-app notifications and outbound webhooks for issue/comment lifecycle events, including retries and a delivery log. Per-user delivery preferences (in-app/webhook/email flags + muted types) via `GET/PUT /notification-preferences`, enforced in the notify path. No email/push transport yet.
3. **Agent/AI surfaces** — Linear has agent sessions, activities, skills, and AI conversations. Vortex has agent sessions and activities; skills/conversations are not yet modeled.
4. **CLI / SDK parity** — Vortex has an OpenAPI-generated client and MCP tools but no standalone CLI parity and no GraphQL API. The published docs site exists in `packages/docs` (Blume) with OpenAPI reference and `llms.txt`.
5. **Zendesk/GitLab/Intercom integrations** — GitHub and Slack are wired (Chat SDK adapter; mentions + `/vortex` slash command + channel notifications).

## Vortex surface inventory

Routes currently registered in `src/api/index.ts`:

```
GET    /workspaces
POST   /workspaces
GET    /workspaces/{id}
GET    /workspaces/slug/{slug}
GET    /workspaces/{organizationId}/issues
POST   /workspaces/{organizationId}/issues
GET    /workspaces/{organizationId}/issues/{id}
PATCH  /workspaces/{organizationId}/issues/{id}
DELETE /workspaces/{organizationId}/issues/{id}
POST   /workspaces/{organizationId}/issues/{id}/dispatch
GET    /workspaces/{organizationId}/issues/{issueId}/attachments
GET    /workspaces/{organizationId}/issues/{issueId}/comments
POST   /workspaces/{organizationId}/issues/{issueId}/comments
GET    /workspaces/{organizationId}/issues/{issueId}/comments/{id}
PATCH  /workspaces/{organizationId}/issues/{issueId}/comments/{id}
DELETE /workspaces/{organizationId}/issues/{issueId}/comments/{id}
GET    /workspaces/{organizationId}/issues/{issueId}/history
GET    /workspaces/{organizationId}/issues/{issueId}/relations
POST   /workspaces/{organizationId}/issues/{issueId}/relations
DELETE /workspaces/{organizationId}/issues/{issueId}/relations/{id}
GET    /workspaces/{organizationId}/issues/{issueId}/subscribers
POST   /workspaces/{organizationId}/issues/{issueId}/subscribers
DELETE /workspaces/{organizationId}/issues/{issueId}/subscribers/{id}
GET    /workspaces/{organizationId}/cycles
POST   /workspaces/{organizationId}/cycles
GET    /workspaces/{organizationId}/cycles/{id}
PATCH  /workspaces/{organizationId}/cycles/{id}
DELETE /workspaces/{organizationId}/cycles/{id}
POST   /workspaces/{organizationId}/github/install
POST   /workspaces/{organizationId}/github/users
POST   /workspaces/{organizationId}/labels
GET    /workspaces/{organizationId}/labels
GET    /workspaces/{organizationId}/labels/{id}
PATCH  /workspaces/{organizationId}/labels/{id}
DELETE /workspaces/{organizationId}/labels/{id}
POST   /workspaces/{organizationId}/linear-users
GET    /workspaces/{organizationId}/linear-users
GET    /workspaces/{organizationId}/linear-users/{linearId}
POST   /workspaces/{organizationId}/memberships
GET    /workspaces/{organizationId}/memberships
POST   /workspaces/{organizationId}/migrate/linear
POST   /workspaces/{organizationId}/projects
GET    /workspaces/{organizationId}/projects
GET    /workspaces/{organizationId}/projects/{id}
PATCH  /workspaces/{organizationId}/projects/{id}
DELETE /workspaces/{organizationId}/projects/{id}
POST   /workspaces/{organizationId}/roadmaps
GET    /workspaces/{organizationId}/roadmaps
GET    /workspaces/{organizationId}/roadmaps/{id}
PATCH  /workspaces/{organizationId}/roadmaps/{id}
DELETE /workspaces/{organizationId}/roadmaps/{id}
GET    /workspaces/{organizationId}/roadmaps/{id}/initiatives
POST   /workspaces/{organizationId}/initiatives
GET    /workspaces/{organizationId}/initiatives
GET    /workspaces/{organizationId}/initiatives/{id}
PATCH  /workspaces/{organizationId}/initiatives/{id}
DELETE /workspaces/{organizationId}/initiatives/{id}
POST   /workspaces/{organizationId}/states
GET    /workspaces/{organizationId}/states
GET    /workspaces/{organizationId}/states/{id}
PATCH  /workspaces/{organizationId}/states/{id}
DELETE /workspaces/{organizationId}/states/{id}
POST   /workspaces/{organizationId}/templates
GET    /workspaces/{organizationId}/templates
GET    /workspaces/{organizationId}/templates/{id}
PATCH  /workspaces/{organizationId}/templates/{id}
DELETE /workspaces/{organizationId}/templates/{id}
POST   /workspaces/{organizationId}/tokens
GET    /workspaces/{organizationId}/tokens
DELETE /workspaces/{organizationId}/tokens/{id}
GET    /workspaces/{organizationId}/ws
```

Plus `/openapi.json`, `/mcp`, `/api/auth/*`, `/github` webhooks, and health.

## Gap map by domain

| Domain                                | Linear surface (representative)                                                                                                                                         | Vortex status                                                                   | Notes / gap                                                                                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth & sessions**                   | `viewer`, `authenticationSessions`, `logout`, OAuth, passkeys, SAML/SCIM                                                                                                | Partial                                                                         | Better Auth email/password mounted at `/api/auth/*`; workspace tokens for agents. OAuth/passkeys/SAML not configured.                                                                                      |
| **Users & memberships**               | `users`, `teams/members`, `userUpdate`, `organization`                                                                                                                  | Done                                                                            | Better Auth `user`/`member`/`invitation` tables; human + agent users live in `user`; memberships/invitations are Better Auth.                                                                              |
| **Teams**                             | `teams`, `teamCreate`, `teamUpdate`, `teamDelete`, `teamMemberships`, `teamSettings`                                                                                    | Done                                                                            | `GET/POST/PATCH/DELETE /workspaces/{id}/teams` + `/.../members` using Better Auth `team` and `teamMember` tables.                                                                                          |
| **Issues**                            | `issue`, `issues`, `issueCreate`, `issueUpdate`, `issueArchive`, `issueDelete`, `issueBatchUpdate`, `issueSearch`, `issueRelations`, `issueHistory`, `issueSubscribers` | Partial                                                                         | Full CRUD, history, subscribers, relations, batch update, identifiers (`KEY-123`), full-text search, status/resolution model. No triage queue, no `issueVcs*` (branch naming is convention), no estimates.    |
| **Comments**                          | `comment`, `comments`, `commentCreate`, `commentUpdate`, `commentDelete`, `commentResolve`, `commentUnresolve`, `reactions`                                             | Partial                                                                         | CRUD for issue/document comments, resolve/unresolve, reactions on issues and comments.                                                                                                            |
| **Labels**                            | `issueLabels`, `issueLabelCreate`, `issueLabelUpdate`, `issueLabelDelete`, `issueLabelArchive`                                                                          | Done                                                                            | Full CRUD. GitHub label sync exists.                                                                                                                                                                       |
| **States / workflow**                 | `teams/states`, `workflowStateCreate`, etc.                                                                                                                             | Done                                                                            | `states` table + CRUD. Migration maps Linear state types.                                                                                                                                                  |
| **Projects**                          | `projects`, `projectCreate`, `projectUpdate`, `projectArchive`, `projectUpdateReminder`, `projectStatus`                                                                | Partial                                                                         | `projects` table + CRUD. No project updates, reminders, milestones, or status posts.                                                                                                                       |
| **Cycles**                            | `cycles`, `cycleCreate`, `cycleUpdate`, `cycleArchive`, `cycleShiftAll`, `cycleStartUpcomingCycleToday`                                                                 | Partial                                                                         | `cycles` table + CRUD, rollover, capacity, `cycleShiftAll` and `start-today` endpoints. GitHub milestones map to cycles. `cycleArchive` not yet implemented.                                                                                                            |
| **Initiatives / roadmaps / releases** | `initiatives`, `initiativeCreate/Update/Delete`, `roadmaps`, `roadmapCreate`, `releasePipelines`, `release`                                                             | Partial                                                                         | `roadmaps` and `initiatives` tables with CRUD, roadmap-to-initiative nesting, date/status. Release pipelines and releases modeled in the DO with CRUD and project linking.                                                                               |
| **Documents**                         | `documents`, `documentCreate/Update/Delete`, `documentContentHistory`                                                                                                   | Done                                                                            | `documents` + `document_content_history` + `document_spaces` + `document_shares` + `document_watchers` in the DO; BlockNote JSON content, spaces (Confluence-style), nested pages, project/issue/initiative linkage, trash/restore, version history, page comments with resolve/unresolve, public share links, watch→notify, full-text doc search, templates (`is_template`). |                                                                                                                                                                                               |
| **Customers**                         | `customers`, `customerNeeds`, `customerStatuses`, `customerTiers`                                                                                                       | Done                                                                            | `customers`, `customer_tiers`, `customer_statuses`, `customer_needs` in the DO with full CRUD and issue/project need linking. |                                                                                                                                                                                               |
| **Attachments**                       | `attachments`, `attachmentCreate/Delete/Update`, `attachmentLink*` (GitHub, Slack, etc.)                                                                                | Partial                                                                         | `attachments` table and route. GitHub attachments via migration. No deep link types (Slack, Intercom, etc.).                                                                                               |
| **Search & filters**                  | `search`, `issueSearch`, `customViews`, `customViewCreate`, `aiConversation*`, `semanticSearch`                                                                         | Partial                                                                         | Full-text search across issue title, description, identifier, and comments; saved views with filters and search. No semantic/AI search.                                                                    |
| **Notifications**                     | `notifications`, `notificationSubscriptionCreate`, `notificationDeliveryPreferences`, `pushSubscriptions`                                                               | Partial                                                                         | In-app notifications for issue/comment lifecycle events; list/unread/mark read. Email transport is live via send_email. Push is still missing.                                                                                   |
| **Webhooks**                          | `webhooks`, `webhookCreate/Update/Delete`, `oauthClient*`                                                                                                               | Partial                                                                         | Outbound Vortex webhooks for issue/comment lifecycle events, retries, delivery log, and subscription CRUD. Inbound GitHub webhooks + idempotency. No OAuth app management.                                 |
| **Integrations**                      | `integration*`, `jira*`, `github`, `gitlab`, `slack`, `zendesk`                                                                                                         | Partial                                                                         | GitHub App install + issue/comment/PR/label/milestone/assignee sync. Slack via Chat SDK (OAuth install, verified events, mention/`/vortex` issue creation, channel notifications). No Jira/GitLab/Zendesk. |
| **Import / migration**                | `import` tooling, CSV, Jira                                                                                                                                             | Partial                                                                         | `POST /workspaces/{id}/migrate/linear` imports a Linear team into a Vortex workspace. No Jira/CSV.                                                                                                         |
|                                       | **Agent / AI surfaces**                                                                                                                                                 | `agentSessions`, `agentActivities`, `agentSkills`, `aiConversation*`, `prompt*` | Partial                                                                                                                                                                                                    | `agent_sessions`/`agent_activities` in the workspace DO; multi-provider dispatch (Devin, Cursor, cf-agent), cancel route, live UI-message-stream SSE tail, per-workspace provider credentials. No skills or AI conversation model yet. |
| **Audit / admin**                     | `auditEntries`, `auditEntryTypes`, `usage`, `emailIntakeAddress`                                                                                                        | Partial                                                                         | `audit_log` in the DO — issue/document/customer/release mutations recorded with field-level diffs. `GET /audit-log` with entity filters. No `emailIntakeAddress` or usage metering. |                                                                                                                                                                              |
| **API shape**                         | GraphQL single endpoint, typed SDK, Relay pagination                                                                                                                    | Partial                                                                         | Hono/OpenAPI REST with generated OpenAPI/MCP/client. No GraphQL. Pagination is cursor-based on `createdAt,id`.                                                                                             |
| **CLI**                               | `@linear/cli` style commands                                                                                                                                            | Partial                                                                         | `packages/cli` exists but is minimal; not feature-complete.                                                                                                                                                |
| **MCP**                               | MCP server exposure                                                                                                                                                     | Partial                                                                         | `src/mcp/server.ts` exposes OpenAPI routes as tools. Grows automatically with routes.                                                                                                                      |
| **Docs**                              | developers.linear.app style docs                                                                                                                                        | Done                                                                            | Blume docs site in `packages/docs` with OpenAPI reference, `llms.txt`, MCP, and public doc endpoints.                                                                                                                                                                |

## Concrete operation counts from the schema

| Root         | Count | Top resource prefixes                                                                                                                            |
| ------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Query        | 170   | `issue*`, `project*`, `initiative*`, `agent*`, `customer*`, `release*`, `team*`, `document*`, `search`, `auditEntries`                           |
| Mutation     | 374   | `issue*`, `project*`, `initiative*`, `integration*`, `attachment*`, `customer*`, `cycle*`, `agent*`, `comment*`, `team*`, `user*`, `webhook*`    |
| Subscription | 82    | `issue*`, `document*`, `project*`, `team*`, `agent*`, `comment*`, `notification*`, `initiative*`, `roadmap*`, `cycle*`, `favorite*`, `workflow*` |

Vortex currently exposes **113 OpenAPI paths / 177 MCP tools**. Linear's public GraphQL surface has **626 root operations** (170 + 374 + 82), so Vortex covers the high-frequency subset but not the long tail.

## Biggest blockers to "never touch Linear again"

1. **Zendesk/GitLab/Intercom integrations** — GitHub and Slack are wired.
2. **Email/push transport** — delivery preferences are modeled and enforced; no email/push senders yet.
3. **Triage queue, estimates, OAuth apps** — smaller workflow gaps (see gap map).

## Recommended next slices

Based on the gap map and the current backend-first priority, the next high-leverage slices are:

1. **Zendesk / GitLab / Intercom integrations** — expand beyond GitHub and Slack.
2. **Published docs site and CLI parity** — make the OpenAPI/MCP surface usable as a docs site and a real CLI.

## How to update this document

When a domain moves from **Missing** to **Partial** or **Done**, update this file and the relevant GitHub issue. When a new major capability ships, add it to the Vortex status column and adjust the executive summary.
