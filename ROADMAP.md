# Vortex Issue Tracker — Feature Parity Roadmap

This is the durable tracker for the open-source Linear alternative. Operational todos live in the agent session; the plan lives here.

## Done

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

- Linear API / CLI / MCP / docs parity audit and gap mapping (#20).
- `GET /workspaces/{id}/issues?identifier=KEY-123` lookup.
- `POST /workspaces` create endpoint (with `key`).
- Better Auth human sign-in and workspace user mapping.

## Later

- Self-host the issue tracker and use it as the source of truth for this project (#21).
- GitHub label / assignee / milestone / check run sync.
- Agent sessions and activities API.
- Search and indexing.
- Notifications and outbound webhooks.
- Billing and metering.
- Frontend (after backend is solid).
