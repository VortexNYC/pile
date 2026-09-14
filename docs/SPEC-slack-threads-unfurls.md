# Spec: Slack thread/reply sync, unfurls, and interactive components

## Objective

Make the Pile Slack integration a first-class support channel. Every action a customer or agent can take in Slack must be available through the API, CLI, SDK, and MCP, so Pile can be used headless by other agents.

What we are building:

1. **DM → issue** — any Slack DM to the bot creates a Pile issue.
2. **Channel message → issue** — messages in a connected Slack channel can be turned into Pile issues through a message action or an emoji reaction.
3. **Reply sync** — messages in a Slack thread linked to a Pile issue become issue comments; issue comment updates are posted back to the thread.
4. **Emoji status sync** — emoji reactions on the top-level Slack message map to Pile status changes (e.g. `✅` → done, `👀` → in progress).
5. **Link unfurls** — Pile issue links shared in Slack show a compact preview with title, status, assignee, and priority.
6. **In-Slack actions** — quick actions on unfurls and notifications to assign, change status, snooze, set priority, and open in Pile.
7. **Interactive components** — a message action / button to create an issue from any Slack message, and a "View in Pile" button on issue notifications.
8. **Ingestion modes (future)** — one-to-one, time-based, AI-based, and manual ingestion so support teams can control how Slack messages become Pile threads.

Out of scope for this spec:

- Slash commands (already in `bot.onSlashCommand`/`/vortex`).
- @mention issue creation (already in `bot.onNewMention`).
- Real-time agent chat (covered by the `chat` SDK, not Slack-specific).
- AI-based grouping of related Slack messages into a single issue (post-MVP).
- Native help center / knowledge base (post-MVP).

## Competitive baseline

Pile's Slack integration must be at least as programmable as the best backend-first support tools. The table below maps what Linear, Notion, Jam, Pylon, and Plain do in Slack to Pile capabilities.

| Product    | Slack feature                                        | What Pile should expose                                                  |
| ---------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| **Linear** | Create issue from a Slack message                    | `POST /slack/actions` `create_issue` + message action                    |
| **Linear** | Sync Slack thread with issue comments                | `slack-threads` bidirectional sync via `bot.onSubscribedMessage`         |
| **Linear** | Rich issue link unfurls with quick actions           | `slack-unfurl` `link_shared` handler + action blocks                     |
| **Linear** | @Linear bot commands                                 | Already `bot.onNewMention`; expand to status queries                     |
| **Linear** | Channel and personal notifications                   | `notifySlack` for `issue.created/updated/commented`                      |
| **Notion** | Send Slack message to a database / create a page     | `POST /slack/actions` `create_issue` from any message                    |
| **Notion** | Slack notifications for mentions and changes         | Extend `notifySlack` for @mentions and assignment changes                |
| **Notion** | Rich link previews                                   | `slack-unfurl` for Pile issue / support ticket links                     |
| **Jam**    | Record bug + context and send to Slack               | Capture Slack attachments, file URLs, and message body on issue creation |
| **Jam**    | Rich recording link unfurls with previews            | `slack-unfurl` for Pile issues with attachments / metadata               |
| **Pylon**  | Auto-create tickets from Slack messages              | `slack-dm` and channel ingestion + `slack-actions` manual create         |
| **Pylon**  | Bi-directional Slack thread sync                     | `slack-threads` reply sync                                               |
| **Pylon**  | Internal triage threads from support request         | Future `support-escalation` Slack thread bridge                          |
| **Pylon**  | SLA tracking on Slack messages                       | Use `support-tickets` `createdAt` and `snoozedUntil` fields              |
| **Plain**  | In-Slack actions (assign, status, snooze, priority)  | `slack-actions` block / message actions                                  |
| **Plain**  | Emoji reaction status sync                           | `slack-emoji` reaction handler mapped to status transitions              |
| **Plain**  | Ingestion modes (one-to-one, time-based, AI, manual) | Future per-channel `ingestionMode` setting                               |
| **Plain**  | Sidekick AI in Slack                                 | Out of scope; Pile provides the API/CLI for agents to call               |

Design principle: **Plain is open infrastructure and Pylon is a full-stack app.** Pile should be open infrastructure — every Slack action is also an API call, CLI command, or MCP tool.

## Assumptions

- The `chat` SDK (`chat@4.40.0`) is the canonical abstraction for Slack events and interactive components.
- The Slack adapter is already installed and `slackInstallations` maps `teamId` → Pile `organizationId`.
- Pile issue links are `https://pile.nyc/<workspace>/issues/<identifier>` (custom domain mapping is a separate concern).
- Auth to Pile issues uses the existing workspace-scoped API token; the Slack bot acts as a system agent with a workspace token stored on the `slackInstallations` row (or generated for the bot).

## Slack Connect

B2B support happens in shared Slack Connect channels, so the design must not assume a single workspace.

- A Pile workspace can be linked to multiple Slack `team_id`s: one for the company workspace and one per customer workspace that has invited the bot into a shared channel.
- `slack_installations` must support `(organization_id, slack_team_id)` uniqueness, not just `team_id` globally.
- **Internal vs external classification** — the Slack `team_id` of the company workspace is **internal**; every other `team_id` in a shared channel or DM is **external**. A message is classified by the sender's `team_id`.
- Ingestion treats messages from **external** users as customer support requests and messages from **internal** users as agent replies.
- Replies in a Slack Connect thread are mirrored to the Pile support ticket; outbound Pile replies are posted to the customer-visible Slack thread only when the sender is an agent.
- **Internal-only notes** — add an `internal` boolean to `comments` and `support_messages`. Internal comments sync only to internal Slack threads or the Pile web surface; they never post to a customer-visible Slack thread.
- **Identity resolution** — a Slack `user_id` in a customer workspace is not the same as a Pile `user_id`. Link them lazily through `support_contacts.external_id` using a composite key `<slack_team_id>:<slack_user_id>`. Email from `users:read.email` is a best-effort enrichment, not a primary key, because external emails are often hidden in Slack Connect.
- Required OAuth scopes:
  - `commands` — for the existing `/vortex` slash command.
  - `app_mentions:read` — for existing @mention issue creation.
  - `chat:write`, `chat:write.public` — to post replies in public and private channels.
  - `channels:history`, `groups:history`, `im:history`, `mpim:history` — to read messages in public, private, DM, and group DM contexts.
  - `reactions:read`, `reactions:write` — for emoji status sync.
  - `files:read` — to capture Slack file/attachment metadata.
  - `links:read`, `links:write` — for Pile issue link unfurls.
  - `users:read`, `users:read.email` — to resolve Slack `user_id` to email for contact matching.
  - `team:read` — to distinguish the company Slack team from customer teams in Slack Connect.

## Data model

A single Slack conversation can map to a Pile issue and a Pile support ticket. Store the mapping once and reference it from both.

```
support_conversations
  - id (uuid)
  - organization_id
  - slack_team_id          # the workspace that owns the channel
  - slack_channel_id
  - slack_thread_ts        # top-level message timestamp; null for a DM or non-threaded channel message
  - issue_id               # the public-facing issue
  - support_ticket_id      # the internal support ticket
  - is_external            # true if the conversation started from a customer
  - created_at
  - updated_at
```

`slack_installations` must support `(organization_id, slack_team_id)` uniqueness so one Pile workspace can be installed into many customer Slack teams.

## Project structure

```
src/slack/bot.ts           # Chat bot handlers (existing)
src/slack/threads.ts       # Thread ↔ issue comment sync
src/slack/unfurl.ts        # link_shared preview generation
src/slack/actions.ts       # message_shortcut and block_actions handlers
src/slack/emoji.ts         # reaction_added / reaction_removed status sync
src/slack/attachments.ts   # Slack file / attachment capture
src/slack/messages.ts      # helpers for posting cards with buttons
src/slack/ingestion.ts     # v2: ingestion-mode decision logic
src/api/slack.ts           # HTTP routes (existing)
```

## Module map

| Module              | Responsibility                                                 | Depends on                                         |
| ------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| `slack-dm`          | DM to issue creation                                           | `chat` SDK, `WorkspaceDO`                          |
| `slack-actions`     | Create issue from any Slack message and in-Slack quick actions | `chat` SDK, `WorkspaceDO`                          |
| `slack-threads`     | Subscribe to issue threads and sync comments bidirectionally   | `chat` SDK, `WorkspaceDO`, `support-tickets`       |
| `slack-emoji`       | Map emoji reactions to Pile status transitions                 | `chat` SDK, `WorkspaceDO`                          |
| `slack-attachments` | Capture Slack file metadata and shareable URLs                 | `chat` SDK, `files:read`                           |
| `slack-unfurl`      | Generate link previews for Pile issue URLs                     | `chat` SDK, `global/support-tickets` or issues API |
| `slack-ingestion`   | v2: per-channel ingestion-mode selection for channel messages  | `chat` SDK, `global/support-channels`              |

MVP build order: `slack-dm` → `slack-actions` → `slack-attachments` → `slack-threads` → `slack-emoji` → `slack-unfurl`

v2 build order: `slack-ingestion` after the MVP is stable.

## Commands

- `pnpm run check` — full contract, lint, type, and test run.
- `pnpm vitest run src/slack` — Slack module tests.
- `pnpm -C packages/cli run build` — ensure CLI still builds.

## Code style

- Keep handlers in `src/slack/bot.ts` via `bot.onDirectMessage`, `bot.onSubscribedMessage`, `bot.onReaction`, `bot.onAction`, and `bot.onLinkShared` (if supported).
- Extract platform-specific transform logic into `src/slack/messages.ts`.
- Use `createIssueFromText` pattern already used for `onNewMention` and `onSlashCommand`.
- No `any`; use `unknown` and narrow.

## Testing strategy

- Unit tests for `src/slack/messages.ts` transform helpers.
- Integration tests for `src/api/slack.ts` event endpoint with mocked `Chat`/`SlackAdapter`.
- One end-to-end test that triggers a DM and asserts an issue is created.
- Negative tests: unknown Slack installation, invalid signature, duplicate event, unauthorized action.

## Boundaries

- Always: run `pnpm run check` before commit; update generated artifacts if API changes.
- Ask first: adding new `WorkerEnv` bindings or D1/Durable Object schema columns.
- Never: commit Slack tokens or signing secrets; store Slack raw event payloads in logs.

## Success criteria

1. A Slack DM to the bot creates a Pile issue and replies with the issue identifier.
2. A message action creates a Pile issue from an arbitrary Slack message.
3. Replies in a linked Slack thread become comments on the Pile issue and vice versa.
4. Emoji reactions on the top-level Slack message update Pile status.
5. Pile issue links unfurl in Slack with title, status, assignee, and quick actions.
6. Every Slack action is reachable through the API, CLI, SDK, or MCP.
7. `pnpm run check` and `pnpm run scan:secrets` are green.

## Event handling

Slack retries failed events quickly. All Slack HTTP handlers in `src/api/slack.ts` must respond with `200 OK` within 3 seconds and perform actual work asynchronously. Every non-trivial handler records an event idempotency key in `slack_events` to prevent duplicate processing.

- `message` and `message_changed` / `message_deleted` in linked threads update the mapped Pile issue / support ticket.
- `reaction_added` and `reaction_removed` on the top-level message drive `slack-emoji` status transitions.
- `link_shared` falls back to a raw Slack handler in `src/api/slack.ts` if the `chat` SDK does not expose `onLinkShared`.
- `block_actions` and `message_shortcut` route through `slack-actions`.

## Default emoji status map

Map emoji reactions on the top-level Slack message to Pile status transitions. Workspaces can override this map through `settings.slack_emoji_status_map`.

| Emoji | Pile status   | Meaning                             |
| ----- | ------------- | ----------------------------------- |
| `✅`  | `done`        | Resolve the issue / support ticket. |
| `👀`  | `in_progress` | Mark as being worked on.            |
| `🛑`  | `canceled`    | Close as canceled / not doing.      |
| `🔥`  | `urgent`      | Set priority to urgent.             |
| `😴`  | `snoozed`     | Snooze until tomorrow.              |

## Open questions

1. Should link unfurls be public (no auth) or require the user to be in the linked workspace?
