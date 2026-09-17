# Spec: support-tickets

## Objective

Define the second module of the customer support layer: the ticket (Plain calls it a `Thread`).

`support-tickets` is the conversation object. It has a customer, a status, a priority, an assignee, a timeline of events (messages, notes, status changes, assignments), and labels. It is the target for every channel (email, Slack, chat, Intercom, Zendesk, Plain) and the thing the `support-inbox` lists.

This module must be compatible with the Intercom conversation we already import (`ISS-3`) and the Plain thread we want to replace.

## Tech Stack

- TypeScript.
- Hono + `@hono/zod-openapi`.
- Drizzle ORM on D1.
- Zod for input and webhook payload validation.
- Native provider primitives only.

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
src/global/support-tickets.ts       # D1 helpers
src/global/schema.ts                # support_tickets, support_ticket_events, support_ticket_messages, support_ticket_notes, support_ticket_labels, support_ticket_assignments tables
src/api/support-tickets.ts          # REST routes
src/mcp/...                         # generated
packages/client/src/types.ts        # generated
packages/cli/src/commands.ts        # generated
migrations/                         # Drizzle-generated D1 migrations
```

## Data Model

### `support_tickets`

| Column                     | Type                        | Notes                                                                                            |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| `id`                       | text PK                     | Pile UUID                                                                                        |
| `organization_id`          | text FK → organization      | workspace                                                                                        |
| `customer_id`              | text FK → support_customers | who opened it                                                                                    |
| `number`                   | integer                     | per-workspace ticket number, monotonic, not null                                                 |
| `external_id`              | text                        | optional source id                                                                               |
| `external_source`          | text                        | `intercom`, `zendesk`, `plain`, `email`, `slack`, `chat`, `api`, ...                             |
| `title`                    | text                        | not null; auto from subject or first message preview                                             |
| `status`                   | text                        | `todo`, `done`, `snoozed`                                                                        |
| `priority`                 | text                        | `low`, `medium`, `high`, `urgent`                                                                |
| `source_channel`           | text                        | `email`, `slack`, `msteams`, `discord`, `chat`, `capture`, `api`, `intercom`, `zendesk`, `plain` |
| `issue_id`                 | text                        | optional; links to a Pile issue when a ticket is promoted to engineering work                    |
| `last_customer_message_at` | text                        | ISO timestamp, nullable                                                                          |
| `last_agent_message_at`    | text                        | ISO timestamp, nullable                                                                          |
| `created_at`               | text                        | ISO timestamp                                                                                    |
| `updated_at`               | text                        | ISO timestamp                                                                                    |

Unique: `(organization_id, number)`.
Index: `(organization_id, customer_id)`, `(organization_id, status)`, `(organization_id, priority)`.

`number` is a per-workspace counter. A helper `nextTicketNumber(db, organizationId)` reads/increments a row in `support_ticket_counters`.

### `support_ticket_counters`

| Column            | Type    | Notes       |
| ----------------- | ------- | ----------- |
| `organization_id` | text PK | workspace   |
| `next_number`     | integer | starts at 1 |

Used only for allocation; not user-facing.

### `support_ticket_events`

A timeline of anything that happened on the ticket. Every row has a type. Details live in child tables.

| Column       | Type                      | Notes                                                                                                                                        |
| ------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | text PK                   | Pile UUID                                                                                                                                    |
| `ticket_id`  | text FK → support_tickets | not null                                                                                                                                     |
| `type`       | text                      | `message`, `note`, `status_change`, `priority_change`, `assignment_change`, `label_added`, `label_removed`, `customer_event`, `field_change` |
| `actor_type` | text                      | `customer`, `user`, `machine`, `system`                                                                                                      |
| `actor_id`   | text                      | nullable; customer, user, or machine id                                                                                                      |
| `created_at` | text                      | ISO timestamp                                                                                                                                |

Index: `(ticket_id, created_at)`.

### `support_ticket_messages`

Customer-visible events with actual content. A message is always an `event`.

| Column             | Type                            | Notes                                                      |
| ------------------ | ------------------------------- | ---------------------------------------------------------- |
| `id`               | text PK                         | Pile UUID                                                  |
| `event_id`         | text FK → support_ticket_events | not null                                                   |
| `direction`        | text                            | `inbound` or `outbound`                                    |
| `text_content`     | text                            | plain text, required                                       |
| `markdown_content` | text                            | nullable; for rich clients                                 |
| `channel`          | text                            | `email`, `slack`, `msteams`, `discord`, `chat`, `api`, ... |
| `customer_id`      | text FK → support_customers     | for inbound messages                                       |
| `user_id`          | text FK → user                  | for outbound/agent messages                                |

### `support_ticket_notes`

Internal-only events. Customers never see these.

| Column     | Type                            | Notes     |
| ---------- | ------------------------------- | --------- |
| `id`       | text PK                         | Pile UUID |
| `event_id` | text FK → support_ticket_events | not null  |
| `body`     | text                            | not null  |

### `support_ticket_assignments`

Plain supports one primary assignee + additional assignees. This table models all of them.

| Column       | Type                      | Notes         |
| ------------ | ------------------------- | ------------- |
| `id`         | text PK                   | Pile UUID     |
| `ticket_id`  | text FK → support_tickets | not null      |
| `user_id`    | text FK → user            | not null      |
| `is_primary` | boolean                   | default false |

Unique: `(ticket_id, user_id)`.
Index: `(ticket_id, is_primary)`.

### `support_ticket_labels`

| Column      | Type                      | Notes                                        |
| ----------- | ------------------------- | -------------------------------------------- |
| `id`        | text PK                   | Pile UUID                                    |
| `ticket_id` | text FK → support_tickets | not null                                     |
| `label_id`  | text FK → labels          | not null; reuse existing Pile `labels` table |

Unique: `(ticket_id, label_id)`.

## Code Style

```ts
export const supportTicketSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  customerId: z.string(),
  number: z.number().int(),
  externalId: z.string().optional(),
  externalSource: z
    .enum([
      "intercom",
      "zendesk",
      "plain",
      "email",
      "slack",
      "msteams",
      "discord",
      "chat",
      "api",
      "manual",
    ])
    .default("manual"),
  title: z.string(),
  status: z.enum(["todo", "done", "snoozed"]),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  sourceChannel: z.enum([
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
  issueId: z.string().optional(),
  lastCustomerMessageAt: z.string().datetime().optional(),
  lastAgentMessageAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SupportTicket = z.infer<typeof supportTicketSchema>;
```

- snake_case in SQL, camelCase in TypeScript.
- Native Drizzle columns; no `any`.
- `status` starts with `todo`, `done`, `snoozed` — enough to map Intercom and Plain.

## API Surface

### `POST /workspaces/{organizationId}/support/tickets`

Create a ticket. Body: `SupportTicketInput` (customer id, title, source channel, optional priority, optional external ids). The route creates the ticket, the first message (if provided), and the initial customer identity.

### `GET /workspaces/{organizationId}/support/tickets`

Paginated list. Query: `limit`, `cursor`, `customerId`, `status`, `priority`, `assignedTo`, `q`.

### `GET /workspaces/{organizationId}/support/tickets/{ticketId}`

Get a ticket with customer, companies, labels, primary assignee, and the most recent events.

### `GET /workspaces/{organizationId}/support/tickets/{ticketId}/events`

Timeline: paginated list of events with messages/notes inlined.

### `PATCH /workspaces/{organizationId}/support/tickets/{ticketId}`

Update title, status, priority, labels, assignees.

### `POST /workspaces/{organizationId}/support/tickets/{ticketId}/messages`

Add an outbound message or a note. Body includes `type` (`message` or `note`), `textContent`, optional `markdownContent`, optional `channel`.

### `POST /workspaces/{organizationId}/support/tickets/{ticketId}/replies`

Reply to the customer (Plain's `replyToThread`). Returns the created message.

### `POST /workspaces/{organizationId}/support/tickets/{ticketId}/notes`

Add an internal note (Plain's `createNote`).

### `POST /workspaces/{organizationId}/support/tickets/{ticketId}/done`

Mark as `done`.

### `POST /workspaces/{organizationId}/support/tickets/{ticketId}/todo`

Mark as `todo`.

### `POST /workspaces/{organizationId}/support/tickets/{ticketId}/snooze`

Mark as `snoozed` until a given `until` timestamp.

## Storage Choice

`support-tickets` lives in **D1**. Tickets are queried by `organization_id`, `status`, `priority`, `assignedTo`, and `customer_id`. The workspace Durable Object is wrong here because tickets need cross-workspace indexing for the inbox and agent queries.

## Testing Strategy

- Tests in `src/api/support-tickets.test.ts`.
- Create a workspace + customer, create a ticket, add events, change status, assert timeline.
- Test `support-migration` integration: import an Intercom conversation and verify it becomes a ticket with the right status mapping.
- Contract tests after route changes.

## Migration Path

`support-migration` will convert Intercom conversations and Plain threads into `support_tickets`:

| Source             | Target    |
| ------------------ | --------- |
| Intercom `open`    | `todo`    |
| Intercom `closed`  | `done`    |
| Intercom `snoozed` | `snoozed` |
| Plain `todo`       | `todo`    |
| Plain `done`       | `done`    |

Conversations become `support_ticket_events` of type `message`. The first message uses the conversation `source.body`. Replies become additional `message` events.

```ts
createTicketFromIntercom(db, organizationId, customerId, conversation, {
  title,
  status,
  priority,
});
```

## Boundaries

### Always

- Validate inputs with Zod.
- Run `vp check` and `pnpm test` before committing.
- Keep D1 schema changes in Drizzle migrations.
- Use the same status mapping for Intercom, Plain, and internal tickets.

### Ask First

- Adding new `status` values beyond `todo`, `done`, `snoozed`.
- Storing event payloads as JSON instead of child tables.
- Moving `support_tickets` to the workspace Durable Object.

### Never

- Commit secrets.
- Store PII in logs or generated client docs.
- Use `any`.

## Success Criteria

- [ ] D1 tables `support_tickets`, `support_ticket_counters`, `support_ticket_events`, `support_ticket_messages`, `support_ticket_notes`, `support_ticket_assignments`, `support_ticket_labels` exist.
- [ ] REST routes for create/list/get/update tickets and events return correct JSON.
- [ ] Numbering is per-workspace and monotonic.
- [ ] OpenAPI/MCP/CLI artifacts are regenerated.
- [ ] `vp check` passes.
- [ ] `pnpm test` passes with new tests.
- [ ] Intercom conversation import maps to a `support_ticket` with the correct status and timeline.

## Decisions

1. **No `waiting` status for v1.** `todo` + `last_customer_message_at` is enough. Add a `waiting` status later if the inbox needs it.
2. **Dedicated `support_tickets` table.** Pile `issues` and support tickets have different lifecycles. `support_tickets` has an optional `issue_id` for the clean link when a ticket is promoted to engineering work.
3. **Vercel AI SDK is a primitive, not an autonomous agent.** It powers the in-app chat widget and agent-generated suggestions. Final outbound messages are sent through the API by a user or an external agent the customer builds. Pile provides the primitives; it does not run the support agent.
4. **`support_ticket_counters` stays separate for v1.** A generic `workspace_counters` table is cleaner but would require touching existing issue numbering. Separate is safer until support is stable.
