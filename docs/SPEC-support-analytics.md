# Spec: support-analytics

## Objective

Define the last module of the customer support layer: reporting and customer feedback.

`support-analytics` reads `support_tickets`, `support_ticket_events`, `support_ticket_sla_events`, and `support_ticket_assignments` to produce metrics. It also stores customer satisfaction surveys. It does not own the operational data; it summarizes it.

## Tech Stack

- TypeScript.
- Hono + `@hono/zod-openapi`.
- Drizzle ORM on D1.
- Zod for query param and survey validation.
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
src/global/support-analytics.ts   # D1 helpers
src/global/schema.ts              # support_surveys table
src/api/support-analytics.ts      # REST routes
src/mcp/...                       # generated
packages/client/src/types.ts      # generated
packages/cli/src/commands.ts      # generated
migrations/                       # Drizzle-generated D1 migrations
```

## Data Model

### `support_surveys`

Customer satisfaction surveys attached to a ticket. Plain's `customer_surveys`.

| Column            | Type                        | Notes                      |
| ----------------- | --------------------------- | -------------------------- |
| `id`              | text PK                     | Vortex UUID                |
| `organization_id` | text FK → organization      | workspace                  |
| `ticket_id`       | text FK → support_tickets   | not null                   |
| `customer_id`     | text FK → support_customers | not null                   |
| `rating`          | integer                     | 1–5 or nullable if skipped |
| `comment`         | text                        | nullable                   |
| `created_at`      | text                        | ISO timestamp              |

Unique: `(ticket_id)`.

### Computed Metrics

`support-analytics` does not store pre-aggregated metrics for v1. It computes them on demand from existing tables:

- **Ticket volume** by status / priority / channel / day.
- **First response time** — time from ticket `created_at` to first `message` with `direction = outbound`.
- **Resolution time** — time from `created_at` to `status = done`.
- **SLA breach count** from `support_ticket_sla_events` where `breached = true`.
- **Agent load** — open `todo` tickets per `primary` assignee.

## Code Style

```ts
export const supportSurveySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  ticketId: z.string(),
  customerId: z.string(),
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().optional(),
  createdAt: z.string().datetime(),
});

export type SupportSurvey = z.infer<typeof supportSurveySchema>;
```

- snake_case in SQL, camelCase in TypeScript.
- No `any`.

## API Surface

### `GET /workspaces/{organizationId}/support/analytics/overview`

Summary metrics for a date range. Query: `from`, `to`, `groupBy` (`day`, `week`, `month`).

Response:

```json
{
  "totalTickets": 120,
  "todo": 15,
  "done": 100,
  "snoozed": 5,
  "avgFirstResponseMinutes": 45,
  "avgResolutionMinutes": 1440,
  "slaBreaches": 3,
  "csatAverage": 4.5
}
```

### `GET /workspaces/{organizationId}/support/analytics/team`

Per-agent metrics. Query: `from`, `to`, `userId`.

Response:

```json
{
  "userId": "...",
  "ticketsAssigned": 30,
  "ticketsResolved": 25,
  "avgFirstResponseMinutes": 30,
  "avgResolutionMinutes": 1200
}
```

### `GET /workspaces/{organizationId}/support/analytics/customers`

Per-customer metrics. Query: `from`, `to`, `customerId`, `companyId`.

Response:

```json
{
  "customerId": "...",
  "totalTickets": 5,
  "avgFirstResponseMinutes": 20,
  "lastTicketAt": "..."
}
```

### `GET /workspaces/{organizationId}/support/analytics/sla`

SLA overview: targets set, met, breached, by priority and tier.

### `POST /workspaces/{organizationId}/support/tickets/{ticketId}/surveys`

Submit a customer satisfaction survey.

### `GET /workspaces/{organizationId}/support/tickets/{ticketId}/surveys`

Get the survey for a ticket.

## Storage Choice

`support-analytics` lives in **D1**. The only table it writes is `support_surveys`. All metrics are computed from existing tables. Pre-aggregated rollups can be added later if on-demand queries are too slow.

## Testing Strategy

- Tests in `src/api/support-analytics.test.ts`.
- Seed `support_tickets`, `support_ticket_events`, `support_ticket_sla_events`, `support_surveys`.
- Test overview, team, customer, and SLA endpoints return the expected numbers.

## Migration Path

`support-migration` does not import survey data from Intercom, Zendesk, or Plain in v1. Surveys start empty. Historical ticket data is used for the metrics.

## Boundaries

### Always

- Validate query params with Zod.
- Run `vp check` and `pnpm test` before committing.
- Keep D1 schema changes in Drizzle migrations.

### Ask First

- Adding pre-aggregated analytics tables.
- Adding real-time analytics WebSocket.
- Moving analytics to a separate Worker or data warehouse.

### Never

- Commit secrets.
- Store PII in logs or generated client docs.
- Use `any`.

## Success Criteria

- [ ] D1 table `support_surveys` exists.
- [ ] `GET /support/analytics/overview` returns volume, response, resolution, SLA, and CSAT metrics.
- [ ] `GET /support/analytics/team` returns per-agent stats.
- [ ] `GET /support/analytics/customers` returns per-customer stats.
- [ ] `GET /support/analytics/sla` returns SLA overview.
- [ ] Survey submission and retrieval work.
- [ ] OpenAPI/MCP/CLI artifacts are regenerated.
- [ ] `vp check` passes.
- [ ] `pnpm test` passes with new tests.

## Open Questions

1. Should `support_surveys` support multiple questions, or is a single `rating` + `comment` enough for v1?
2. Should analytics use `D1` only, or do we push aggregates to `PlanetScale`/`Postgres` for cross-workspace dashboards?
3. Do we need a `support_nps` metric, or is CSAT (1–5) the first feedback signal?
