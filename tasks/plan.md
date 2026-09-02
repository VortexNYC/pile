# Plan: Vortex Linear Backend Migration

## Implementation Order

Build the modules in dependency order: `platform` → `global` → `workspace-do` → `api` → `realtime` → `agents` → `sync`.

`sync` is deferred. `realtime` can ship after `api` if needed.

## Tasks

### 1. Bootstrap platform layer

- Add dependencies: `hono`, `zod`, `better-auth`, `@better-auth/d1-adapter` or equivalent, `drizzle-orm`, `drizzle-kit`, `postgres` or `pglite`, `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers`.
- Create `src/platform/env.ts` typed `Env`.
- Create `src/platform/errors.ts` with a unified error catalog and Hono error mapper.
- Create `src/types/index.ts` for shared types.
- Acceptance: `pnpm install && pnpm typecheck` passes.
- Verify: `pnpm typecheck`
- Files: `package.json`, `tsconfig.json`, `wrangler.toml`, `wrangler.toml.example`, `src/platform/env.ts`, `src/platform/errors.ts`, `src/types/index.ts`

### 2. Define schema and global D1

- Create `src/schema/data-model.ts` as the single source of truth for D1 and DO tables.
- Set up Drizzle for D1 with `drizzle.config.ts`.
- Create D1 tables: `workspaces`, `users`, `workspace_memberships`.
- Add `src/global/db.ts` and `src/global/workspaces.ts`.
- Acceptance: `pnpm db:global:migrate` creates tables and `pnpm db:global:seed` seeds a workspace.
- Verify: `pnpm typecheck` + local D1 query
- Files: `src/schema/data-model.ts`, `drizzle.config.ts`, `src/global/db.ts`, `src/global/workspaces.ts`

### 3. Set up auth

- Configure better-auth on D1 for human users.
- Add workspace-scoped API token creation and verification.
- Add `src/platform/auth.ts` with `requireUser` and `requireWorkspaceToken` middleware.
- Acceptance: can register a user and issue an agent token.
- Verify: unit tests for auth middleware
- Files: `src/platform/auth.ts`, `src/global/users.ts`, `src/global/tokens.ts`

### 4. Build the WorkspaceDO

- Create `src/workspace/durable-object.ts` (the `DurableObject` class).
- Initialize SQLite schema on first access: `issues`, `comments`, `projects`, `cycles`, `labels`, `history`.
- Add methods: `createIssue`, `getIssue`, `updateIssue`, `listIssues`, `addComment`, `setProject`, `setCycle`.
- Add `src/workspace/sql.ts` for typed raw SQL helpers.
- Acceptance: `WorkspaceDO` persists and returns issues in Miniflare tests.
- Verify: `pnpm test`
- Files: `src/workspace/durable-object.ts`, `src/workspace/sql.ts`, `src/workspace/queries.ts`

### 5. Wire the Hono API

- Create `src/api/index.ts` with the Hono app, auth middleware, and error middleware.
- Add routes: `GET /workspaces/:workspaceId/issues`, `POST /workspaces/:workspaceId/issues`, `GET /workspaces/:workspaceId/issues/:id`, `PATCH /workspaces/:workspaceId/issues/:id`.
- Resolve `WorkspaceDO` by `workspaceId` and call its methods.
- Add Zod schemas for request/response.
- Acceptance: API tests pass for issue CRUD.
- Verify: `pnpm test`
- Files: `src/api/index.ts`, `src/api/issues.ts`, `src/schema/zod.ts`

### 6. Build the agents module

- Create `src/agents/index.ts` with the agent registry and `POST /workspaces/:workspaceId/dispatch`.
- Add `src/agents/provider.ts` interface with a Devin adapter as the first implementation.
- Add `src/agents/sessions.ts` for session lifecycle and `src/agents/activities.ts` for `thought`/`response`/`error`/`elicitation`.
- Create a Devin session and store `sessionId` and `agentId` on the issue.
- Preserve the GitHub Action contract.
- Acceptance: `POST /workspaces/:workspaceId/dispatch` creates a session through the Devin adapter and updates the issue.
- Verify: `pnpm test`
- Files: `src/agents/index.ts`, `src/agents/provider.ts`, `src/agents/devin.ts`, `src/agents/sessions.ts`, `src/agents/activities.ts`

### 7. Port GitHub webhook

- Move `handleGithubWebhook` to `src/agents/github.ts`.
- Match PR to issue by repo and branch using `WorkspaceDO`.
- Update `pr` and `prState` on the issue.
- Acceptance: GitHub webhook updates the issue PR state.
- Verify: `pnpm test`
- Files: `src/agents/github.ts`

### 8. Add hibernated WebSockets

- Add `src/realtime/websocket.ts` inside `WorkspaceDO`.
- Add `src/api/realtime.ts` for the WebSocket upgrade endpoint.
- Broadcast `issue:updated` events to connected clients in the same workspace.
- Acceptance: a test client connects and receives an update broadcast.
- Verify: manual or `pnpm test`
- Files: `src/realtime/websocket.ts`, `src/api/realtime.ts`

### 9. Remove Notion

- Delete all Notion helpers, Notion env vars, and Notion tests.
- Update `README.md` and `wrangler.toml.example`.
- Acceptance: `grep -Ri notion src/ tasks/ README.md` returns nothing.
- Verify: `grep -Ri notion` + `pnpm test`
- Files: `src/index.ts`, `src/index.test.ts`, `README.md`, `wrangler.toml.example`

### 10. Rename repo (ask first)

- Rename the repository to `vortex-linear` or `linear-for-agents` if decided.
- Update package name and references.
- Acceptance: repo name and `package.json` name match.
- Verify: `git remote -v` and `package.json`
- Files: `package.json`, `README.md`

## Risks and Mitigations

| Risk                                                      | Mitigation                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Durable Object storage or CPU limits for a busy workspace | Shard by `workspaceId` already; if one workspace grows, split to per-project DOs later. |
| better-auth on D1 adapter not stable                      | Fallback to a custom token auth in `src/platform/auth.ts`.                              |
| Drizzle on D1 migration friction                          | Use `drizzle-kit` and local `wrangler d1 migrations` for dev and prod.                  |
| Real-time too complex for v1                              | Defer WebSockets to a v2 slice; build the core first.                                   |
| Long migration breaks existing tests                      | Migrate in the module order above; keep tests green per module.                         |
