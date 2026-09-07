#!/usr/bin/env bash
# One-command self-host: provisions the Worker, D1, R2, and the Durable Object.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Deploying Worker (auto-provisions D1, R2, Durable Object)..."
pnpm exec wrangler deploy

echo "Applying D1 migrations..."
pnpm exec wrangler d1 migrations apply D1 --remote

echo
echo "Done. Finish setup:"
echo "  1. Edit wrangler.toml -> set BETTER_AUTH_URL, ALLOWED_ORIGINS, and"
echo "     SLACK_REDIRECT_URI to your Worker URL"
echo "     (https://issuetracker.<your-subdomain>.workers.dev)"
echo "  2. Set secrets (never commit these):"
echo "       pnpm exec wrangler secret put BETTER_AUTH_SECRET   # any long random string"
echo "       pnpm exec wrangler secret put DEVIN_TOKEN          # optional, for agent dispatch"
echo "       pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET"
echo "       pnpm exec wrangler secret put SLACK_CLIENT_ID      # optional, for Slack"
echo "       pnpm exec wrangler secret put SLACK_CLIENT_SECRET  # optional, for Slack"
echo "       pnpm exec wrangler secret put SLACK_SIGNING_SECRET # optional, for Slack"
echo "  3. Re-run: pnpm exec wrangler deploy"
