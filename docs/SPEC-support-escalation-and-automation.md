# Spec: Support auto-escalation and rules

## Objective

Let a workspace automatically turn a support ticket into an engineering issue when configurable conditions match, while keeping the support ticket as the primary customer conversation. Provide the same manual link API already exists today.

## What we learned from the players

- **Manual link is the baseline.** Plain, Linear/Intercom, and Zendesk all let an agent press `i` (or use a sidebar widget) to create or link an engineering issue from a support thread. The support thread stays; the issue is a linked sibling.
- **Rules are admin-configured, not agent-asked.** Zendesk *Triggers* and *Automations*, Plain *Workflows*, and Linear *Triage Rules* run because an admin configured them. They are not per-action approvals.
- **AI actions are the approval layer.** Plain Sidekick "escalate" and Linear Agent issue creation are in the *needs approval* tier. Plain exposes this explicitly in its permissions table. Rules-based automation does not wait for a human click.
- **Triggers are events, not schedules first.** Plain: thread created, message added, labels/priority/status changed. Zendesk: ticket created/updated. Linear: issue created, state changed, updated, comment created. Scheduled/cron is a separate workflow type.
- **Conditions are grouped.** Zendesk uses `all`/`any`. Plain uses `All of`/`Any of`/`Not`. Linear filters on issue properties.
- **Actions run in order; stop on conflict or per-action idempotency.** Plain and Zendesk execute rules top-down. Creating an issue is naturally idempotent: once `issueId` is set, a second `create_issue` should be a no-op.
- **Issues land in triage/backlog, never an active cycle.** Linear/Plain/Zendesk create issues in triage or a configured backlog state. Close-the-loop status sync comes later.
- **Context travels.** The linked engineering issue should contain title, support ticket description, customer email/name, channel, and a link back to the support ticket.

## Proposed Vortex design

### Principle: start domain-specific, generalize later

Build `support_escalation_rules` as the first consumer. Once we have a second domain (e.g. issue status automations, billing dunning), we can extract a generic `automations` engine. A generic rule engine now would be premature abstraction.

### Data model

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
    sortOrder: integer("sort_order" as string).notNull().default(0),
    conditions: text("conditions" as string).notNull(), // JSON
    action: text("action" as string, {
      enum: ["create_issue"],
    } as const)
      .notNull()
      .default("create_issue"),
    actionConfig: text("action_config" as string).notNull(), // JSON
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

`conditions` schema (Zod):

```ts
export const escalationConditionsSchema = z.object({
  all: z.array(z.union([
    z.object({
      type: z.literal("keywords"),
      keywords: z.array(z.string().min(1)),
      scope: z.enum(["subject", "text", "any"]).default("any"),
    }),
    z.object({
      type: z.literal("channel"),
      channels: z.array(supportTicketChannelEnum),
    }),
    z.object({
      type: z.literal("priority"),
      priorities: z.array(supportTicketPriorityEnum),
    }),
    z.object({
      type: z.literal("status"),
      statuses: z.array(supportTicketStatusEnum),
    }),
    z.object({
      type: z.literal("source"),
      sources: z.array(supportTicketSourceEnum),
    }),
    z.object({
      type: z.literal("customer_domain"),
      domains: z.array(z.string()),
    }),
  ])).optional(),
});
```

`actionConfig` schema:

```ts
export const createIssueActionConfigSchema = z.object({
  teamId: z.string().optional(), // default team if omitted
  titleTemplate: z.string().optional(), // supports {{ticket.title}}
  descriptionTemplate: z.string().optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  status: z.enum(ISSUE_STATUSES).optional().default("triage"),
  labels: z.array(z.string()).optional(),
});
```

### Triggers

Evaluate rules at these points in `src/global/support-channels.ts` and the provider handlers:

1. `support_ticket.created` — after a new ticket is created.
2. `support_message.received` — after a new inbound message is added to an existing ticket.
3. `support_ticket.status_changed` — after `updateTicket` changes status.
4. `support_ticket.priority_changed` — after `updateTicket` changes priority.

For the first slice, implement **1 and 2**. 3 and 4 are follow-ups.

### Execution model

- Load active rules for the workspace ordered by `sortOrder`.
- Build a context object: `{ ticket, message?, customer, channel, source, subject, text, fromEmail }`.
- Evaluate each rule's `conditions` top-down.
- When a rule matches:
  - If `action` is `create_issue` and `ticket.issueId` is already set, skip (idempotent).
  - Call `WorkspaceDO.createIssue(...)` with the configured team/priority/status.
  - Update `support_tickets.issueId` with the new issue id.
  - Insert a `support_ticket_events` row of type `link_added`, `actorType: "automation"`, `actorId: rule.id`, `metadata: { issueId, ruleId }`.
  - Stop evaluating further `create_issue` rules for this ticket. Other action types (when added later) may continue.

### Manual linking

Already supported: `PATCH /support/tickets/:id` accepts `{ issueId: string | null }` and `updateTicket` writes it. The first slice must also fix `updateTicket` to emit `link_added`/`link_changed`/`link_removed` events when `issueId` changes, using `actorType: "user"` and the acting user id.

### API additions

- `GET    /support/escalation-rules` — list active rules.
- `POST   /support/escalation-rules` — create a rule.
- `GET    /support/escalation-rules/:ruleId` — get a rule.
- `PATCH  /support/escalation-rules/:ruleId` — update name, sortOrder, isActive, conditions, actionConfig.
- `DELETE /support/escalation-rules/:ruleId` — soft-delete (or hard-delete; decide in implementation).

### Open questions for decision

1. **Soft-delete vs hard-delete for rules?** Zendesk/Plain keep history; Linear can delete triage rules. Suggest hard-delete because rules are cheap and audit lives in `support_ticket_events`.
2. **Should the first slice include `support_message.received` or only `support_ticket.created`?** Plain and Jetson re-evaluate on new messages, which matters for long threads. Suggest including `support_message.received` from the start; the incremental cost is small.
3. **Should `createIssue` run synchronously in the webhook handler or async via `waitUntil`?** Synchronous is simpler and keeps tests deterministic. If support volume grows, move async later.
4. **Should we expose `support_ticket.status_changed`/`priority_changed` triggers in the first slice?** These are useful but not required for the core escalation flow. Defer to keep the first slice small.

## Boundaries

- **Always:** parse rule `conditions` and `actionConfig` with Zod before storing; validate templates at write time; narrow `env[...]` without `any`; record automation events.
- **Ask first:** generalizing to a cross-domain `automations` table; adding scheduled/cron triggers; adding approval-gated AI escalation.
- **Never:** store issue bodies in D1 (Durable Object owns issue state); commit secrets; auto-merge.

## Success criteria

- `PATCH /support/tickets/:id` with `issueId` links/unlinks and emits the right event.
- A rule with keywords `"bug"` and channel `intercom` creates an issue when an Intercom webhook creates a ticket.
- A rule with keywords `"urgent"` triggers on a second inbound email message and creates an issue for an existing ticket.
- `pnpm run typecheck && pnpm run check && pnpm test` green.
