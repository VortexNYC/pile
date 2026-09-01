# Vortex Issue Tracker — Agent Operating Notes

## Proof commands

Run from the repo root:

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run dev
pnpm run deploy
```

## Stack

- HTTP: Hono + `@hono/zod-openapi` for typed routes and OpenAPI docs.
- Data: Cloudflare D1 (Drizzle ORM) for global metadata; Durable Object SQLite for per-workspace issue state.
- Auth: Better Auth for humans; workspace-scoped API tokens for agents and automation.
- Tests: Vitest + `@cloudflare/vitest-pool-workers` (runs in `workerd`).

## Hard rules

- **pnpm only.** No npm, yarn, bun, npx.
- **No `any`.** Use `unknown` and narrow immediately.
- **No `eslint-disable`, `biome-ignore`, or `@ts-ignore`.** Fix the actual error.
- **Native-first.** Use Hono/Drizzle/Zod/Better Auth primitives; do not hand-roll OpenAPI or runtime mocks.
- **No AI attribution** in commits, PRs, or generated files.

## Important gotchas

- `WorkspaceDO` is branded as `Rpc.DurableObjectBranded` so `DurableObjectStub<WorkspaceDO>` exposes its methods directly. Do not add `as unknown as` casts to DO stubs.
- Durable Object SQLite requires `new_sqlite_classes` in the `[[migrations]]` section of `wrangler.toml`. `new_classes` is not enough and will fail at runtime.
- Keep `compatibility_date` pinned to a date the installed `workerd` binary supports. If the installed `workerd` only knows up to `2025-08-16`, do not use a later date in `wrangler.toml`.
- The `wrangler.toml` file is git-ignored; canonical config lives in `wrangler.toml.example`. Copy and customize it for local deploys.

## Where things live

- `src/api/index.ts` — main Hono/OpenAPIHono app, serves `/openapi.json`.
- `src/api/issues.ts` — issue route definitions and schemas.
- `src/workspace/durable-object.ts` — `WorkspaceDO` and SQLite migrations.
- `src/workspace/durable-object.test.ts` — DO tests using `runInDurableObject` from `cloudflare:test`.
- `src/global/schema.ts` — D1 Drizzle schema.
- `drizzle.config.ts` — Drizzle Kit config.
