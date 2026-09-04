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
2. **Teams** — Linear is multi-team inside an organization. Vortex has workspaces only.
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
GET    /workspaces/{workspaceId}/issues
POST   /workspaces/{workspaceId}/issues
GET    /workspaces/{workspaceId}/issues/{id}
PATCH  /workspaces/{workspaceId}/issues/{id}
DELETE /workspaces/{workspaceId}/issues/{id}
POST   /workspaces/{workspaceId}/issues/{id}/dispatch
GET    /workspaces/{workspaceId}/issues/{issueId}/attachments
GET    /workspaces/{workspaceId}/issues/{issueId}/comments
POST   /workspaces/{workspaceId}/issues/{issueId}/comments
GET    /workspaces/{workspaceId}/issues/{issueId}/comments/{id}
PATCH  /workspaces/{workspaceId}/issues/{issueId}/comments/{id}
DELETE /workspaces/{workspaceId}/issues/{issueId}/comments/{id}
GET    /workspaces/{workspaceId}/issues/{issueId}/history
GET    /workspaces/{workspaceId}/issues/{issueId}/relations
POST   /workspaces/{workspaceId}/issues/{issueId}/relations
DELETE /workspaces/{workspaceId}/issues/{issueId}/relations/{id}
GET    /workspaces/{workspaceId}/issues/{issueId}/subscribers
POST   /workspaces/{workspaceId}/issues/{issueId}/subscribers
DELETE /workspaces/{workspaceId}/issues/{issueId}/subscribers/{id}
GET    /workspaces/{workspaceId}/cycles
POST   /workspaces/{workspaceId}/cycles
GET    /workspaces/{workspaceId}/cycles/{id}
PATCH  /workspaces/{workspaceId}/cycles/{id}
DELETE /workspaces/{workspaceId}/cycles/{id}
POST   /workspaces/{workspaceId}/github/install
POST   /workspaces/{workspaceId}/github/users
POST   /workspaces/{workspaceId}/labels
GET    /workspaces/{workspaceId}/labels
GET    /workspaces/{workspaceId}/labels/{id}
PATCH  /workspaces/{workspaceId}/labels/{id}
DELETE /workspaces/{workspaceId}/labels/{id}
POST   /workspaces/{workspaceId}/linear-users
GET    /workspaces/{workspaceId}/linear-users
GET    /workspaces/{workspaceId}/linear-users/{linearId}
POST   /workspaces/{workspaceId}/memberships
GET    /workspaces/{workspaceId}/memberships
POST   /workspaces/{workspaceId}/migrate/linear
POST   /workspaces/{workspaceId}/projects
GET    /workspaces/{workspaceId}/projects
GET    /workspaces/{workspaceId}/projects/{id}
PATCH  /workspaces/{workspaceId}/projects/{id}
DELETE /workspaces/{workspaceId}/projects/{id}
POST   /workspaces/{workspaceId}/states
GET    /workspaces/{workspaceId}/states
GET    /workspaces/{workspaceId}/states/{id}
PATCH  /workspaces/{workspaceId}/states/{id}
DELETE /workspaces/{workspaceId}/states/{id}
POST   /workspaces/{workspaceId}/templates
GET    /workspaces/{workspaceId}/templates
GET    /workspaces/{workspaceId}/templates/{id}
PATCH  /workspaces/{workspaceId}/templates/{id}
DELETE /workspaces/{workspaceId}/templates/{id}
POST   /workspaces/{workspaceId}/tokens
GET    /workspaces/{workspaceId}/tokens
DELETE /workspaces/{workspaceId}/tokens/{id}
GET    /workspaces/{workspaceId}/ws
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
3. **Teams** — a single workspace cannot represent an org with multiple teams.
4. **Initiatives / roadmaps / milestones** — roadmap planning is missing.
5. **Jira/Slack/Zendesk/GitLab integrations** — only GitHub is wired.
6. **Published docs / SDK / CLI** — the API is OpenAPI-first but lacks a docs site and a full CLI.

## Recommended next slices

Based on the gap map and the current backend-first priority, the next high-leverage slices are:

1. **Outbound webhooks + notification delivery** (#21 area / notifications) — unblocks integrations and dogfooding.
2. **Issue search and indexing** — full-text + filter DSL.
3. **Teams within a workspace** — org-wide multi-team model.
4. **Jira import** — import from the most common alternative.
5. **Initiatives / roadmaps** — project planning surface.

## How to update this document

When a domain moves from **Missing** to **Partial** or **Done**, update this file and the relevant GitHub issue. When a new major capability ships, add it to the Vortex status column and adjust the executive summary.
