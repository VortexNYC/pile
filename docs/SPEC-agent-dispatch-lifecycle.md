# Spec: Agent Dispatch Lifecycle Improvements

## Objective

Make agent runs in Pile behave like Linear agent sessions: a single active session per issue, visible lifecycle state, automatic result/PR writeback to the issue, and lifecycle events that webhooks and realtime consumers can subscribe to.

## Tech Stack

- Hono + `@hono/zod-openapi` for API routes
- Drizzle ORM on D1 (metadata) and Durable Object SQLite (workspace state)
- Zod for validation
- Existing `WorkspaceDO` RPC methods and event/notification paths
- No new dependencies

## Data Model Changes

- `workspaceAgentSessions` schema unchanged.
- `RealtimeEvent` gains `agent_session.created`, `agent_session.updated`, `agent_session.completed`, `agent_session.failed`, `agent_session.canceled`.
- `AgentProviderSession` gains optional `prUrl`, `prState`, `branch` so providers can return PR artifacts separate from the session dashboard `url` and result text.

## API Surface

No new routes. Existing routes updated:

- `POST /workspaces/{organizationId}/issues/{id}/dispatch`
  - Rejects with `409` if an active session already exists for the issue.
  - Adds a `thought` activity immediately.
  - On provider failure, marks session `failed` and adds an `error` activity.
  - On success, applies the provider result through `applyAgentSessionResult`.
- `POST /workspaces/{organizationId}/agent/sessions/{id}/poll`
  - Calls `applyAgentSessionResult` with the provider `AgentProviderSession`.
- `PATCH /workspaces/{organizationId}/agent/sessions/{id}`
  - Calls `applyAgentSessionResult` with the patched fields.
- `POST /workspaces/{organizationId}/agent/sessions/{id}/cancel`
  - Calls `applyAgentSessionResult` with `status: "canceled"`.

## Lifecycle Rules

1. **One active session per issue.** `getActiveAgentSessionForIssue` is checked before `dispatchAgent` creates a new session.
2. **Session status drives issue status only at start and on terminal PR states.**
   - `created`, `running`, `waiting` move the issue to `in_progress` if it is currently `triage`, `backlog`, or `todo`.
   - `completed` does not auto-close the issue.
   - `prState: "merged"` maps to `done` and `prState: "closed"` maps to `canceled` only when the issue is not already terminal.
3. **Provider results write back to the issue.** `prUrl`, `prState`, and `branch` are copied to the issue when present.
4. **Terminal completion creates a comment.** When a session transitions to `completed`, a comment is added with the agent result and PR link, attributed to the agent (`externalAuthor: agentId`, `externalSource: "agent"`).
5. **Failures are recorded, not rolled back.** A failed session becomes `failed` with an `error` activity. The issue stays in its current status for a human to recover.
6. **Lifecycle events are emitted.** `agent_session.created/updated/completed/failed/canceled` are emitted through the existing `emit` path, which also delivers webhooks.

## Plan Mode (PILE-283)

Lanes can draft an approved approach before any code is written.

- **Dispatch `mode`** on `POST /issues/{id}/dispatch`: `build` (default), `plan`, `implement_plan`.
  - `plan` dispatches a lane with `purpose: "plan"` and `PILE_LANE_MODE=plan`. The runner never commits, pushes, or opens a PR for it. If the issue already has a plan, the new lane revises it, and `instructions` is used as the feedback (PlanEdit).
  - `implement_plan` dispatches a normal build lane, with the latest plan included as approved instructions. Returns `400` if the issue has no plan.
- **Plan comment.** When a plan lane completes, it posts its plan as an issue comment (`externalSource: "plan"`, `externalId: <plan session id>`). The newest such comment is the plan that `implement_plan` builds.
- **Comment triggers** (only when the issue has no live lane): `/plan [feedback]` drafts or revises the plan; `/implement_plan` approves the latest plan and dispatches a build lane from it. If a lane is live, the comment is treated as a normal follow-up.
- **Label trigger.** Adding a label named `plan` to an issue with no live lane dispatches a plan lane.
- Triggers reuse the agent from the issue's most recent lane, then the repo default agent, then `devin`. All of these are still gated by the `.pile/config.json` allowlist. A trigger that fails posts a `plan-mode` notice comment.
- Build lanes dispatched from a plan record a `lane.plan` session event that points to the plan's comment and session.

## Provider Parity

- `devin.ts`: `poll` extracts `prUrl`/`prState` from `pull_requests[0]`; `url` remains the Devin session dashboard link.
- `cursor.ts`: `poll` extracts `prUrl` and `branch` from `run.git.branches` when a `prUrl` is present.
- `cf-agent.ts`: no PR fields; `url` is the conversation URL and `result` is the final assistant text.

## Testing Strategy

- Unit/route tests in `src/api/agent-sessions.test.ts` and `src/agents/index.test.ts`.
- Mock provider now returns `prUrl`/`prState`/`branch` to exercise writeback.
- New tests:
  - Duplicate dispatch returns `409`.
  - Successful dispatch moves issue to `in_progress`.
  - Completed session writes `prUrl`/`prState` and creates a comment.
  - Failed dispatch leaves issue status unchanged and marks session `failed`.
  - Poll route writes PR fields from provider.

## Success Criteria

- `pnpm run check` passes.
- All agent session tests pass.
- `dispatchAgent` and `applyAgentSessionResult` are the only two places that mutate session+issue lifecycle state.

## Boundaries

- **Always:** run `pnpm run check` before commit; no `any`; no `eslint-disable`/`@ts-ignore`.
- **Ask first:** adding new migrations or changing the auth stack.
- **Never:** auto-merge; expose provider secrets; add frontend code.
