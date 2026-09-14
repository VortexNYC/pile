# Spec: Slack thread/reply sync, unfurls, and interactive components

## Objective

Make the Pile Slack integration bidirectional so agents and customers can create and follow issues without leaving Slack.

What we are building:

1. **DM → issue** — any Slack DM to the bot creates a Pile issue.
2. **Reply sync** — messages in a Slack thread linked to a Pile issue become issue comments; issue comment updates are posted back to the thread.
3. **Link unfurls** — Pile issue links shared in Slack show a compact preview with title, status, assignee, and priority.
4. **Interactive components** — a message action / button to create an issue from any Slack message, and a "View in Pile" button on issue notifications.

Out of scope for this spec:

- Slash commands (already in `bot.onSlashCommand`/`/vortex`).
- @mention issue creation (already in `bot.onNewMention`).
- Real-time agent chat (covered by the `chat` SDK, not Slack-specific).

## Assumptions

- The `chat` SDK (`chat@4.40.0`) is the canonical abstraction for Slack events and interactive components.
- The Slack adapter is already installed and `slackInstallations` maps `teamId` → Pile `organizationId`.
- Pile issue links are `https://pile.nyc/<workspace>/issues/<identifier>` (custom domain mapping is a separate concern).
- Auth to Pile issues uses the existing workspace-scoped API token; the Slack bot acts as a system agent with a workspace token stored on the `slackInstallations` row (or generated for the bot).

## Project structure

```
src/slack/bot.ts         # Chat bot handlers (existing)
src/slack/threads.ts     # Thread ↔ issue comment sync
src/slack/unfurl.ts      # link_shared preview generation
src/slack/actions.ts     # message_shortcut and block_actions handlers
src/slack/messages.ts    # helpers for posting cards with buttons
src/api/slack.ts         # HTTP routes (existing)
```

## Module map

| Module          | Responsibility                                               | Depends on                                         |
| --------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| `slack-dm`      | DM to issue creation                                         | `chat` SDK, `WorkspaceDO`                          |
| `slack-threads` | Subscribe to issue threads and sync comments bidirectionally | `chat` SDK, `WorkspaceDO`, `support-tickets`       |
| `slack-unfurl`  | Generate link previews for Pile issue URLs                   | `chat` SDK, `global/support-tickets` or issues API |
| `slack-actions` | Handle `create_issue` and `view_issue` block/message actions | `chat` SDK, `WorkspaceDO`                          |

Build order: `slack-dm` → `slack-actions` → `slack-threads` → `slack-unfurl`

## Commands

- `pnpm run check` — full contract, lint, type, and test run.
- `pnpm vitest run src/slack` — Slack module tests.
- `pnpm -C packages/cli run build` — ensure CLI still builds.

## Code style

- Keep handlers in `src/slack/bot.ts` via `bot.onDirectMessage`, `bot.onSubscribedMessage`, `bot.onAction`, and `bot.onLinkShared` (if supported).
- Extract platform-specific transform logic into `src/slack/messages.ts`.
- Use `createIssueFromText` pattern already used for `onNewMention` and `onSlashCommand`.
- No `any`; use `unknown` and narrow.

## Testing strategy

- Unit tests for `src/slack/messages.ts` transform helpers.
- Integration tests for `src/api/slack.ts` event endpoint with mocked `Chat`/`SlackAdapter`.
- One end-to-end test that triggers a DM and asserts an issue is created.

## Boundaries

- Always: run `pnpm run check` before commit; update generated artifacts if API changes.
- Ask first: adding new `WorkerEnv` bindings or D1/Durable Object schema columns.
- Never: commit Slack tokens or signing secrets; store Slack raw event payloads in logs.

## Success criteria

1. A Slack DM to the bot creates a Pile issue and replies with the issue identifier.
2. Replies in that DM thread become comments on the Pile issue.
3. Pile issue links unfurl in Slack with title, status, and assignee.
4. A message action creates a Pile issue from an arbitrary Slack message.
5. `pnpm run check` and `pnpm run scan:secrets` are green.

## Open questions

1. Do we store the Slack thread id on the Pile issue or a separate `support_conversations` table?
2. Should link unfurls be public (no auth) or require the user to be in the linked workspace?
3. Does the `chat` SDK support `onLinkShared`, or do we need a raw Slack `link_shared` handler in `src/api/slack.ts`?
