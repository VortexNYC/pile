# Spec: support-inbox

## Objective

Define the seventh module of the customer support layer: the agent-facing queue and inbox.

`support-inbox` is a read/query layer on top of `support-tickets`, `support-team`, and `support-content`. It lists tickets, applies filters, shows queues, and returns the data an agent needs to triage and respond. It does not own the ticket data; it reads it.

## Tech Stack

- TypeScript.
- Hono + `@hono/zod-openapi`.
- Drizzle ORM on D1.
- Zod for query and filter validation.
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
src/global/support-inbox.ts       # D1 query helpers
src/global/schema.ts              # support_saved_views table
src/api/support-inbox.ts          # REST routes
src/mcp/...                       # generated
packages/client/src/types.ts      # generated
packages/cli/src/commands.ts      # generated
migrations/                       # Drizzle-generated D1 migrations
```

## Data Model

### `support_saved_views`

Saved filters for the inbox. A view is a stored `filter` plus a `sort`.

| Column            | Type                   | Notes                                          |
| ----------------- | ---------------------- | ---------------------------------------------- |
| `id`              | text PK                | Vortex UUID                                    |
| `organization_id` | text FK → organization | workspace                                      |
| `user_id`         | text FK → user         | nullable; personal view if set, shared if null |
| `name`            | text                   | not null                                       |
| `filter`          | text                   | JSON string; validated by Zod                  |
| `sort`            | text                   | JSON string; e.g., `updated_at desc`           |
| `created_at`      | text                   | ISO timestamp                                  |
| `updated_at`      | text                   | ISO timestamp                                  |

Index: `(organization_id, user_id)`.

No other tables are added. `support-inbox` reads `support_tickets`, `support_ticket_events`, `support_ticket_assignments`, `support_ticket_labels`, `support_user_status`, `support_slas`, and `support_ticket_sla_events`.

### `support_inbox_ticket` (computed, not a table)

The list API returns a computed shape that joins the core ticket, customer, primary assignee, labels, and SLA status.

```ts
export const supportInboxTicketSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  status: z.enum(["todo", "done", "snoozed"]),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  customer: supportCustomerSchema,
  primaryAssignee: z.string().optional(),
  labels: z.array(z.string()),
  lastCustomerMessageAt: z.string().datetime().optional(),
  lastAgentMessageAt: z.string().datetime().optional(),
  sla: z
    .object({
      firstResponseTargetAt: z.string().datetime().optional(),
      firstResponseBreached: z.boolean().default(false),
      resolutionTargetAt: z.string().datetime().optional(),
      resolutionBreached: z.boolean().default(false),
    })
    .optional(),
  updatedAt: z.string().datetime(),
});
```

## Code Style

- All query filters are explicit Zod schemas.
- No raw SQL strings for filtering; use Drizzle `where` clauses built from the parsed filter.
- snake_case in SQL, camelCase in TypeScript.
- No `any`.

## API Surface

### `GET /workspaces/{organizationId}/support/inbox`

List tickets. Query params: `status`, `priority`, `assignedTo`, `customerId`, `label`, `channel`, `q` (search title/customer), `slaBreach`, `limit`, `cursor`.

The endpoint always returns the computed `supportInboxTicket` shape.

### `GET /workspaces/{organizationId}/support/inbox/counts`

Summary counts by status: `todo`, `done`, `snoozed`, plus `mine` (tickets assigned to the caller), `unassigned`.

### `GET /workspaces/{organizationId}/support/inbox/next`

Returns the next ticket the agent should work, based on routing rules from `support-team`. Query: `tierId`, `status`.

### `GET /workspaces/{organizationId}/support/views`

List saved views.

### `POST /workspaces/{organizationId}/support/views`

Create a saved view. Body: `name`, `filter`, `sort`.

### `GET /workspaces/{organizationId}/support/views/{viewId}`

Get a saved view and its current ticket list.

### `POST /workspaces/{organizationId}/support/views/{viewId}/run`

Run a saved view and return the ticket list. This is the same query as `GET /support/inbox` but with stored filter/sort.

## Storage Choice

`support-inbox` lives in **D1**. It is query-only. The only table it writes is `support_saved_views`. For real-time updates, `support-inbox` may later subscribe to a Durable Object broadcast from `support-channels`; that is out of v1.

## Testing Strategy

- Tests in `src/api/support-inbox.test.ts`.
- Seed `support_tickets`, `support_customers`, `support_ticket_assignments`, `support_ticket_sla_events`.
- Test filters, counts, saved views, and `next` routing.

## Migration Path

`support-inbox` does not migrate data. It exposes the read model that `support-migration` and `support-channels` populate. Saved views are manual-only in v1.

## Boundaries

### Always

- Validate filters with Zod before running queries.
- Run `vp check` and `pnpm test` before committing.
- Keep D1 schema changes in Drizzle migrations.

### Ask First

- Adding real-time / pub-sub to the inbox.
- Moving inbox queries to the workspace Durable Object.
- Adding a `search` index beyond simple `LIKE` on title/customer.

### Never

- Commit secrets.
- Store PII in logs or generated client docs.
- Use `any`.

## Success Criteria

- [ ] D1 table `support_saved_views` exists.
- [ ] `GET /support/inbox` returns filtered tickets with customer, assignee, labels, and SLA.
- [ ] `GET /support/inbox/counts` returns status and assignment counts.
- [ ] `GET /support/inbox/next` returns the next ticket based on routing rules.
- [ ] Saved views can be created and re-run.
- [ ] OpenAPI/MCP/CLI artifacts are regenerated.
- [ ] `vp check` passes.
- [ ] `pnpm test` passes with new tests.

## Open Questions

1. Should the inbox use `LIKE` on `title`/`customer.name` for search, or do we need a full-text index from the start?
2. Should `support-inbox` also expose a WebSocket or SSE endpoint for real-time updates, or is polling the only v1 path?
3. Do saved views live only in D1, or should the user's personal views be stored in the workspace Durable Object?
