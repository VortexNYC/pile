# Capability Map: Customer Support Layer in Vortex

## Objective

Replace Intercom / Zendesk / Plain.com with an internal, developer-friendly and agent-friendly customer support surface nested inside Vortex. The customer support tool should feel native to the issue tracker and to the agents that work it.

Build order follows the data dependencies, but migration adapters from Intercom and Zendesk are used as the reference schema to validate the internal model as we build it.

## Assumptions

1. The support model is centered on **tickets** (a.k.a. conversations) and **contacts** (customers / companies / leads).
2. The first channel is **email** + a webhook/POST endpoint; Slack, SMS and in-app messenger come later.
3. In-app chat and agent-side messaging use the **Vercel AI SDK** (`ai` package) rather than a custom chat layer.
4. Agent identity, assignment and team membership reuse existing Vortex `users`, `teams` and `organization_role` where possible.
5. Macros, canned replies and tags reuse the existing `labels` and `templates` concepts where possible.
6. Webhook HMAC verification follows the same pattern as the GitHub and GitLab handlers.

## Capabilities

| Module id           | Responsibility                                                                                         | Depends on                            |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `support-contacts`  | Customers, companies, leads and contact methods                                                        | `organization`, `user`                |
| `support-tickets`   | Conversations / tickets: state, priority, source channel, assignment                                   | `support-contacts`                    |
| `support-team`      | Agent assignment, away status, teams, SLA rules                                                        | `support-tickets`, existing `teams`   |
| `support-content`   | Macros, canned replies, tags, auto-replies                                                             | `support-tickets`                     |
| `support-capture`   | Bug capture: screenshot, screen recording, console logs, network requests, device info                 | `support-tickets`, `support-contacts` |
| `support-channels`  | Ingestion endpoints: email, webhook, Slack, SMS, in-app, capture; in-app/agent chat uses Vercel AI SDK | `support-tickets`, `support-capture`  |
| `support-inbox`     | Inbox views, queues, filters, real-time updates                                                        | `support-tickets`, `support-team`     |
| `support-migration` | Import and webhook sync from Intercom and Zendesk                                                      | `support-contacts`, `support-tickets` |
| `support-analytics` | Reporting, ratings, volume, SLA compliance                                                             | `support-tickets`, `support-team`     |

## Build Order

1. `support-contacts`
2. `support-tickets`
3. `support-capture` (parallel with `support-team` and `support-content`)
4. `support-team` (parallel with `support-content`)
5. `support-migration` (Intercom + Zendesk adapters validate the `support-contacts` and `support-tickets` schema)
6. `support-channels` (email, webhook, capture ingestion)
7. `support-inbox`
8. `support-analytics`

## Interfaces at the Boundaries

- `support-contacts` exposes contacts by `external_id` + `organization_id`.
- `support-tickets` exposes tickets by `number` (per-workspace) and `conversation_id`.
- `support-migration` writes into `support-contacts` and `support-tickets` using the same D1 mapping pattern as `intercom_conversations`.
- `support-channels` creates / appends to `support-tickets` and triggers `support-inbox` updates.

## Open Questions

1. Do we store support data in the per-workspace Durable Object SQLite or in D1?
2. Should tickets use the existing `workspaceIssues` table (with a `kind` or `source`) or a separate `support_tickets` table?
3. Should the in-app chat widget be a separate Worker or part of the issue tracker Worker? (Vercel AI SDK handles the chat layer in either case.)
4. Which channels are required for the first ship: email, Slack, SMS, in-app, or a subset?
5. Does the Vercel AI SDK chat use the same `support-tickets` data or a separate real-time conversation store?
