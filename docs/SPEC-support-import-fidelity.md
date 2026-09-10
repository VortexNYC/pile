# Spec: Support Import Fidelity

## Objective

Make the Intercom, Plain, and Zendesk support import adapters capture the full provider timeline, not just the message text. Every `part`, `timelineEntry`, and `comment` the provider returns should be preserved in Vortex as a `support_ticket_event` of the closest native type.

## Success Criteria

1. Provider-specific notes (Intercom `note` parts, Plain `NoteEntry`, Zendesk `public=false` comments) are imported as `support_ticket_events` with `type = "note"`.
2. Every imported message/note/event records the original provider actor `actorType` (`customer` | `user` | `machine` | `system`) and `actorId`.
3. Provider attachments are stored in a new `support_ticket_attachments` table linked to the event.
4. Non-message timeline items (status changes, assignments, priority changes, labels, custom fields, ratings) are imported as `support_ticket_events` with `type` mapped to the closest native event type and original provider data in `support_ticket_events.metadata`.
5. The three adapter tests exercise notes and actor fields.
6. `pnpm run check` passes.

## Tech Stack

- Drizzle + SQLite/D1
- Zod for provider response validation
- Existing `src/global/support-tickets.ts` primitives

## Boundaries

- Always: provider-native parsing, Zod schemas, `pnpm run check` before commit.
- Ask first: changing the public REST API contract (we will not for this slice).
- Never: fabricate users, store secrets, downgrade checks, or use `any`.
