# Spec: Support Import Fidelity

## Objective

Make the Intercom, Plain, and Zendesk support import adapters capture the full provider timeline, not just the message text. Every `part`, `timelineEntry`, and `comment` the provider returns should be preserved in Vortex as a `support_ticket_event` of the closest native type.

## Success Criteria

1. Provider-specific notes (Intercom `note` parts, Plain `NoteEntry`, Zendesk `public=false` comments) are imported as `support_ticket_events` with `type = "note"`.
2. Every imported message/note/event records the original provider actor `actorType` (`customer` | `user` | `agent` | `automation`) and `actorId`.
3. Provider attachments are stored in a new `support_ticket_attachments` table linked to the event.
4. Non-message timeline items are imported as `support_ticket_events` with `type` mapped to a proper native event type and `subType` preserving the exact provider entry/event name.
5. The three adapter tests exercise notes, actor fields, attachments, metadata, `subType`, and the full event type taxonomy.
6. `pnpm run check` passes.

## Implemented Mapping

### Schema

- `support_ticket_events.type` is a typed, native Vortex event category (e.g. `status_change`, `label_added`, `sla_change`, `link_added`).
- `support_ticket_events.sub_type` stores the exact provider entry name (e.g. `ThreadLinkCreatedEntry`, `conversation_rating`, `Change:tags`) so every provider concept has a home.
- `support_ticket_events.metadata` stores the full provider payload / delta as JSON text.
- `support_ticket_attachments` links attachments to `ticketId` and `eventId` with `externalId`, `url`, `fileName`, `contentType`, `size`, `r2Key`, `createdAt`.

### Primitive

- `addTicketMessage`, `addTicketNote`, `addTicketEvent`, `addSupportTicketAttachment` accept explicit `actorType`, `actorId`, `subType`, `metadata`, and `createdAt`.
- `ingestSupportTimeline` creates the first inbound message, then replies and events in provider order, attaching attachments to the correct event.
- `findUserByEmail` resolves a provider agent to a Vortex `user` by email.
- `setTicketAssignees` replaces a ticket's current assignees; only matched Vortex users are linked, preserving `isPrimary` for the primary owner.

### Contact graph

- `support_customers`, `support_companies`, `support_customer_companies`, and `support_customer_identities` are populated during import.
- `support_customer_identities.type` is a native channel (`email`, `phone`, `slack`, `msteams`, `discord`, `whatsapp`, `chat`, `api`, `social`, `custom`).
- `support_customer_identities.sub_type` stores the exact provider identity type (`EmailCustomerIdentity`, `twitter`, `facebook`, etc.).
- `findOrCreateCompany` deduplicates companies by `externalId` + `externalSource` so repeated runs don't duplicate `support_companies`.

### Intercom contacts

- The primary contact from `conversation.contacts` is looked up with `/contacts/{id}` to fetch `companies`, `phone`, `external_id`, `custom_attributes`, and `social_profiles`.
- `companies` become `support_companies` (domain from `website`, external id from `company_id` > `id`).
- `email` and `phone` become `email`/`phone` identities; `social_profiles` become `social` or `custom` identities with the provider `sub_type` preserved.
- `conversation.assignee` with `type = "admin"` and a matching Vortex user email populates `support_ticket_assignments`.

### Plain customers

- The thread's `customer` now includes `externalId`, `identities`, `company`, and `tenantMemberships(first: 20)`.
- `customer.company` becomes the primary `support_company`.
- `customer.tenantMemberships.edges[].node.tenant` become additional `support_company` rows (`externalId` from `externalId` > `id`).
- `customer.identities` (`EmailCustomerIdentity`, `SlackCustomerIdentity`, `DiscordCustomerIdentity`) become `support_customer_identities` with the original `__typename` as `sub_type`.
- `thread.assignedTo` (when `User` with email) and `thread.additionalAssignees` resolve to Vortex users and populate `support_ticket_assignments`.

### Zendesk users and organizations

- `listZendeskTickets` includes `users`; `users` now include `phone` and `organization_id`.
- `listAllZendeskOrganizations` fetches all organizations and maps `requester.organization_id` to a `support_company`.
- `requester.email` and `requester.phone` become `email`/`phone` identities.
- `ticket.assignee_id` resolves to a Vortex user by email and populates `support_ticket_assignments`.

### Intercom

- `conversation_parts` are sorted by `created_at` and mapped:
  - `comment`, `whatsapp`, `linked_message` (with `body`) → `message`
  - `note` (with `body`) → `note`
  - `open`/`close`/`snoozed`/`waiting` → `status_change`
  - `assigned`/`unassigned`/`assignment` → `assignment_change`
  - `conversation_rating`/`rating`/`survey`/`csat`/`nps` → `survey_received`
  - `feedback` → `customer_event`
  - `custom_bot`/`custom_card` → `custom_entry`
  - `follow_up`/`push_notification`/`whatsapp`/`linked_message` (no `body`) → `notification`
  - `source_add`/`ticket_shared`/`automation_flywheel`/`log_event`/`default` → `thread_event`
  - everything else → `field_change`
- `subType` = `part_type`.
- `author.type` is normalized to `customer`/`user`/`agent`/`automation`.
- `attachments` on `comment`/`note`/`whatsapp`/`linked_message` parts are captured.

### Plain

- `timelineEntries` are fetched with `llmText`, actor fragments (`CustomerActor`, `DeletedCustomerActor`, `UserActor`, `SystemActor`, `MachineUserActor`), and `entry.__typename` (aliased to `typename`).
- `NoteEntry` → `note` (`subType = NoteEntry`).
- `ChatEntry`, `EmailEntry`, `SlackMessageEntry`, `SlackReplyEntry`, `MSTeamsMessageEntry`, `DiscordMessageEntry`, `ThreadDiscussionMessageEntry`, `MergedThreadMessageEntry`, `HelpCenterAiConversationMessageEntry` → `message` (`subType = typename`).
- `ThreadStatusTransitionedEntry` → `status_change`
- `ThreadPriorityChangedEntry` → `priority_change`
- `ThreadAssignmentTransitionedEntry`/`ThreadAdditionalAssigneesTransitionedEntry` → `assignment_change`
- `ThreadLabelsChangedEntry` → `label_added`/`label_removed` (diff of `previousLabels`/`nextLabels`)
- `CustomerEventEntry` → `customer_event`
- `CustomerSurveyRequestedEntry` → `survey_requested`
- `ThreadServiceLevelAgreementPolicyChangedEntry`/`ServiceLevelAgreementStatusTransitionedEntry` → `sla_change`
- `ThreadLinkCreatedEntry`/`ThreadLinkTargetCreatedEntry` → `link_added`
- `ThreadLinkUpdatedEntry` → `link_changed`
- `ThreadLinkDeletedEntry`/`ThreadLinkTargetDeletedEntry` → `link_removed`
- `ThreadDiscussionEntry` → `discussion`
- `ThreadDiscussionResolvedEntry` → `discussion_resolved`
- `ThreadEventEntry` → `thread_event`
- `CustomEntry` → `custom_entry`
- `LinearIssueThreadLinkStateTransitionedEntry` → `external_reference_changed`
- All `subType` values equal `entry.typename`.
- `attachments` on message-like entries are captured; Plain does not expose a persistent attachment URL on `Attachment`, only a short-lived `createAttachmentDownloadUrl` mutation, so `url` is stored as `null` and the attachment ID is preserved for later resolution.

### Zendesk

- `comments` are fetched with `include=users`.
- `public=false` comments → `note` (`subType = InternalComment`); `public=true` comments → `message` (`subType = Comment`).
- `author_id` is resolved to a `role` from the included users; `requester_id`/`end-user` → `customer`, `agent`/`admin` → `user`, `system` → `automation`.
- `via.channel` is normalized to a native message channel.
- `attachments` on comments are captured.
- `audits` are fetched and each audit `event` is mapped:
  - `Change` on `status`/`priority`/`assignee_id`/`group_id`/`tags` → `status_change`/`priority_change`/`assignment_change`/`label_added`/`label_removed` (`subType = Change:{field_name}`)
  - `Change` on other fields → `field_change`
  - `SatisfactionRating` → `survey_received`
  - `Notification`/`NotificationWithCcs`/`ForwardingEvent` → `notification`
  - `Cc`/`FollowersCc`/`FollowerChangeAction` → `watchers_changed`
  - `ProblemSolvedEvent`/`ProblemsSolvedEvent` → `status_change`
  - `Create`/`AgentWorkspaceSwitch`/`ExternalEvent`/`ChannelFrameworkEvent`/`AgentMacroReference`/`OrganizationActivity`/`Error`/`CommentPrivacyChange` → `thread_event`
  - `Comment`/`VoiceComment` → skipped (already in `comments.json`)
  - everything else → `field_change`
- A `field_change` event is synthesized from the raw `ticket` payload to preserve subject/status/priority/tags/custom fields.

## Caveats

- Plain attachment URLs are not stored because Plain only returns a 3-minute signed `downloadUrl` via `createAttachmentDownloadUrl`; the attachment ID and metadata are preserved so the URL can be resolved on demand.
- Sequential provider pagination remains intentional; `Promise.all` is used per page and per reply/event for order-insensitive writes.
- Zendesk `Comment`/`VoiceComment` audit events are intentionally skipped because the comments endpoint already provides them; `Comment` bodies with `attachments` are in `support_ticket_attachments`.

## Boundaries

- Always: provider-native parsing, Zod schemas, `pnpm run check` before commit.
- Ask first: changing the public REST API contract (we will not for this slice).
- Never: fabricate users, store secrets, downgrade checks, or use `any`.
