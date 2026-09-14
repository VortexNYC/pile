# Spec: Support auto-escalation

## Objective

Let agents (and the teams running them) automatically promote a support ticket to a linked engineering issue when simple conditions match. Keep the support ticket as the customer record and the issue as the linked work item.

This is intentionally the **first consumer** of a trigger/condition/action pattern, not a generic platform workflow engine. When a second domain needs the same shape, we will lift it into a generic `automations` table. A generic engine with one consumer is a second system.

## End users are agents

- Rules are created, read, updated and deleted through the API/CLI/MCP, not a UI wizard.
- A rule is a small JSON object an agent can generate from instructions.
- No nested AND/OR DSL. All conditions in a rule are ANDed; OR is expressed by creating multiple rules.
- No human-in-the-loop approval. Approval is for AI agent actions; rules are deterministic admin config.
- Execution is synchronous after the triggering event so agents can observe the result immediately.

## What the players do (and what we keep)

- **Manual link is the baseline.** Plain `i`, Linear/Intercom/Zendesk sidebar widgets all link a support thread to an existing or new issue. We already expose this via `PATCH /support/tickets/:id` (`issueId`).
- **Rules are admin config.** Zendesk Triggers, Linear Triage Rules, Plain Workflows run automatically once configured. We use the same model.
- **Issues land in triage/backlog.** Linear/Plain/Zendesk create issues in a non-active state. We default to `triage`.
- **Context travels.** The linked issue must include customer email, channel, and a link back to the support ticket.
- **No OR DSL.** Players have `all`/`any` grouping, but that is UI sugar. For an agent-first API, OR is cheaper and clearer as multiple rules.

## Data model

```ts
export const supportEscalationRules = sqliteTable(
  "support_escalation_rules" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    name: text("name" as string).notNull(),
    isActive: integer("is_active" as string, { mode: "boolean" })
      .notNull()
      .default(true),
    sortOrder: integer("sort_order" as string)
      .notNull()
      .default(0),
    conditions: text("conditions" as string).notNull(), // JSON
    action: text("action" as string).notNull(), // JSON
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("support_escalation_rules_org_active_order_idx" as string).on(
      table.organizationId,
      table.isActive,
      table.sortOrder
    ),
  ]
);
```

`conditions` schema — all top-level keys are optional; when present they are ANDed:

```ts
export const escalationConditionsSchema = z.object({
  keywords: z.array(z.string().min(1)).optional(),
  channels: z.array(supportTicketChannelEnum).optional(),
  priorities: z.array(supportTicketPriorityEnum).optional(),
  statuses: z.array(supportTicketStatusEnum).optional(),
  sources: z.array(supportTicketSourceEnum).optional(),
  customerDomains: z.array(z.string()).optional(),
});
```

`action` schema for the first slice:

```ts
export const escalationActionSchema = z.object({
  type: z.literal("create_issue"),
  teamId: z.string().optional(), // default team if omitted
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  status: z.enum(ISSUE_STATUSES).optional().default("triage"),
  labels: z.array(z.string()).optional(),
});
```

## Triggers

First slice: `support_ticket.created` only.

`support_message.received`, `support_ticket.status_changed`, and `support_ticket.priority_changed` are intentionally out of scope until a customer/agent actually asks for them. They are trivial to add later by calling the same evaluator at the right moment.

## Execution

- After a support ticket is created, load active rules for the workspace ordered by `sortOrder`, then `createdAt`.
- Build context: `{ ticket, subject, text, customer, channel, source }`.
- For each rule:
  - If `ticket.issueId` is already set, stop (idempotent).
  - If every present condition matches, execute `create_issue`.
  - Call `WorkspaceDO.createIssue(...)` with the configured team, priority, status, labels.
  - Title: support ticket title.
  - Description: support ticket text + customer email + channel + source + link back to support ticket.
  - Update `support_tickets.issueId`.
  - Insert `support_ticket_events` row: `type: "link_added"`, `actorType: "automation"`, `actorId: rule.id`, `metadata: { issueId, ruleId }`.
  - Stop; one issue per support ticket.

## Manual linking

Already supported: `PATCH /support/tickets/:id` accepts `{ issueId: string | null }`. The first slice must also fix `updateTicket` to emit `link_added`/`link_changed`/`link_removed` events when `issueId` changes, with `actorType: "user"` and the acting user id.

## API

- `GET    /support/escalation-rules`
- `POST   /support/escalation-rules`
- `GET    /support/escalation-rules/:ruleId`
- `PATCH  /support/escalation-rules/:ruleId`
- `DELETE /support/escalation-rules/:ruleId` (hard-delete; audit is in `support_ticket_events`)

## CLI/MCP example

```bash
pile support escalation-rules create \
  --org org_vortex_main \
  --name "bug-from-intercom" \
  --conditions '{"keywords":["bug","broken"],"channels":["intercom"]}' \
  --action '{"type":"create_issue","priority":"high","status":"triage"}'
```

## Boundaries

- **Always:** Zod-validate `conditions` and `action` at write time; evaluate synchronously after ticket creation; record a `link_added` event.
- **Ask first:** adding `support_message.received`/status/priority triggers; adding non-`create_issue` actions; generalizing to a cross-domain `automations` table.
- **Never:** store issue state in D1; commit secrets; auto-merge.

## Success criteria

- `PATCH /support/tickets/:id` with `issueId` links/unlinks and emits the right event.
- `POST /support/escalation-rules` creates a typed rule.
- An Intercom webhook for a ticket containing "bug" creates a linked issue when a rule matches.
- `pnpm run typecheck && pnpm run check && pnpm test` green.
