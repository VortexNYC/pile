#!/usr/bin/env bash
# One-command self-host: provisions the Worker, D1, R2, and the Durable Object.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f wrangler.toml ]; then
  cp wrangler.toml.example wrangler.toml
  echo "Created wrangler.toml from wrangler.toml.example"
fi

echo "Deploying Worker (auto-provisions D1, R2, Durable Object)..."
pnpm exec wrangler deploy

echo "Applying D1 migrations..."
pnpm exec wrangler d1 migrations apply D1 --remote

WORKER_URL="$(pnpm exec wrangler deployments list --json 2>/dev/null | head -1 || true)"
echo
echo "Done. Finish setup:"
echo "  1. Edit wrangler.toml -> set BETTER_AUTH_URL and ALLOWED_ORIGINS to your Worker URL"
echo "     (https://issuetracker.<your-subdomain>.workers.dev)"
echo "  2. Set secrets (never commit these):"
echo "       pnpm exec wrangler secret put BETTER_AUTH_SECRET   # any long random string"
echo "       pnpm exec wrangler secret put DEVIN_TOKEN          # optional, for agent dispatch"
echo "       pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET"
echo "       pnpm exec wrangler secret put SLACK_CLIENT_ID      # optional, for Slack"
echo "       pnpm exec wrangler secret put SLACK_CLIENT_SECRET  # optional, for Slack"
echo "       pnpm exec wrangler secret put SLACK_SIGNING_SECRET # optional, for Slack"
echo "  3. Re-run: pnpm exec wrangler deploy"
