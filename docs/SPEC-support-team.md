# Spec: support-team

## Objective

Define the third module of the customer support layer: the team and assignment model.

`support-team` controls who works support tickets, whether they are available, how tickets are routed, and how SLAs are tracked. It reuses Pile's existing `users`, `teams`, and `team_member` tables where possible and adds support-specific tables for status, tiers, and SLAs.

This module is the foundation for the `support-inbox` and `support-migration`.

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
src/global/support-team.ts          # D1 helpers
src/global/schema.ts                # support_user_status, support_tiers, support_slas, support_ticket_sla_events tables
src/api/support-team.ts             # REST routes
src/mcp/...                         # generated
packages/client/src/types.ts        # generated
packages/cli/src/commands.ts        # generated
migrations/                         # Drizzle-generated D1 migrations
```

## Data Model

### `support_user_status`

Tracks whether a support agent is currently available. This is per-user, per-workspace.

| Column            | Type                   | Notes                                  |
| ----------------- | ---------------------- | -------------------------------------- |
| `id`              | text PK                | Pile UUID                              |
| `organization_id` | text FK → organization | workspace                              |
| `user_id`         | text FK → user         | not null                               |
| `status`          | text                   | `active`, `away`, `snoozed`, `offline` |
| `until`           | text                   | ISO timestamp, nullable; for `snoozed` |
| `updated_at`      | text                   | ISO timestamp                          |

Unique: `(organization_id, user_id)`.

`active` agents are eligible for assignment. `away`/`snoozed`/`offline` agents are skipped by routing unless a ticket is explicitly assigned to them.

### `support_tiers`

Customer / support tiers. Plain uses these for routing and SLA. A tier is just a named group in v1.

| Column            | Type                   | Notes     |
| ----------------- | ---------------------- | --------- |
| `id`              | text PK                | Pile UUID |
| `organization_id` | text FK → organization | workspace |
| `name`            | text                   | not null  |
| `level`           | integer                | not null  |

Unique: `(organization_id, name)`.

### `support_tier_members`

Which users belong to which tier.

| Column    | Type                    | Notes     |
| --------- | ----------------------- | --------- |
| `id`      | text PK                 | Pile UUID |
| `tier_id` | text FK → support_tiers | not null  |
| `user_id` | text FK → user          | not null  |

Unique: `(tier_id, user_id)`.

### `support_slas`

SLA rules. Each rule applies to a priority and a tier.

| Column                   | Type                    | Notes                             |
| ------------------------ | ----------------------- | --------------------------------- |
| `id`                     | text PK                 | Pile UUID                         |
| `organization_id`        | text FK → organization  | workspace                         |
| `name`                   | text                    | not null                          |
| `tier_id`                | text FK → support_tiers | nullable; null means "all tiers"  |
| `priority`               | text                    | `low`, `medium`, `high`, `urgent` |
| `first_response_minutes` | integer                 | nullable                          |
| `next_response_minutes`  | integer                 | nullable                          |
| `resolution_minutes`     | integer                 | nullable                          |
| `business_hours_only`    | boolean                 | default false                     |
| `created_at`             | text                    | ISO timestamp                     |

### `support_ticket_sla_events`

Tracks SLA targets and breaches for each ticket. An event is recorded when the clock starts (ticket created, customer message) or when a target is met/missed.

| Column      | Type                      | Notes                                                                |
| ----------- | ------------------------- | -------------------------------------------------------------------- |
| `id`        | text PK                   | Pile UUID                                                            |
| `ticket_id` | text FK → support_tickets | not null                                                             |
| `sla_id`    | text FK → support_slas    | not null                                                             |
| `type`      | text                      | `first_response_target`, `next_response_target`, `resolution_target` |
| `target_at` | text                      | ISO timestamp                                                        |
| `met_at`    | text                      | ISO timestamp, nullable                                              |
| `breached`  | boolean                   | default false                                                        |

Index: `(ticket_id, type)`.

## Code Style

```ts
export const supportUserStatusSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  status: z.enum(["active", "away", "snoozed", "offline"]),
  until: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
});

export type SupportUserStatus = z.infer<typeof supportUserStatusSchema>;
```

- snake_case in SQL, camelCase in TypeScript.
- Native Drizzle columns; no `any`.

## API Surface

### `POST /workspaces/{organizationId}/support/tickets/{ticketId}/assign`

Assign a ticket to a user. Body: `userId`, optional `isPrimary`. A primary assignment replaces any existing primary assignment.

### `POST /workspaces/{organizationId}/support/tickets/{ticketId}/unassign`

Remove an assignment.

### `POST /workspaces/{organizationId}/support/tickets/{ticketId}/additional-assignees`

Add additional assignees (Plain-style `addAdditionalAssignees`).

### `POST /workspaces/{organizationId}/support/tickets/{ticketId}/routing`

Auto-route the ticket to an available agent based on tier, load, and round-robin. Returns the assigned `userId`.

### `POST /workspaces/{organizationId}/support/users/{userId}/status`

Set a user's support status. Body: `status`, optional `until`.

### `GET /workspaces/{organizationId}/support/agents`

List users who can be assigned support tickets, with their status and current open ticket count.

### `POST /workspaces/{organizationId}/support/tiers`

Create a tier.

### `GET /workspaces/{organizationId}/support/tiers`

List tiers.

### `POST /workspaces/{organizationId}/support/tiers/{tierId}/members`

Add a user to a tier.

### `POST /workspaces/{organizationId}/support/slas`

Create an SLA rule.

### `GET /workspaces/{organizationId}/support/tickets/{ticketId}/sla`

Get SLA targets for the ticket.

## Storage Choice

`support-team` lives in **D1**. Agent status, tiers, and SLAs are global metadata queried by the inbox and routing. Ticket assignment rows (`support_ticket_assignments`) already live in the `support-tickets` module; `support-team` writes to them through helpers.

## Testing Strategy

- Tests in `src/api/support-team.test.ts`.
- Set agent status, create tickets, assign, route, and assert that `away` users are skipped.
- SLA tests create a rule, then create a ticket and check that `support_ticket_sla_events` rows are created with the right `target_at`.

## Migration Path

`support-migration` will bring over agent assignments from Intercom and Plain. Intercom has no native assignment in the webhook we receive, so the migration sets `assigned_to` if the conversation has an `assignee`. Plain has `assignedTo` and `additionalAssignees` on every thread; these map directly to `support_ticket_assignments`.

```ts
assignTicket(db, organizationId, {
  ticketId,
  userId,
  isPrimary,
  actorId,
});
```

## Boundaries

### Always

- Validate inputs with Zod.
- Run `vp check` and `pnpm test` before committing.
- Keep D1 schema changes in Drizzle migrations.

### Ask First

- Changing the list of `support_user_status` values.
- Routing algorithm changes (round-robin, load-based, skill-based).
- Moving assignment storage to the workspace Durable Object.

### Never

- Commit secrets.
- Store PII in logs or generated client docs.
- Use `any`.

## Success Criteria

- [ ] D1 tables `support_user_status`, `support_tiers`, `support_tier_members`, `support_slas`, `support_ticket_sla_events` exist.
- [ ] Assign/unassign/additional-assignee routes update `support_ticket_assignments` correctly.
- [ ] Routing respects `away`/`snoozed`/`offline` status.
- [ ] SLA rules generate `support_ticket_sla_events` when a ticket is created.
- [ ] OpenAPI/MCP/CLI artifacts are regenerated.
- [ ] `vp check` passes.
- [ ] `pnpm test` passes with new tests.

## Open Questions

1. Do we support multiple named support teams (e.g., `billing`, `technical`) or is a single support team with `tiers` enough for v1?
2. Should routing be simple round-robin, or load-based (least open tickets)?
3. Do we need business-hours logic for SLAs in v1, or is `business_hours_only` a placeholder?
4. Should agent status be per-workspace or global to the user?
