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
- Workspace-scoped D1 + Durable Object SQLite architecture
- Hono `@hono/zod-openapi` API with generated OpenAPI/MCP/client
- Issues CRUD, history, subscribers, relations, comments, attachments
- States, labels, projects, cycles, templates
- Workspace tokens and membership model
- MCP server
- Real-time DO events
- Linear user migration
- Agent dispatch
- Multi-tenant GitHub App:
  - `github_installations` table
  - Installation / repository webhooks
  - Workspace lookup from `repo_branches` or `github_installations`
  - `POST /workspaces/{id}/github/install`
  - PR status automation (`draft`/`open`/`merged`/`closed`)
  - GitHub issue `opened`/`edited`/`closed`/`reopened` sync
  - Inbound `issue_comment` and `pull_request_review_comment` sync
- Workspace `key` and issue `identifier` (`KEY-123`)

## Next

- Outbound webhooks and notification delivery (#22).
- Issue search and indexing (#23).
- Teams within a workspace (#24).
- Jira import (#25).
- Initiatives and roadmaps (#26).
- Agent sessions and activities API (#27).

## Later

- Self-host the issue tracker and use it as the source of truth for this project (#21).
- GitHub check run sync.
- Billing and metering.
- Published docs site and full CLI parity.
- Slack / GitLab / Zendesk / Intercom integrations.
- Frontend (after backend is solid).
