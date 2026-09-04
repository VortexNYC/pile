# Spec: Agent Sessions and Activities API

## Objective

Make agents first-class actors in Vortex by tracking every agent run as a session with a stream of activities. A session is created when an agent is dispatched to an issue; activities capture thoughts, responses, errors, elicitations, and actions. The API lets users and other agents inspect progress, resume context, and audit agent work.

This is not a new auth system. It is the session/activity surface on top of Vortex's existing `WorkspaceIdentity` auth. Human and agent actors are both Better Auth `user` rows; agent users are marked with `metadata.type: "agent"`. Workspace access is verified through Better Auth `member` records, and API keys are Better Auth credentials linked to those users. The `actorId`/`actorType` fields map to `WorkspaceIdentity.id` (the underlying `user.id`) and `WorkspaceIdentity.type` (from `user.metadata` or API key metadata).

## Data Model

D1 tables (organization-scoped metadata):

- `agent_sessions`
  - `id` text PK
  - `organizationId` text FK organization.id
  - `issueId` text FK issue.id (logical; issues live in the Workspace DO)
  - `agentId` text — provider id, e.g. `"devin"`, `"mock"`
  - `provider` text — same as `agentId` for now; future may split provider from agent persona
  - `actorId` text — identity that started the session (from `WorkspaceIdentity.id`)
  - `actorType` text — `"user" | "agent"`
  - `status` text — `"created" | "running" | "waiting" | "completed" | "failed" | "canceled"`
  - `result` text nullable
  - `url` text nullable — external session URL (e.g. Devin session link)
  - `createdAt` / `updatedAt` text
- `agent_activities`
  - `id` text PK
  - `sessionId` text FK agent_sessions.id
  - `actorId` text nullable — who emitted the activity; null for provider events
  - `type` text — `"thought" | "response" | "error" | "elicitation" | "action" | "status"`
  - `message` text
  - `payload` text nullable — JSON blob for structured data
  - `createdAt` text

Indexes:

- `agent_sessions_organization_idx` on `agent_sessions(organizationId, createdAt DESC, id)`
- `agent_sessions_issue_idx` on `agent_sessions(issueId)`
- `agent_activities_session_idx` on `agent_activities(sessionId, createdAt)`

## API Surface

All routes live under `/workspaces/{organizationId}` and reuse `workspaceAuthMiddleware` (`rls("read")` / `rls("write")`).

- `GET /workspaces/{organizationId}/agent/sessions`
  - List sessions for a workspace, optionally `?issueId=` filtered.
  - Sorted `createdAt DESC, id`.
- `GET /workspaces/{organizationId}/agent/sessions/{sessionId}`
  - Get session with `activities` included.
- `POST /workspaces/{organizationId}/agent/sessions/{sessionId}/activities`
  - Append an activity. Body: `{ type, message, payload? }`.
  - Used by agents or provider webhooks to stream progress.
- `POST /workspaces/{organizationId}/agent/sessions/{sessionId}/poll`
  - Poll the provider for the latest session state and update the record.
- `PATCH /workspaces/{organizationId}/agent/sessions/{sessionId}`
  - Update `status`, `result`, `url` (e.g. by provider webhooks or admin).
- `POST /workspaces/{organizationId}/issues/{issueId}/dispatch`
  - Existing dispatch route; updated to create an `agent_sessions` row and a `created` activity before returning.

Authorization:

- `read` permission: list/get sessions.
- `write` permission: append activities, poll, patch, dispatch.

## Provider Integration

- `dispatchAgent` in `src/agents/index.ts` creates a session via `createAgentSession` before calling the provider, then returns the persisted session (id, agentId, issueId, status, url).
- Provider `poll` is invoked through `POST .../poll` or by an alarm; results update `status`, `result`, `url`.
- Provider webhooks can patch status and append activities; no polling required for all providers.

## Tests

- Unit tests in `src/global/agent-sessions.test.ts` for helper functions (create, list, get, add activity).
- Route tests in `src/api/agent-sessions.test.ts` for list, get, append, patch, and dispatch creating a session.
- Keep `src/agents/index.test.ts` passing; mock provider should create a session when called through dispatch.

## Boundaries

- **Always:** use Zod for request/response schemas; validate `payload` as JSON; run `pnpm run check` before commit.
- **Ask first:** changing the auth stack (e.g. replacing `workspaceTokens` with `@better-auth/api-key` or `@better-auth/agent-auth`); adding new migrations without generated SQL.
- **Never:** store raw provider secrets; use `any` or unchecked `unknown`.

## Success Criteria

- [ ] `POST /workspaces/{organizationId}/issues/{issueId}/dispatch` creates an `agent_sessions` row and returns the session id.
- [ ] `GET /workspaces/{organizationId}/agent/sessions` returns sessions for the workspace.
- [ ] `GET /workspaces/{organizationId}/agent/sessions/{sessionId}` returns the session with `activities`.
- [ ] `POST .../activities` appends a validated activity.
- [ ] `PATCH` and `poll` update session state.
- [ ] `pnpm run check` passes.

## Better Auth alignment

Current auth resolves to `WorkspaceIdentity { id, organizationId, type, permissions }`. The `actorId`/`actorType` columns in `agent_sessions` map directly to that identity. When Vortex migrates agent auth to Better Auth (`@better-auth/api-key` for workspace-scoped keys or `@better-auth/agent-auth` for the Agent Auth Protocol), the session/activity surface does not change: the middleware resolves a `WorkspaceIdentity` and the session records `actorId`/`actorType`.
