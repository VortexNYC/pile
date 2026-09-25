# Privacy notice (hosted pile.nyc)

Plain-English version. For self-hosted deployments, the deployer is the
data controller and publishes their own notice — this one covers only
the Vortex-operated service at `pile.nyc`.

## What we collect

- **Account data** — email and name (Better Auth) for workspace members.
- **Workspace content** — issues, comments, documents, support tickets,
  and message text you create. Ticket content may contain your own
  customers' names/emails if you put them there.
- **Capture artifacts** — session recordings, console logs, and
  screenshots submitted through the capture SDK, recording links, or
  support widget. Captures are initiated by an operator or an end user
  with the link; we don't record anyone passively.
- **Support widget identity** — anonymous session ids by default, or
  email/external-id when the embedding product passes a signed identity
  (`user_hash`). Votes and chats are attributed to that identity.
- **Billing state** — plan, usage counts, Vortex customer id. Payment
  details live in Vortex Billing, not here.
- **Operational data** — API request logs, webhook deliveries, audit
  events, error telemetry.

## What we do with it

- Run the product: issue tracking, support inbox, agent dispatch,
  capture replay, billing enforcement.
- Send transactional email (verification, password reset, invitations,
  ticket replies, changelog notifications you voted on).
- Nothing else. No ads, no selling data, no training models on your
  content.

## Subprocessors

| Vendor | Role |
|---|---|
| Cloudflare | compute, storage (D1/Durable Objects/R2), email routing, DNS |
| Vortex | billing (customers, subscriptions, usage rating) |
| GitHub / GitLab | only if you connect them; scoped tokens, encrypted at rest |

## Your rights

- **Access/export** — `GET /workspaces/{org}/export` returns the full
  workspace state (D1 metadata + issue store). Or ask us.
- **Deletion** — workspace delete purges D1 rows, R2 objects, and
  Durable Object storage. Members can delete their own account.
- **Correction** — update profile/workspace data via the API.
- California residents: CCPA rights apply — email privacy@pile.nyc.

## Retention

Active workspace data lives until you delete it or the workspace.
Operational logs rotate. Backups exist for disaster recovery
(RPO ~24h); deleted data ages out of backups on rotation.

## Security

- TLS everywhere; D1/DO/R2 encrypted at rest.
- Third-party tokens (GitLab PATs, OAuth tokens) AES-256-GCM encrypted
  under a KEK that never touches the database.
- Webhook deliveries are signature-verified; workspace data is gated by
  per-route permission middleware.
- Incidents: see `docs/incident-response.md`. Report issues per
  `SECURITY.md`.

Questions: privacy@pile.nyc.
