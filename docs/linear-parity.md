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

Vortex covers the core issue-tracking surface (issues, comments, labels, states, projects, cycles, attachments, history, subscribers, relations) plus a working GitHub integration, Linear migration, and Better Auth session support. The biggest gaps versus Linear are:

1. **Search & filtering** — Linear has rich search, issue filters, custom views, and semantic search. Vortex has only basic `status`/`priority`/`assignee`/`project`/`cycle`/`label` list filters and a `search` text parameter on issues.
2. **Teams** — Linear is multi-team inside an organization. Vortex has workspaces (Better Auth organizations) and teams, with per-team issue scoping and visibility.
3. **Notifications & outbound webhooks** — Linear has user notifications, delivery preferences, and outgoing webhooks. Vortex has inbound GitHub webhooks only.
4. **Advanced project/cycle objects** — Linear has initiatives, roadmaps, milestones, project updates, and release pipelines. Vortex has projects and cycles.
5. **Agent/AI surfaces** — Linear has agent sessions, activities, skills, and AI conversations. Vortex has agent sessions and activities; skills/conversations are not yet modeled.
6. **CLI / SDK / docs parity** — Vortex has an OpenAPI-generated client and MCP tools but no standalone CLI parity, no GraphQL API, and no published docs site.

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

| Domain                                | Linear surface (representative)                                                                                                                                         | Vortex status                                                                   | Notes / gap                                                                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth & sessions**                   | `viewer`, `authenticationSessions`, `logout`, OAuth, passkeys, SAML/SCIM                                                                                                | Partial                                                                         | Better Auth email/password mounted at `/api/auth/*`; workspace tokens for agents. OAuth/passkeys/SAML not configured.                                                            |
| **Users & memberships**               | `users`, `teams/members`, `userUpdate`, `organization`                                                                                                                  | Done                                                                            | Better Auth `user`/`member`/`invitation` tables; human + agent users live in `user`; memberships/invitations are Better Auth.                                                    |
| **Teams**                             | `teams`, `teamCreate`, `teamUpdate`, `teamDelete`, `teamMemberships`, `teamSettings`                                                                                    | Done                                                                            | `GET/POST/PATCH/DELETE /workspaces/{id}/teams` + `/.../members` using Better Auth `team` and `teamMember` tables.                                                                |
| **Issues**                            | `issue`, `issues`, `issueCreate`, `issueUpdate`, `issueArchive`, `issueDelete`, `issueBatchUpdate`, `issueSearch`, `issueRelations`, `issueHistory`, `issueSubscribers` | Partial                                                                         | Full CRUD, history, subscribers, relations, identifiers (`KEY-123`). No batch update, no search, no reactions, no parent/child beyond `relations` import, no triage/resolutions. |
| **Comments**                          | `comment`, `comments`, `commentCreate`, `commentUpdate`, `commentDelete`, `commentResolve`, `commentUnresolve`, `reactions`                                             | Partial                                                                         | CRUD for issue/PR comments. No `resolve`/`unresolve` or reactions.                                                                                                               |
| **Labels**                            | `issueLabels`, `issueLabelCreate`, `issueLabelUpdate`, `issueLabelDelete`, `issueLabelArchive`                                                                          | Done                                                                            | Full CRUD. GitHub label sync exists.                                                                                                                                             |
| **States / workflow**                 | `teams/states`, `workflowStateCreate`, etc.                                                                                                                             | Done                                                                            | `states` table + CRUD. Migration maps Linear state types.                                                                                                                        |
| **Projects**                          | `projects`, `projectCreate`, `projectUpdate`, `projectArchive`, `projectUpdateReminder`, `projectStatus`                                                                | Partial                                                                         | `projects` table + CRUD. No project updates, reminders, milestones, or status posts.                                                                                             |
| **Cycles**                            | `cycles`, `cycleCreate`, `cycleUpdate`, `cycleArchive`, `cycleShiftAll`, `cycleStartUpcomingCycleToday`                                                                 | Partial                                                                         | `cycles` table + CRUD. GitHub milestones map to cycles. No cycle shifting or start-today logic.                                                                                  |
| **Initiatives / roadmaps / releases** | `initiatives`, `initiativeCreate/Update/Delete`, `roadmaps`, `roadmapCreate`, `releasePipelines`, `release`                                                             | Missing                                                                         | Not modeled.                                                                                                                                                                     |
| **Documents**                         | `documents`, `documentCreate/Update/Delete`, `documentContentHistory`                                                                                                   | Missing                                                                         | Not modeled.                                                                                                                                                                     |
| **Customers**                         | `customers`, `customerNeeds`, `customerStatuses`, `customerTiers`                                                                                                       | Missing                                                                         | Not modeled.                                                                                                                                                                     |
| **Attachments**                       | `attachments`, `attachmentCreate/Delete/Update`, `attachmentLink*` (GitHub, Slack, etc.)                                                                                | Partial                                                                         | `attachments` table and route. GitHub attachments via migration. No deep link types (Slack, Intercom, etc.).                                                                     |
| **Search & filters**                  | `search`, `issueSearch`, `customViews`, `customViewCreate`, `aiConversation*`, `semanticSearch`                                                                         | Missing                                                                         | No search index, no custom views, no AI conversation/activity surfaces.                                                                                                          |
| **Notifications**                     | `notifications`, `notificationSubscriptionCreate`, `notificationDeliveryPreferences`, `pushSubscriptions`                                                               | Missing                                                                         | Only `issueSubscribers`; no delivery, email, or push.                                                                                                                            |
| **Webhooks**                          | `webhooks`, `webhookCreate/Update/Delete`, `oauthClient*`                                                                                                               | Partial                                                                         | Inbound GitHub webhooks + delivery idempotency. No outbound Vortex webhooks or OAuth app management.                                                                             |
| **Integrations**                      | `integration*`, `jira*`, `github`, `gitlab`, `slack`, `zendesk`                                                                                                         | Partial                                                                         | GitHub App install + issue/comment/PR/label/milestone/assignee sync. No Slack/Jira/GitLab/Zendesk.                                                                               |
| **Import / migration**                | `import` tooling, CSV, Jira                                                                                                                                             | Partial                                                                         | `POST /workspaces/{id}/migrate/linear` imports a Linear team into a Vortex workspace. No Jira/CSV.                                                                               |
|                                       | **Agent / AI surfaces**                                                                                                                                                 | `agentSessions`, `agentActivities`, `agentSkills`, `aiConversation*`, `prompt*` | Partial                                                                                                                                                                          | `agent_sessions` and `agent_activities` D1 tables plus `GET/POST/PATCH` routes; provider dispatch persists sessions. No skills or AI conversation model yet. |
| **Audit / admin**                     | `auditEntries`, `auditEntryTypes`, `usage`, `emailIntakeAddress`                                                                                                        | Missing                                                                         | No audit log or admin intake.                                                                                                                                                    |
| **API shape**                         | GraphQL single endpoint, typed SDK, Relay pagination                                                                                                                    | Partial                                                                         | Hono/OpenAPI REST with generated OpenAPI/MCP/client. No GraphQL. Pagination is cursor-based on `createdAt,id`.                                                                   |
| **CLI**                               | `@linear/cli` style commands                                                                                                                                            | Partial                                                                         | `packages/cli` exists but is minimal; not feature-complete.                                                                                                                      |
| **MCP**                               | MCP server exposure                                                                                                                                                     | Partial                                                                         | `src/mcp/server.ts` exposes OpenAPI routes as tools. Grows automatically with routes.                                                                                            |
| **Docs**                              | developers.linear.app style docs                                                                                                                                        | Missing                                                                         | No published docs site or generated guides.                                                                                                                                      |

## Concrete operation counts from the schema

| Root         | Count | Top resource prefixes                                                                                                                            |
| ------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Query        | 170   | `issue*`, `project*`, `initiative*`, `agent*`, `customer*`, `release*`, `team*`, `document*`, `search`, `auditEntries`                           |
| Mutation     | 374   | `issue*`, `project*`, `initiative*`, `integration*`, `attachment*`, `customer*`, `cycle*`, `agent*`, `comment*`, `team*`, `user*`, `webhook*`    |
| Subscription | 82    | `issue*`, `document*`, `project*`, `team*`, `agent*`, `comment*`, `notification*`, `initiative*`, `roadmap*`, `cycle*`, `favorite*`, `workflow*` |

Vortex currently exposes roughly **50 HTTP routes**. Linear's public GraphQL surface has **626 root operations** (170 + 374 + 82), so Vortex covers the high-frequency subset but not the long tail.

## Biggest blockers to "never touch Linear again"

1. **Search and custom views** — agents and users cannot find issues beyond simple list filters.
2. **Notifications / outbound webhooks** — Vortex cannot notify external systems when issues change, which breaks many integrations.
3. **Initiatives / roadmaps / milestones** — roadmap planning is missing.
4. **Slack/Zendesk/GitLab/Intercom integrations** — only GitHub is wired.
5. **Published docs / SDK / CLI** — the API is OpenAPI-first but lacks a docs site and a full CLI.

## Recommended next slices

Based on the gap map and the current backend-first priority, the next high-leverage slices are:

1. **Outbound webhooks + notification delivery** — unblocks integrations and dogfooding.
2. **Issue search and indexing** — full-text + filter DSL.
3. **Initiatives / roadmaps** — project planning surface.
4. **Slack / Zendesk / GitLab / Intercom integrations** — expand beyond GitHub.

## How to update this document

When a domain moves from **Missing** to **Partial** or **Done**, update this file and the relevant GitHub issue. When a new major capability ships, add it to the Vortex status column and adjust the executive summary.
