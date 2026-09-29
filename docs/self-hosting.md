# Self-hosting

**Managed is the supported path.** Pile is operated at `pile.nyc`; the
deployment below is documented for completeness and for running a dev
environment — not offered as a supported self-host distribution. If you run it
yourself, you own upgrades, secrets, and the container fleet.

## What a deployment is

One Cloudflare Worker + bindings (see `wrangler.toml`, which is canonical):

| binding                       | purpose                        |
| ----------------------------- | ------------------------------ |
| `D1` (`pile-global`)          | global metadata                |
| `WORKSPACE_DURABLE_OBJECT`    | per-workspace issue/session DB |
| `SANDBOX*` DOs + 4 containers | lane compute                   |
| `WEBHOOK_QUEUE`               | webhook processing             |
| `ATTACHMENTS_BUCKET` (R2)     | attachments/cache              |
| `EMAIL`                       | transactional mail             |

## Minimal secrets

| secret                                    | why                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                      | session signing                                                                                          |
| `BETTER_AUTH_URL`, `ALLOWED_ORIGINS`      | auth + CORS for your domain                                                                              |
| `AGENT_SETTINGS_KEK`, `TOKEN_HASH_SECRET` | at-rest encryption for provider creds                                                                    |
| `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`     | GitHub App (repo access, webhooks, PR ops)                                                               |
| `GITHUB_WEBHOOK_SECRET`                   | webhook signature verification                                                                           |
| provider keys (e.g. `DEVIN_TOKEN`)        | only if you want deployment-level defaults — workspaces can supply their own via the provider-config API |

## Bring-up

```bash
pnpm install
pnpm exec wrangler d1 create pile-global       # put the id in wrangler.toml
pnpm exec wrangler d1 migrations apply pile-global --remote -e production
pnpm exec wrangler deploy -e production
```

Then create a workspace through the API and follow `docs/onboarding.md` —
the `setup-status` endpoint will flag anything still missing.

## Caveats

- The four sandbox container images (`Dockerfile.sandbox*`) must build in the
  deploy environment; container support requires the appropriate Workers plan.
- `devin-cli` lanes additionally need Daytona (`DAYTONA_API_KEY`, snapshot,
  volume) or Cloudflare containers compute (`COMPUTE_PROVIDER=cloudflare`).
- Cron triggers (the agent sweep) are declared in `wrangler.toml` — no
  separate scheduler to run.
