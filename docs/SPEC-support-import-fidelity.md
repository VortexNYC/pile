# Spec: Support Import Fidelity

## Objective

Make the Intercom, Plain, and Zendesk support import adapters capture the full provider timeline, not just the message text. Every `part`, `timelineEntry`, and `comment` the provider returns should be preserved in Vortex as a `support_ticket_event` of the closest native type.

## Success Criteria

1. Provider-specific notes (Intercom `note` parts, Plain `NoteEntry`, Zendesk `public=false` comments) are imported as `support_ticket_events` with `type = "note"`.
2. Every imported message/note/event records the original provider actor `actorType` (`customer` | `user` | `machine` | `system`) and `actorId`.
3. Provider attachments are stored in a new `support_ticket_attachments` table linked to the event.
4. Non-message timeline items (status changes, assignments, priority changes, labels, custom fields, ratings) are imported as `support_ticket_events` with `type` mapped to the closest native event type and original provider data in `support_ticket_events.metadata`.
5. The three adapter tests exercise notes, actor fields, attachments, metadata, and non-message events.
6. `pnpm run check` passes.

## Implemented Mapping

### Schema

- `support_ticket_events.metadata` stores the full provider payload / delta as JSON text.
- `support_ticket_attachments` links attachments to `ticketId` and `eventId` with `externalId`, `url`, `fileName`, `contentType`, `size`, `r2Key`, `createdAt`.

### Primitive

- `addTicketMessage`, `addTicketNote`, `addTicketEvent`, `addSupportTicketAttachment` accept explicit `actorType`, `actorId`, `metadata`, and `createdAt`.
- `ingestSupportTimeline` creates the first inbound message, then replies and events in provider order, attaching attachments to the correct event.

### Intercom

- `conversation_parts` are sorted by `created_at` and mapped:
  - `comment` → `message`
  - `note` → `note`
  - `open`/`close`/`snoozed`/`waiting` → `status_change`
  - `assigned`/`unassigned`/`assignment` → `assignment_change`
  - `conversation_rating`/`rating`/`survey`/`feedback`/`csat`/`nps` → `customer_event`
  - everything else → `field_change`
- `author.type` is normalized to `customer`/`user`/`machine`/`system`.
- `attachments` on `comment`/`note` parts are captured.

### Plain

- `timelineEntries` are fetched with `llmText`, actor fragments (`CustomerActor`, `DeletedCustomerActor`, `UserActor`, `SystemActor`, `MachineUserActor`), and `entry.__typename` (aliased to `typename`).
- `NoteEntry` → `note`; `ChatEntry`, `EmailEntry`, `SlackMessageEntry`, `SlackReplyEntry`, `MSTeamsMessageEntry`, `DiscordMessageEntry`, `ThreadDiscussionMessageEntry`, `MergedThreadMessageEntry`, `HelpCenterAiConversationMessageEntry`, `CustomEntry` → `message`.
- `ThreadStatusTransitionedEntry` → `status_change`; `ThreadPriorityChangedEntry` → `priority_change`; `ThreadAssignmentTransitionedEntry`/`ThreadAdditionalAssigneesTransitionedEntry` → `assignment_change`; `ThreadLabelsChangedEntry` → `label_added`; `CustomerEventEntry`/`CustomerSurveyRequestedEntry`/`CustomEntry` → `customer_event`; all remaining types → `field_change`.
- `attachments` on message-like entries are captured; Plain does not expose a persistent attachment URL on `Attachment`, only a short-lived `createAttachmentDownloadUrl` mutation, so `url` is stored as `null` and the attachment ID is preserved for later resolution.

### Zendesk

- `comments` are fetched with `include=users`.
- `public=false` comments → `note`; `public=true` comments → `message`.
- `author_id` is resolved to a `role` from the included users; `requester_id`/`end-user` → `customer`, `agent`/`admin` → `user`, `system` → `system`.
- `via.channel` is normalized to a native message channel.
- `attachments` on comments are captured.
- A `field_change` event is synthesized from the raw `ticket` payload to preserve subject/status/priority/tags/custom fields.

## Caveats

- Plain attachment URLs are not stored because Plain only returns a 3-minute signed `downloadUrl` via `createAttachmentDownloadUrl`; the attachment ID and metadata are preserved so the URL can be resolved on demand.
- `CustomEntry` and `ThreadDiscussion*` entries are mapped to `customer_event`/`field_change` with the full `entry` payload in `metadata`; there is not yet a dedicated Vortex event type for every Plain-specific entry.
- Sequential provider pagination remains intentional; `Promise.all` is used per page and per reply/event for order-insensitive writes.

## Boundaries

- Always: provider-native parsing, Zod schemas, `pnpm run check` before commit.
- Ask first: changing the public REST API contract (we will not for this slice).
- Never: fabricate users, store secrets, downgrade checks, or use `any`.
