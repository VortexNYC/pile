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

`vp run check` is Vite+ (`vp check`: format, lint, types). `contract:check` diffs generated artifacts and needs git — GitHub `ci.yml` owns it; do not put it on the CI path. Tests gate locally via the `vp` pre-push hook; CI is `deps → build (typecheck) → migrate+deploy` on `main`, owned by `cloudflare-ci` (`~/Projects/cloudflare-ci`). If CI behavior is wrong, fix it there — not here.

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
- **Tests ride with source.** A PR that changes `src/` must change a `*.test.ts`, or carry a `No tests: <reason>` line in its description. The `diff-coverage` workflow enforces this (`vp run diff-coverage` locally, against `origin/main`).

## Frontend scope (apps/web)

The console is a **human collaboration surface, not a control plane**.

- Belongs: reading and browsing workspace data (issues, documents,
  tickets, customers, notifications), human↔agent coordination
  (comments, triage, approvals, dispatch review), and light interactive
  edits a person makes by hand.
- Does not belong: write-heavy or agent-facing operations — bulk
  mutations, imports/migrations, automation config, credential plumbing.
  The API, CLI, SDK, and MCP are the first-class interfaces for those;
  if the primary user is an agent or a script, it gets no UI surface.
- UI is Kumo components + Phosphor icons only — no hand-rolled
  components, minimal pages backed by real API data.

## Important gotchas

- `WorkspaceDO` is branded as `Rpc.DurableObjectBranded` so `DurableObjectStub<WorkspaceDO>` exposes its methods directly. Do not add `as unknown as` casts to DO stubs.
- Vitest 4 ignores `vitest.workspace.ts`; projects are declared in `test.projects` inside `vitest.config.ts`. `*.node.test.ts` files run under the plain Node pool (the `node` project) — use that suffix for tests that need `node:child_process` or other APIs workerd lacks.
- Durable Object SQLite requires `new_sqlite_classes` in the `[[migrations]]` section of `wrangler.toml`. `new_classes` is not enough and will fail at runtime.
- Keep `compatibility_date` pinned to a date the installed `workerd` binary supports. It is currently aligned to `2026-07-30` for `workerd 1.20260730.1`; do not use a later date.
- The `wrangler.toml` file is the canonical, committed config and is not git-ignored. Do not move it to `wrangler.toml.example`.
- `vp run knip` sets `KNIP_DISABLE_RAW_TRANSFER=1`. oxc-parser's raw transfer reserves a 6 GiB `ArrayBuffer` per parse, which fails with `RangeError: Array buffer allocation failed` in 4 GB lane sandboxes (`standard-1`); with it off, knip peaks around 650 MB RSS. Lanes run the full proof list, knip included — do not drop the flag or skip the step (PILE-261).
- The runner `*.node.test.ts` files exec `core.py` through CPython. Never spawn bare `python3` — use `resolvePython()` from `src/agents/runner/python.ts`, which resolves `sys.executable` past PATH shims and skips the suite when no real interpreter exists (a non-CPython `python3` fails with a V8 `SyntaxError`, not a Python one — PILE-317).

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

### Agent session notes

Durable notes live in Pile documents — never in repo files (`NOTES.md`, `.agent-notes/`, ad-hoc scratch files). Any agent that produces investigation notes, decisions, or handoff context for an issue writes them via `POST /workspaces/org_vortex_main/documents` with:

- `contentFormat: "markdown"`, `issueId` (the `ISS-N` identifier or UUID), plus `projectId` when relevant — `GET /workspaces/{org}/documents?issueId=...` and `GET /workspaces/{org}/issues/ISS-N/documents` return every note for a ticket
- Title convention: `ISS-N — <what the note covers>`
- CLI equivalent: `pile documents create --workspace org_vortex_main --title "ISS-N — topic" --content-format markdown --issue ISS-N --content ...`; MCP: `create_document`
- Before finishing a chunk of work, write non-obvious findings (decisions, dead ends, verification output) to a linked note so the next session can pick them up

Repo-committed notes are acceptable only when the note _is_ project documentation meant for humans cloning the repo (e.g. this file) — session context, triage findings, and handoffs go to Pile.

## Where things live

- `src/api/index.ts` — main Hono/OpenAPIHono app, serves `/openapi.json`.
- `src/api/issues.ts` — issue route definitions and schemas.
- `src/workspace/durable-object.ts` — `WorkspaceDO` and SQLite migrations.
- `src/workspace/durable-object.test.ts` — DO tests using `runInDurableObject` from `cloudflare:test`.
- `src/global/schema.ts` — D1 Drizzle schema.
- `drizzle.config.ts` — Drizzle Kit config.
