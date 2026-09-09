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
- Agent dispatch and lifecycle: one active session per issue, provider result/PR writeback, failure handling, lifecycle realtime/webhook events (#27)
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
- Issue estimates, drafts, and Linear two-level sub-issue depth enforcement.
- Triage inbox (`GET /workspaces/{id}/triage`), triage auto-assignee per team, issue snoozing.
- Notification inbox: unread, snooze/unsnooze, per-recipient unread badge.
- Saved views: workspace sharing, per-user favorites, per-user default view.
- Issue templates: `templateId` on create + per-team `defaultTemplateId` defaults.
- Cycles: status/number/auto-rollover, scheduled cron rollover, capacity endpoint.
- Issue analytics: `groupBy` aggregates and per-cycle burndown series.
- One-command Cloudflare self-host (`pnpm run selfhost`) + Deploy-to-Cloudflare button for forks.
- GitLab integration:
  - Issue and note/comment webhook sync
  - Merge request sync with `fixes KEY-123` / `closes KEY-123` linking
  - Label, milestone, and assignee sync
  - MR diff notes
- GitHub Issues import adapter via `/import` (`source: "github-issues"`).
- Import job status tracking with `import_jobs` D1 table and `GET /workspaces/{id}/import/{jobId}`.
- Cursor-based import pagination/resume for GitHub Issues with `POST /workspaces/{id}/import/{jobId}/resume`.
- Import approval gates with `import_approvals` table, `POST /{jobId}/approve`, and `POST /{jobId}/reject`.
- Notion / documents integration:
  - `POST /workspaces/{id}/import` with `source: "notion"` (root page or workspace-wide search)
  - Markdown content import into Vortex documents
  - `notion_users` mapping for `createdById` / `updatedById`
  - `notion_installations` and `notion_page_mappings` D1 tables
  - Ongoing Notion webhook sync for page create/update/delete events
  - Notion database migration into Vortex issues
- Import adapters framework and first Atlassian adapters:
  - Generic `ImportSource` contract in `src/import`
  - `POST /workspaces/{id}/import` with `source: "jira" | "confluence"`
  - ADF-to-markdown converter
  - Jira Cloud issue import (projects, statuses, users, issues, comments, attachments)
  - Confluence Cloud page import (spaces, pages, ADF-to-markdown, parent-child hierarchy)

## Next

- Linear workspace migration and dogfooding.
- Zendesk / Intercom integrations.

## Later

- Self-host the issue tracker and use it as the source of truth for this project (#21).
- GitHub check run sync.
- Billing and metering.
- Full CLI parity.
- Slack: thread/reply sync, unfurls, interactive components.
- Frontend (after backend is solid).
