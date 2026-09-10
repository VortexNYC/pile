# Spec: support-channels

## Objective

Define the sixth module of the customer support layer: how tickets get in and out of Vortex.

`support-channels` provides the ingestion endpoints for every channel (email, Slack, MS Teams, Discord, in-app chat, Intercom, Zendesk, Plain) and the outgoing send path for replies. It is the HTTP surface that `support-migration` adapters and external providers call to create and update `support_tickets` and `support_ticket_events`.

The in-app chat widget uses the **Vercel AI SDK** for the client-side chat UI. Vortex provides the message persistence; the customer brings their own model if they want an AI agent.

## Tech Stack

- TypeScript.
- Hono + `@hono/zod-openapi`.
- Drizzle ORM on D1.
- Zod for input and webhook payload validation.
- Native Web Crypto for HMAC and signature verification.
- Vercel `ai` package for the in-app chat UI components (client side).

## Commands

```bash
pnpm exec vp check --fix
pnpm test
pnpm run db:generate
CLOUDFLARE_API_TOKEN=... pnpm exec wrangler d1 migrations apply issuetracker-global -e production --remote
CLOUDFLARE_API_TOKEN=... pnpm exec wrangler deploy -e production
```

## Project Structure

```
src/channels/
  email.ts                    # incoming/outgoing email
  slack.ts                    # Slack events + reply
  chat.ts                     # in-app chat sessions
  intercom.ts                 # Intercom webhook
  zendesk.ts                  # Zendesk webhook
  plain.ts                    # Plain webhook
  generic.ts                  # API-created messages
src/global/support-channels.ts  # D1 helpers
src/global/schema.ts            # support_channels, support_chat_sessions tables
src/api/support-channels.ts     # REST routes
src/mcp/...                     # generated
packages/client/src/types.ts    # generated
packages/cli/src/commands.ts    # generated
migrations/                     # Drizzle-generated D1 migrations
```

## Data Model

### `support_channels`

Configuration for each enabled channel in a workspace.

| Column            | Type                   | Notes                                                                                            |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `id`              | text PK                | Vortex UUID                                                                                      |
| `organization_id` | text FK → organization | workspace                                                                                        |
| `type`            | text                   | `email`, `slack`, `msteams`, `discord`, `chat`, `capture`, `api`, `intercom`, `zendesk`, `plain` |
| `name`            | text                   | not null                                                                                         |
| `is_active`       | boolean                | default true                                                                                     |
| `config`          | text                   | JSON string; channel-specific non-secret settings                                                |
| `created_at`      | text                   | ISO timestamp                                                                                    |
| `updated_at`      | text                   | ISO timestamp                                                                                    |

Unique: `(organization_id, type, name)`.

`config` stores things like support email address, Slack channel id, or widget color. Secrets (tokens, signing secrets) are Worker secrets referenced by `name`, never stored in `config`.

### `support_chat_sessions`

A chat session ties a customer to a ticket. The Vercel AI SDK `useChat` hooks live in the client; the session record lets the backend persist the conversation.

| Column            | Type                        | Notes                        |
| ----------------- | --------------------------- | ---------------------------- |
| `id`              | text PK                     | Vortex UUID                  |
| `organization_id` | text FK → organization      | workspace                    |
| `customer_id`     | text FK → support_customers | who is chatting              |
| `ticket_id`       | text FK → support_tickets   | nullable until first message |
| `created_at`      | text                        | ISO timestamp                |
| `updated_at`      | text                        | ISO timestamp                |

Index: `(organization_id, customer_id, updated_at)`.

## Code Style

```ts
export const supportChannelSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  type: z.enum([
    "email",
    "slack",
    "msteams",
    "discord",
    "chat",
    "capture",
    "api",
    "intercom",
    "zendesk",
    "plain",
  ]),
  name: z.string(),
  isActive: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SupportChannel = z.infer<typeof supportChannelSchema>;
```

- `config` is `z.record(z.unknown())` and is validated by the channel-specific code that consumes it, not by the top-level schema.
- snake_case in SQL, camelCase in TypeScript.

## API Surface

### `POST /workspaces/{organizationId}/support/channels`

Create a channel config.

### `GET /workspaces/{organizationId}/support/channels`

List channels.

### `PATCH /workspaces/{organizationId}/support/channels/{channelId}`

Update or enable/disable a channel.

### `POST /workspaces/{organizationId}/support/channels/{channelId}/send`

Send an outbound message on the channel. Body: `customerId`, `textContent`, optional `markdownContent`, `ticketId`.

### `POST /support/incoming/{channelId}`

Generic incoming message endpoint. Body is channel-specific but always produces a `support_tickets` row and a `support_ticket_events` row.

### `POST /support/webhooks/email/{organizationId}`

Incoming email webhook. Body: `{ from, to, subject, text, html }`. Verifies `from` and `to` against configured `support_channels`.

### `POST /support/webhooks/slack/{organizationId}`

Slack Events API endpoint. Verifies Slack request signature.

### `POST /support/webhooks/intercom/{organizationId}`

Intercon webhook. Verifies `X-Hub-Signature` HMAC-SHA1.

### `POST /support/webhooks/zendesk/{organizationId}`

Zendesk webhook. Verifies Zendesk signature.

### `POST /support/webhooks/plain/{organizationId}`

Plain webhook. Verifies `plain-request-signature`.

### `POST /support/chat/sessions`

Start an in-app chat session. Returns a `sessionId` and `customerId`.

### `POST /support/chat/sessions/{sessionId}/messages`

Receive a customer message from the chat widget. Creates or appends to a `support_tickets` row and stores the message. Returns the stored message.

## Storage Choice

`support-channels` lives in **D1**. Channel configs, chat sessions, and the ticket/event rows they create are all D1. The only exception is an optional Durable Object if a channel needs real-time pub/sub for the in-app chat; that belongs in `support-inbox`.

## Testing Strategy

- Tests in `src/api/support-channels.test.ts`.
- For each provider, generate a valid webhook payload and signature, post to the route, and assert a ticket is created/updated.
- For chat, create a session, post a message, and assert a `support_tickets` row exists.
- Test missing/invalid signatures return 401.

## Migration Path

`support-channels` is the runtime half of `support-migration`. Import reads history once; `support-channels` handles ongoing events. Both call the same upsert primitives in `support-migration` or `support-tickets`.

```ts
processIncomingMessage(db, organizationId, {
  channel: "email",
  customer: { email, fullName },
  message: { text, subject },
});
```

## Boundaries

### Always

- Verify webhook signatures before processing.
- Validate all payloads with Zod.
- Run `vp check` and `pnpm test` before committing.
- Keep D1 schema changes in Drizzle migrations.

### Ask First

- Adding a new channel.
- Storing channel secrets in D1 instead of Worker secrets.
- Allowing `support-channels` to write directly to the workspace Durable Object.

### Never

- Commit channel secrets.
- Store PII in logs or generated client docs.
- Use `any`.

## Success Criteria

- [ ] D1 tables `support_channels` and `support_chat_sessions` exist.
- [ ] `POST /support/webhooks/intercom/{org}` creates/updates a support ticket.
- [ ] `POST /support/chat/sessions/{id}/messages` creates a ticket from a chat message.
- [ ] Invalid webhook signatures return 401.
- [ ] OpenAPI/MCP/CLI artifacts are regenerated.
- [ ] `vp check` passes.
- [ ] `pnpm test` passes with new tests.

## Open Questions

1. Should `support-channels` own the webhook handlers for Intercom/Zendesk/Plain, or should those live in `src/agents/` and `support-channels` only own the generic `POST /support/incoming/{channelId}`?
2. Should the chat widget use the Vercel AI SDK on the client and call `POST /support/chat/sessions/{id}/messages`, or does the Worker expose a `streamText` endpoint?
3. Do we support email receiving via Cloudflare Email Workers, or do we use an external email parser that calls `POST /support/webhooks/email/{org}`?
