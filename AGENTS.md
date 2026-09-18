# Pile — Agent Operating Notes

## Proof commands

Run from the repo root before committing:

```bash
vp install
vp run check
vp run contract:check
vp run test
vp run knip
```

`vp run check` is Vite+ (`vp check`: format, lint, types). `contract:check` diffs generated artifacts and needs git — GitHub `ci.yml` owns it; do not put it on the vortex-ci sandbox path. Tests run in vortex-ci proof (`pnpm test`), same split as vortex-sign.

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
- Keep `compatibility_date` pinned to a date the installed `workerd` binary supports. It is currently aligned to `2026-07-30` for `workerd 1.20260730.1`; do not use a later date.
- The `wrangler.toml` file is the canonical, committed config and is not git-ignored. Do not move it to `wrangler.toml.example`.

## Git workflow

- Use the `gh` CLI for PRs and stacks.
- For stacked PRs in this repo, use the `github/gh-stack` extension (`gh stack init`, `gh stack add`, `gh stack submit`).
- Do not use `gt` / Graphite for this repo.

## Dogfooding

Pile is our own engineering source of truth. While working on this repo, agents must use the production Pile instance rather than Linear or Notion.

- Workspace: `org_vortex_main`
- Team for this repo: `Pile` (`ISS`)

For every non-trivial chunk of work:

1. Check `GET /workspaces/org_vortex_main/issues?identifier=ISS-N` for context.
2. Create or update an `ISS-*` issue describing the work.
3. Use the issue identifier in branch names and commit messages where practical.
4. Verify the change through the product API before reporting completion.
5. Actively look for opportunities to use the Pile API, CLI, SDK, or MCP for issue lifecycle (status, comments, assignments, branch/PR metadata) instead of `gh`, `git`, or external trackers. Default to the product for updates, verification, and triage.

## Where things live

- `src/api/index.ts` — main Hono/OpenAPIHono app, serves `/openapi.json`.
- `src/api/issues.ts` — issue route definitions and schemas.
- `src/workspace/durable-object.ts` — `WorkspaceDO` and SQLite migrations.
- `src/workspace/durable-object.test.ts` — DO tests using `runInDurableObject` from `cloudflare:test`.
- `src/global/schema.ts` — D1 Drizzle schema.
- `drizzle.config.ts` — Drizzle Kit config.
