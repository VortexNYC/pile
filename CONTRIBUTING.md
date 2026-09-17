# Contributing to Pile

Thanks for your interest in Pile — an open-source, agent-native issue tracker
on Cloudflare Workers.

## Getting started

```bash
pnpm install
pnpm dev          # wrangler dev
pnpm run test     # vitest (workerd pool)
```

Self-host your own instance with `pnpm run selfhost` — see README for details.

## Before opening a PR

Run the proof suite from the repo root:

```bash
vp install
vp run check          # format, lint, types (Vite+)
vp run contract:check # generated artifacts must match the tree
vp run test
vp run knip
```

`contract:check` regenerates `src/mcp/openapi.json`, `src/mcp/mcp-tools.ts`,
`packages/client/src/types.ts`, and `packages/cli/src/commands.ts` — commit the
regenerated files with your change.

## Rules

- **pnpm only.** No npm, yarn, bun, npx.
- **No `any`.** Use `unknown` and narrow immediately.
- **No `eslint-disable`, `biome-ignore`, or `@ts-ignore`.** Fix the actual error.
- **Native-first.** Prefer Hono/Drizzle/Zod/Better Auth primitives over
  hand-rolled equivalents.
- Small, focused PRs. Use the issue identifier in the branch name when one
  exists (e.g. `ISS-42-my-change`).

## Architecture map

- `src/api/index.ts` — Hono/OpenAPIHono app; serves `/openapi.json`
- `src/workspace/durable-object.ts` — per-workspace state (Durable Object SQLite)
- `src/global/schema.ts` — D1 Drizzle schema (global metadata, auth)
- `src/mcp/` — generated MCP tools from the OpenAPI surface
- `packages/cli`, `packages/client`, `packages/docs`, `packages/clipper`

## Reporting issues

Open a GitHub issue with reproduction steps. For security reports, do not open
a public issue — see SECURITY.md.
