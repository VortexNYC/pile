# Email setup (per zone)

Pile sends and receives email through Cloudflare Email Routing + the
`send_email` binding — no SMTP, no third-party ESP.

## One-time zone setup (production: pile.nyc)

Email Routing isn't covered by the wrangler OAuth token used for deploys;
do this once in the dashboard (or with an `Email Routing:Edit` API token):

1. **Enable Email Routing** — zone → Email → Email Routing → _Get started_.
   Cloudflare adds MX + SPF records automatically.
2. **Catch-all rule** → destination: worker `pile`. The worker's `email()`
   handler parses with `postal-mime`, maps the recipient to an active
   `support_channels` row (`type: "email"`, `name` = the address), and
   queues a deduped `processIncomingMessage`. Replies thread via
   `In-Reply-To`/`References`.
3. **Email Sending authorization** — add the domain under Email Routing →
   Send Email so `env.EMAIL` (binding `EMAIL`, sender `notifications@pile.nyc`)
   can deliver. Cloudflare adds DKIM/SPF/DMARC.

Or via API with a scoped token:

```bash
curl -X POST "$CF/zones/$ZONE_ID/email/routing/enable" -H "Authorization: Bearer $CF_API_TOKEN"
# then create the catch-all rule -> worker "pile" under
# /zones/$ZONE_ID/email/routing/rules/catch_all
```

## Per-workspace

```bash
# the channel name IS the inbound address the rule routes to
POST /workspaces/{org}/support/channels
{ "type": "email", "name": "support@yourdomain.com" }
```

Outbound replies send from that same address and thread on the
customer's last inbound `Message-ID`.

## Customer intake addresses (PILE-325)

An `email_inboxes` row routes inbound mail to the customer intake flow
instead of support tickets — for merchant/rep document drop-off
(`intake@yourdomain.com`, or a per-customer address):

```bash
POST /workspaces/{org}/email-inboxes
{ "address": "intake@yourdomain.com", "customerId": null, "projectId": null }
```

- Recipient address must match the inbox `address` exactly (lowercased).
- `customerId` pins every mail to that customer; when null the worker
  resolves by sender domain ↔ customer `url` host, and creates a customer
  when nothing matches (freemail senders are named by display name, never
  by domain).
- Attachments land in R2 under `{org}/intake/{hash}/` and are listed on the
  intake item; bodies and metadata are filed on the record and readable via
  `GET /workspaces/{org}/customers/{id}/intake`.
- Dedup is on `Message-ID` (or a SHA-256 of the raw MIME when the header is
  missing), so retries and redeliveries can't double-file.

## Templates & transport

- Templates: `src/email/templates.tsx` (React Email — ticket reply,
  changelog shipped). Render with `renderTicketReply`/`renderChangelogShipped`.
- Transport: `src/email/send.ts` — `mimetext` builds the MIME
  (text + optional HTML, `Message-ID`, `In-Reply-To`, `References`),
  `EmailMessage` + `env.EMAIL.send` delivers.
- Opt-out: `emailOptOut` on contacts; one-click unsubscribe at
  `POST /support/unsubscribe` (no existence oracle).

## Local dev

No setup needed — Miniflare stubs `EMAIL` and captures sends in tests
(`src/email/send.test.ts`, `src/api/changelog.test.ts`). Inbound handler
is covered by `src/channels/email.test.ts`.
