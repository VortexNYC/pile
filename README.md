# Vortex Issue Tracker

An open-source, agent-native issue tracker built on Cloudflare Workers, D1, and Durable Objects.

## Stack

- Cloudflare Workers
- Hono + Zod
- Cloudflare D1 (global metadata and auth)
- Durable Objects (per-workspace state)
- better-auth (human auth)
- Drizzle ORM

## Features

- Workspace-scoped issue tracking
- Generic agent provider interface with Devin adapter
- `POST /workspaces/:workspaceId/dispatch` to start a Devin session
- `GET/POST/PATCH /workspaces/:workspaceId/issues` for issue CRUD
- `POST /github` to sync PR state from GitHub `pull_request` webhooks
- Workspace-scoped API tokens

## Setup

### Self-host on Cloudflare (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/VortexNYC/issuetracker)

The button works on a fork: fork this repo, and in your forked `wrangler.toml` (copied from `wrangler.toml.example`) remove the `database_id` line so Wrangler auto-provisions D1.

Or from the CLI in one command:

```bash
pnpm install
pnpm run selfhost   # deploys Worker + auto-provisions D1/R2/DO + applies migrations
```

`selfhost` prints the remaining steps: set `BETTER_AUTH_URL`/`ALLOWED_ORIGINS` to your Worker URL, then `wrangler secret put BETTER_AUTH_SECRET` (plus optional `DEVIN_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `SLACK_*`).

### Manual

1. `pnpm install`
2. `cp wrangler.toml.example wrangler.toml` and fill in `BETTER_AUTH_URL` (D1 auto-provisions on deploy).
3. Add secrets:
   ```bash
   wrangler secret put BETTER_AUTH_SECRET
   wrangler secret put DEVIN_TOKEN
   wrangler secret put GITHUB_WEBHOOK_SECRET
   ```
4. Deploy: `pnpm deploy`

## Tests

```bash
pnpm install
pnpm test
pnpm typecheck
```

## License

MIT — see [LICENSE](./LICENSE).
