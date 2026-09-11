# Spec: support-content

## Objective

Define the fourth module of the customer support layer: reusable content and automation.

`support-content` stores the things agents use to work tickets faster: canned replies (`snippets`), auto-reply rules, and labels. It does not run the support agent; it gives the agent and the UI the primitives to apply consistently.

This module depends on `support-tickets` and reuses the existing `labels` table.

## Tech Stack

- TypeScript.
- Hono + `@hono/zod-openapi`.
- Drizzle ORM on D1.
- Zod for input validation.
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
src/global/support-content.ts       # D1 helpers
src/global/schema.ts                # support_snippets, support_autoresponders tables
src/api/support-content.ts          # REST routes
src/mcp/...                         # generated
packages/client/src/types.ts        # generated
packages/cli/src/commands.ts        # generated
migrations/                         # Drizzle-generated D1 migrations
```

## Data Model

### `support_snippets`

Canned replies that an agent can insert into a message. Plain calls these `Snippets`.

| Column             | Type                   | Notes                   |
| ------------------ | ---------------------- | ----------------------- |
| `id`               | text PK                | Vortex UUID             |
| `organization_id`  | text FK → organization | workspace               |
| `name`             | text                   | not null; shortcut name |
| `text_content`     | text                   | plain text output       |
| `markdown_content` | text                   | nullable; rich output   |
| `created_at`       | text                   | ISO timestamp           |
| `updated_at`       | text                   | ISO timestamp           |

Unique: `(organization_id, name)`.
Index: `(organization_id)` for listing.

### `support_autoresponders`

Rules that send an automatic reply under a condition. Plain's `Autoresponders`.

| Column            | Type                       | Notes                                                                  |
| ----------------- | -------------------------- | ---------------------------------------------------------------------- |
| `id`              | text PK                    | Vortex UUID                                                            |
| `organization_id` | text FK → organization     | workspace                                                              |
| `name`            | text                       | not null                                                               |
| `enabled`         | boolean                    | default true                                                           |
| `trigger`         | text                       | `ticket_created`, `customer_replied`, `out_of_hours`                   |
| `order`           | integer                    | not null; lower runs first                                             |
| `snippet_id`      | text FK → support_snippets | nullable; the reply to send                                            |
| `conditions`      | text                       | JSON string; optional filters (priority, source_channel, customer_tag) |
| `created_at`      | text                       | ISO timestamp                                                          |
| `updated_at`      | text                       | ISO timestamp                                                          |

Index: `(organization_id, enabled, order)`.

`conditions` is stored as a JSON string because the shape is known and validated by Zod on read/write. It is not `any`.

### `support_labels`

This module does **not** create a new table. It extends the existing `labels` table by treating labels with `kind = "support"` as support labels. `support_tickets` already links to `labels` via `support_ticket_labels`.

A support label is just a `labels` row where `kind` is `"support"`.

## Code Style

```ts
export const supportSnippetSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  textContent: z.string(),
  markdownContent: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SupportSnippet = z.infer<typeof supportSnippetSchema>;
```

- snake_case in SQL, camelCase in TypeScript.
- Native Drizzle columns; no `any`.
- Conditions are parsed/validated with Zod, never cast.

## API Surface

### `POST /workspaces/{organizationId}/support/snippets`

Create a snippet.

### `GET /workspaces/{organizationId}/support/snippets`

List snippets.

### `GET /workspaces/{organizationId}/support/snippets/{snippetId}`

Get one snippet.

### `PATCH /workspaces/{organizationId}/support/snippets/{snippetId}`

Update a snippet.

### `POST /workspaces/{organizationId}/support/snippets/{snippetId}/insert`

Returns the rendered text/markdown for a given ticket context. The client uses this to pre-fill a reply.

### `POST /workspaces/{organizationId}/support/autoresponders`

Create an autoresponder rule.

### `GET /workspaces/{organizationId}/support/autoresponders`

List autoresponders.

### `PATCH /workspaces/{organizationId}/support/autoresponders/{autoresponderId}`

Enable/disable or update a rule.

### `POST /workspaces/{organizationId}/support/labels`

Create a support label. Reuses the existing `labels` table with a `kind = "support"` marker.

### `GET /workspaces/{organizationId}/support/labels`

List support labels.

## Storage Choice

`support-content` lives in **D1**. Snippets and autoresponders are workspace-scoped metadata. Labels are already global in D1.

## Testing Strategy

- Tests in `src/api/support-content.test.ts`.
- Create snippets, apply them to a ticket, and assert the rendered output.
- Create autoresponders and trigger `ticket_created` / `customer_replied` events; assert the correct reply is created as a `support_ticket_events` row.

## Migration Path

`support-migration` will not import snippets or autoresponders from Intercom or Plain in v1. Only labels are migrated, if the source system has them. Intercom `tags` and Plain `labels` map to `labels` with `kind = "support"`.

```ts
upsertSupportLabel(db, organizationId, { externalId, externalSource, name });
```

## Boundaries

### Always

- Validate inputs with Zod.
- Run `vp check` and `pnpm test` before committing.
- Keep D1 schema changes in Drizzle migrations.

### Ask First

- Adding a new `trigger` type beyond `ticket_created`, `customer_replied`, `out_of_hours`.
- Changing the `conditions` schema.
- Moving snippets or autoresponders to the workspace Durable Object.

### Never

- Commit secrets.
- Store PII in logs or generated client docs.
- Use `any`.

## Success Criteria

- [ ] D1 tables `support_snippets` and `support_autoresponders` exist.
- [ ] Support labels are created using the existing `labels` table.
- [ ] Snippet insert endpoint returns rendered text/markdown.
- [ ] Autoresponder rules create `support_ticket_events` of type `message` when triggered.
- [ ] OpenAPI/MCP/CLI artifacts are regenerated.
- [ ] `vp check` passes.
- [ ] `pnpm test` passes with new tests.

## Open Questions

1. Should `support_snippets` support variable interpolation (e.g., `{{customer.firstName}}`) in v1, or just static text?
2. Should autoresponders be allowed to assign, label, and snooze in addition to sending a reply, or is reply-only enough for v1?
3. Do we need a `support_macros` table for multi-step actions, or are snippets + autoresponders enough?
