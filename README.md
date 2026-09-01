# Vortex Linear

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

1. `pnpm install`
2. `cp wrangler.toml.example wrangler.toml` and fill in `database_id`, `BETTER_AUTH_URL`, and Devin org.
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
