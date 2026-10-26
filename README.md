# Pile

An open-source, agent-native issue tracker, built on Cloudflare Workers, D1, and Durable Objects.

Hosted instance: [pile.nyc](https://pile.nyc) · Docs: [docs.pile.nyc](https://docs.pile.nyc)

## The bet

The work tools you're paying for separately are the same graph — an
issue linked to a support ticket linked to a capture linked to a
customer linked to a doc. Pile holds them as one connected workspace
instead of five products joined by integrations.

| Dumps            | For                                                               |
| ---------------- | ----------------------------------------------------------------- |
| Linear / Jira    | Issues, projects, cycles, triage, PR + CI state, stage sub-steps  |
| Notion           | Documents — nested pages, spaces, backlinks, share links, ToC     |
| Supermemory      | Workspace memory (`workspace_memory`) + scoped guidance playbooks |
| Attio / HubSpot  | Customers, contacts, deals, signal intake, stage-gated pipelines  |
| Jam              | Screen/context captures — video, console, network, env            |
| Intercom / Plain | Support tickets, customers, reply/note threads, email intake      |
| LaunchNotes      | The changelog as a first-class surface                            |

### The philosophy

Every data point is linked to other data points — nothing floats.
An issue tells the whole story: the bug a customer reported, the
jam they recorded, the doc that specced the fix, the PR that
shipped it, the agent that did the work. Default surfaces stay
minimal — sections render only when they have data, and anything
you never read can be switched off per-user (Settings → Surfaces).

**What we're deliberately _not_ doing:** chat, email, and the
generic-workspace kitchen sink. The things that interconnect
_cleanly_ are the graph; channels are where context goes to die.
Email may come later, but only when it can be part of the graph —
not a window onto a channel.

## Stack

- **Runtime & HTTP:** Cloudflare Workers, Hono + `@hono/zod-openapi` (typed routes, `/openapi.json`, generated CLI/SDK/MCP)
- **Data:** Cloudflare D1 (global metadata, RBAC, auth) + Durable Objects SQLite (per-workspace issues, docs, CRM, memory, and agent state) with Drizzle ORM
- **Search:** compact SMI-packed in-DO BM25 index across issues, comments, `workspace_memory` facts, and BlockNote/Markdown documents
- **Auth:** Better Auth (human sessions + dynamic org RBAC) and workspace/lane-scoped bearer tokens for agents
- **Web Console (`apps/web`):** React + Vite SPA served under `/app` (Kumo components + Phosphor icons)

## Features

- **Connected Workspace Graph:** Issues, documents (with restricted spaces and per-doc grants), projects, cycles, customers, contacts, deals, support tickets, screen captures, and changelogs in one per-workspace Durable Object.
- **Agent Orchestration & Fleet Control:**
  - `POST /workspaces/:org/issues/:id/dispatch` and `POST /workspaces/:org/agent/dispatch-batch` (with `queuedAfter` dependency chains) across `devin-cli`, `codex-cli`, `cursor-cli`, `claude-cli`, `devin`, `cursor`, and `cf-agent`.
  - Compute backends on Cloudflare Sandbox SDK 1.0 container pools (`LaneSandbox`, `LaneDevinSandbox`, `LaneCursorSandbox`, `LaneCodexSandbox`) and Daytona with automatic compute failover, orphan sandbox sweeping, and mid-provision cancel abort.
  - Per-agent concurrency ceilings (`maxConcurrentLanes`) with reserved implementation capacity (`reviewConcurrencyCap`), provider-advertised rate-limit parking with exponential backoff, and window/per-run spend & token caps (`GET /workspaces/:org/agent/costs`).
- **Workspace Memory & Guidance Packs:**
  - `GET/POST /workspaces/:org/memory` (MCP `memory_recall` / `memory_remember`): entity-keyed facts (`issue`, `repo`, `agent`, `workspace`, `customer`) with automatic superseding, `validUntil` TTL, and automatic recall injection into dispatched lanes.
  - Memory Engine: `GET /workspaces/:org/memory/profile` per-entity rollups, `POST /memory/batch` batch ingestion, `POST /memory/extract` auto-extraction, `PATCH`/`DELETE /memory/{id}` update/forget, and hybrid semantic recall (LIKE → BM25 → optional Workers AI Vectorize with concept expansion).
  - Hierarchical guidance packs (`workspace → team → status → step`) resolved and version-stamped onto every agent session.
- **Review Quality & Engineering Observability:**
  - Task-contextual repo+workspace memory briefs injected at dispatch; blocking `request-changes` findings are recorded back as `review_lesson:<file>` repo facts and re-injected as "Repository Invariants & Past Review Lessons" on later reviews.
  - Multi-axis Trail HUD scores on every posted PR review (`security`, `slop`, `invariants` 0–100 + `humanGate`), finding fingerprints, and last-5 convergence tracking (clean / converging / stalled / oscillating) with oscillation alerts nudged to the work lane.
  - `GET /workspaces/:org/provenance` (MCP `explain_provenance`) resolves a sha, file, PR, branch, repo, or issue to the lanes, touched files, commit shas, and memory facts that produced it, with a markdown `whySummary`.
  - `GET /workspaces/:org/agent/recap` (MCP `agent_recap`) — founder-ready fleet recap: shipped / in-flight with trail convergence / blocked (failed, oscillating, human-gate, paused) / compute, plus a rendered markdown brief.
- **First-Class Agent Surfaces (MCP, CLI, SDK):**
  - Workspace MCP (`/mcp`) and per-session Lane MCP (`/workspaces/:org/agent/sessions/:id/mcp`) exposing the full OpenAPI surface plus lane-scoped git/PR/memory/CRM tools.
  - OAuth 2.0 + PKCE connector registration: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/.well-known/mcp.json`, and `server.json` so hosted MCP clients can discover and connect.
  - Generated TypeScript CLI (`@vortex-api/pile`) and SDK.
- **GitHub & GitLab Sync:** `POST /github` and `POST /gitlab` webhooks sync PR/MR state, check runs, review verdicts, and branch lifecycle back onto issues.
- **Rate Limiting:** `/api/auth/*` via Better Auth (D1-backed, per-IP by `cf-connecting-ip`; defaults: 100 req/60s global, 3 req/10s on sign-in/sign-up). Behind a non-Cloudflare edge, either overwrite `cf-connecting-ip` at your proxy or change `advanced.ipAddress.ipAddressHeaders` in `src/platform/auth.ts`.

## Setup

### Self-host on Cloudflare (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/VortexNYC/pile)

`wrangler.toml` is tracked in git and is the canonical config (there is no `wrangler.toml.example`). Its top-level section is self-host-ready: D1 and R2 auto-provision on `wrangler deploy`, the Durable Object, queue, and cron trigger are declared, and the hosted Pile instance is isolated under `[env.production]` (deployed with `pnpm deploy`, i.e. `wrangler deploy -e production`). The `[env.production]` values are specific to the hosted instance; do not copy them for a self-hosted deployment.

Or from the CLI in one command:

```bash
pnpm install
pnpm run selfhost   # deploys Worker + auto-provisions D1/R2/DO + applies migrations
```

`selfhost` prints the remaining steps: set `BETTER_AUTH_URL`/`ALLOWED_ORIGINS` to your Worker URL, then `wrangler secret put BETTER_AUTH_SECRET` (plus optional `DEVIN_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `SLACK_*`).

### Manual

1. `pnpm install`
2. Edit `wrangler.toml` `[vars]` — set `BETTER_AUTH_URL` and `ALLOWED_ORIGINS` to your Worker URL (D1 auto-provisions on deploy).
3. Add secrets:
   ```bash
   wrangler secret put BETTER_AUTH_SECRET
   wrangler secret put DEVIN_TOKEN
   wrangler secret put GITHUB_WEBHOOK_SECRET
   ```
4. Deploy: `wrangler deploy` (`pnpm deploy` targets the hosted `production` environment)

### Pointing agents at your deployment

The CLI, SDK, and MCP examples in `packages/docs/docs/agents.mdx` and `.devin/skills/pile-*` use `https://<your-worker>` as a placeholder. Substitute your Worker URL (the same value as `BETTER_AUTH_URL`), or `http://127.0.0.1:8787` when running `wrangler dev` locally. The CLI reads it from `PILE_BASE_URL` or `pile config set --base-url <url>`.

### Headless CLI providers (codex-cli, devin-cli, cursor-cli)

The CLI providers run the vendor's own CLI inside a compute sandbox. The
default backend is `COMPUTE_PROVIDER = "cloudflare"` — a Workers Container
built from `Dockerfile.sandbox`, no external account required. To use Daytona
instead, set `COMPUTE_PROVIDER = "daytona"` and add `DAYTONA_API_KEY` (plus
optional `DAYTONA_API_URL`, `DAYTONA_SNAPSHOT`, `DAYTONA_VOLUME_ID`).

Each provider needs its own vendor credentials as Worker secrets:

```bash
# codex-cli: base64 the auth.json created by `codex login`, plus the Codex
# Cloud environment ID
base64 < ~/.codex/auth.json | tr -d '\n' | wrangler secret put CODEX_AUTH_JSON_B64
wrangler secret put CODEX_CLI_ENV_ID

# devin-cli: base64 the credentials created by `devin login`
wrangler secret put DEVIN_CLI_CREDENTIALS_B64

# cursor-cli: an API key from cursor.com/settings
wrangler secret put CURSOR_API_KEY
```

Provider secrets can also be set per workspace via
`PUT /workspaces/:id/agent/providers/:agentId`, including a per-workspace
`config.computeProvider` override.

## Proof & Tests

Run the full proof wall from the repo root before committing:

```bash
pnpm install
vp run check            # format, lint, and typecheck (Vite+)
pnpm run contract:check # verify OpenAPI, MCP, CLI, docs, and runner bundles are in sync
pnpm test               # workerd + node Vitest suites
pnpm run diff-coverage  # verify changed src/ files have co-located *.test.ts updates
pnpm run knip
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
