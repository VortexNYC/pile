# Vortex Issue Tracker — Feature Parity Roadmap

This is the durable tracker for the open-source Linear alternative. Operational todos live in the agent session; the plan lives here.

## Done

- Linear API / CLI / MCP / docs parity audit and gap mapping (#20): `docs/linear-parity.md` maps all major Linear domains to Vortex status and identifies the next slices.
- Better Auth human sign-in and workspace user mapping: workspace routes now accept workspace tokens _or_ Better Auth sessions; membership roles enforce permissions; `POST /workspaces` creates an owner membership.
- `GET /workspaces/{id}/issues?identifier=KEY-123` lookup.
- `POST /workspaces` create endpoint (with `key`).
- GitHub assignee sync: map GitHub logins to Vortex users via github_users and set assigneeId on assigned/unassigned webhooks.
- GitHub milestone sync: create Vortex cycles from GitHub milestones and update issue cycleId on milestoned/demilestoned webhooks.
- GitHub issue label sync: map GitHub label names to Vortex labels and update issue labelIds on labeled/unlabeled webhooks.
- Outbound GitHub comment writeback: Vortex comment -> GitHub issue/PR comment.
- Magic-word PR linking: parse `fixes KEY-123` / `closes KEY-123` from PR title, body, or branch and update the linked Vortex issue.
- Outbound webhooks + notification delivery: issue/comment lifecycle events are emitted as realtime events, delivered to webhook subscriptions with retries, logged in `outbound_webhook_deliveries`, and surfaced as in-app notifications for assignees/subscribers.
- Workspace-scoped D1 + Durable Object SQLite architecture
- Hono `@hono/zod-openapi` API with generated OpenAPI/MCP/client
- Issues CRUD, history, subscribers, relations, comments, attachments
- States, labels, projects, cycles, templates
- Workspace tokens and membership model
- Better Auth ownership of workspaces, members, invitations, and teams: workspaces are Better Auth organizations; human/agent users are Better Auth `user` rows; members and team members live in Better Auth tables; API keys are credentials linked to those users
- MCP server
- Real-time DO events
- Linear user migration
- Agent dispatch
- Agent sessions and activities API (#27)
- Issue search and indexing: full-text search across issue title, description, identifier, and comments; applied to `GET /workspaces/{id}/issues?search=` and saved views.
- Initiatives and roadmaps (#26): `roadmaps` and `initiatives` D1 tables with CRUD, roadmap-to-initiative nesting, date/status, and `GET /workspaces/{id}/roadmaps/{id}/initiatives`.
- Multi-tenant GitHub App:
  - `github_installations` table
  - Installation / repository webhooks
  - Workspace lookup from `repo_branches` or `github_installations`
  - `POST /workspaces/{id}/github/install`
  - PR status automation (`draft`/`open`/`merged`/`closed`)
  - GitHub issue `opened`/`edited`/`closed`/`reopened` sync
  - Inbound `issue_comment` and `pull_request_review_comment` sync
- Workspace `key` and issue `identifier` (`KEY-123`)
- Blume docs site: `packages/docs` with OpenAPI reference, `llms.txt`, search, and the Vortex intro.

## Next

- Slack / Zendesk / GitLab / Intercom integrations.

## Later

- Self-host the issue tracker and use it as the source of truth for this project (#21).
- GitHub check run sync.
- Billing and metering.
- Full CLI parity.
- Slack / GitLab / Zendesk / Intercom integrations.
- Frontend (after backend is solid).
