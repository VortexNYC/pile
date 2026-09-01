# Spec: Vortex Linear — Backend Migration

## Assumptions

1. Product is an **open-source, agent-native Linear alternative** (codename: Vortex Linear).
2. **No Notion.** Source of truth is Cloudflare primitives.
3. Target scale: **1000+ B2B workspaces**, ~20 users each.
4. Runtime: **Cloudflare Workers**.
5. Source-of-truth state lives in **one Durable Object per workspace**. Each DO has SQLite state and hibernated WebSocket subscriptions.
6. Global metadata (accounts, workspaces, users, billing) lives in **Cloudflare D1**.
7. HTTP layer: **Hono**. Validation: **Zod**. Package manager: **pnpm**.
8. Real-time: **Hibernated WebSocket subscriptions** inside Durable Objects.
9. Attachments: **R2** (deferred to v2).
10. Auth: **better-auth on D1 for human users; workspace-scoped API tokens for agents and GitHub Actions**.
11. The `/dispatch` contract is preserved and becomes a **generic agent session creation** endpoint, not a Devin-only integration. `/github` is the GitHub PR webhook.
12. Agents are first-class actors with workspace-scoped tokens, sessions, and activities.
13. Optional Notion/Linear/Slack/GitHub adapters are **deferred** to a future `sync` module.

## Objective

Migrate `notion-engineering-queue` from a Notion-backed Cloudflare Worker to a **real-time, multi-tenant, agent-first backend** built on Cloudflare Workers, Durable Objects, and D1.

## Capability Map

| Module id | Responsibility | Depends on |
|---|---|---|
| `platform` | Worker boot, env parsing, routing, middleware, errors | — |
| `global` | D1 tables: workspaces, users, billing, identity, auth | `platform` |
| `workspace-do` | Durable Object: issues, comments, history, projects, cycles, real-time | `platform`, `global` |
| `api` | HTTP endpoints for issues, dispatch, github, webhooks | `platform`, `global`, `workspace-do` |
| `realtime` | WebSocket/Server-Sent Event handlers | `workspace-do` |
| `agents` | Agent identity, sessions, multi-provider dispatch, GitHub webhook handler | `api`, `workspace-do` |
| `github` | Full GitHub App integration (install, issue/PR/comment sync, outbound API) (v2) | `agents` |
| `sync` | Migrations from Linear, Jira, GitHub; optional Notion/Linear/Slack/GitHub adapters (deferred) | `workspace-do` |

Build order: `platform` → `global` → `workspace-do` → `api` → `realtime` → `agents` → `sync`

## Design Patterns

- **Schema-first data model:** `src/schema/data-model.ts` is the single source of truth for D1 and DO tables. It drives generated TypeScript types and the OpenAPI document.
- **One Durable Object per workspace:** `WorkspaceDO` is the unit of isolation, state, and real-time. No shared workspace data.
- **Hibernated WebSockets:** Live issue updates and agent presence without keeping DOs awake.
- **Type-safe procedures:** Hono routes with Zod request/response schemas. A future v2 may introduce `query`/`mutation`/`action` builders; v1 stays simple.
- **Unified error catalog:** `src/errors/` defines one error shape, status mapping, and wire-redaction seam.
- **Context injection:** `ctx` carries `env`, `db`, `auth`, and the resolved `WorkspaceDO` stub to every handler.
- **Single-worker composition:** All modules mount into one Worker.
- **Better-auth on D1:** Human auth uses better-auth with the D1 adapter.

## Agent-First Integration

This is not a Devin integration. It is a generic agent-native issue tracker. The patterns to support are the ones that make Notion, Linear, Slack, and GitHub easy for agents:

- **Agent identity and workspace-scoped tokens:** every agent is an actor with its own token and permissions, just like a Slack bot or Linear app user.
- **Session lifecycle:** `POST /dispatch` creates an agent session; the agent posts activities (`thought`, `response`, `error`, `elicitation`) while it works.
- **Webhook events for agents:** `agent.mentioned`, `agent.assigned`, `agent.session.created`, `issue.updated`, `comment.created`.
- **Real-time delivery:** hibernated WebSockets push events to agents and users.
- **Action/approval flow:** agents can request approval; users approve/reject via the API.
- **Multi-provider dispatch:** the `dispatch` endpoint routes to any agent provider via an adapter (Devin, OpenAI, cloud agents).
- **OAuth and PAT support:** workspace admins install apps via OAuth; scripts/agents use PATs.
- **External platform adapters (deferred):** Notion/Linear/Slack/GitHub can call Vortex Linear's webhooks and API, not the other way around.

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers |
| Router | Hono |
| Validation | Zod |
| Global DB | Cloudflare D1 (SQLite) with Drizzle |
| Workspace DB | Durable Object SQLite |
| Attachments | Cloudflare R2 (v2) |
| Real-time | Durable Object hibernated WebSockets |
| Auth | better-auth on D1 + workspace-scoped API tokens |
| Testing | Vitest + Miniflare + `@cloudflare/vitest-pool-workers` |
| Package manager | pnpm |

## Commands

```bash
pnpm install
pnpm dev                 # wrangler dev
pnpm test                # vitest + Miniflare
pnpm typecheck           # tsc --noEmit
pnpm db:global:migrate   # apply D1 migrations
pnpm db:global:seed      # seed global metadata
pnpm deploy              # wrangler deploy
```

## Project Structure

```
src/
  platform/        # worker boot, env, auth, middleware, errors
  global/          # D1 tables and queries (Drizzle)
  workspace/       # WorkspaceDO class, schema, SQL, real-time
  api/             # Hono routes
  realtime/        # WebSocket/SSE endpoints
  dispatch/        # Devin and GitHub integration
  schema/          # Zod schemas + data model
  types/           # shared types
tasks/
  plan.md          # implementation plan
tests/
  *.test.ts
```

## Code Style

- No `any`. Use `unknown` + narrow.
- No `eslint-disable`, `@ts-ignore`, or `as any`.
- `pnpm` only.
- Durable Object SQL is raw but wrapped in typed helpers.
- Hono handlers are async. Errors are mapped to HTTP responses in one place.
- Secrets are never committed.

## Testing Strategy

- Unit tests for `WorkspaceDO` methods using Miniflare's in-memory storage.
- Route tests for Hono endpoints using local Workers runtime.
- Integration tests for `/dispatch` and `/github` with mocked Devin/GitHub payloads.
- `pnpm typecheck` is required before any commit.

## Boundaries

- **Always:** run `pnpm typecheck && pnpm test` before commit; use Zod for untrusted input; never commit secrets.
- **Ask first:** changing the repo name; adding a paid Cloudflare service; adding a public frontend.
- **Never:** reintroduce Notion as the source of truth; use `any`; use `npm`/`yarn`/`bun`.

## Success Criteria

- [ ] Worker boots without any Notion dependency.
- [ ] `WorkspaceDO` persists issues, comments, projects, cycles, and labels.
- [ ] D1 persists workspaces, users, and identity with better-auth.
- [ ] `POST /dispatch` creates a Devin session and stores the reference.
- [ ] `POST /github` updates PR state in the matching issue.
- [ ] GitHub Action still dispatches to the worker.
- [ ] `GET /issues`, `POST /issues`, `PATCH /issues/:id` work.
- [ ] Hibernated WebSocket endpoint streams issue updates (v1 or v2).

## Open Questions

1. **Repo name:** Keep `notion-engineering-queue` or rename to `vortex-linear` / `linear-for-agents`?
