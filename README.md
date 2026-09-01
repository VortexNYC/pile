# Notion Engineering Queue

A Notion-backed engineering work queue that dispatches to [Devin](https://devin.ai) (or any compatible SWE agent) and writes the session URL, PR URL, and final status back to the Notion page. It replicates the core issue-tracking behavior of Linear — states, priorities, projects, labels, cycles, milestones, initiatives, assignees, subscribers, sub-issues, and related issues — using Notion databases and a tiny Cloudflare Worker.

## Features

- **Linear-style issue tracking in Notion**: Team, Project, Cycle, Milestone, Initiative, Priority, Labels, Assignee, Due, Estimate, SLA, Parent/Sub-issues, Related issues, Subscribers, Triage, Release, and `VOR-` style auto-numbered Issue IDs.
- **One-click Devin dispatch**: check the `Devin` checkbox or set `Status = Ready` to start a session on a Daytona outpost.
- **Webhook + cron fallback**: Notion `page.properties_updated` events trigger dispatch in real time; a one-minute cron polls `Running` sessions and writes back the terminal state.
- **Result write-back**: appends a `Devin Result` block to the page with status, session link, and PR link.
- **Duplicate protection**: searches Devin sessions by Notion page ID tag and reuses an existing session instead of starting a second one.
- **Priority sorting**: `Ready` queue is ordered by `Priority` descending.
- **Views**: Board, Project Board, Priority Board, Backlog, Done, High Priority.

## Why `select` for `Status` instead of Notion's native `Status` type

Notion's API currently cannot update values that live in the `in_progress` group of a `status` property ([makenotion/notion-mcp-server#232](https://github.com/makenotion/notion-mcp-server/issues/232)). The `Running` state is an in-progress value, so the Worker cannot write it via the API. Once Notion fixes this, migrating `Status` to the `status` type is a one-line schema change.

## Setup

1. `pnpm install`
2. `cp wrangler.toml.example wrangler.toml` and fill in your Devin org, Notion data source, and outpost.
3. Add secrets:
   ```bash
   wrangler secret put DEVIN_TOKEN
   wrangler secret put NOTION_TOKEN
   # optional: NOTION_VERIFICATION_TOKEN if you want signed webhooks
   ```
4. In Notion, create a `Vortex Engineering Queue` data source with the properties documented below, or duplicate the template and connect the integration.
5. Subscribe the Worker URL `https://<worker>.workers.dev/notion-webhook` to the `page.properties_updated` and `page.created` events.

## Notion data source properties

| Property | Type | Purpose |
|---|---|---|
| Name | title | Issue title |
| Description | rich_text | Body / repro steps |
| Issue ID | unique_id (`VOR` prefix) | Auto-numbered identifier |
| Team | select | `VOR` |
| Project | select | e.g. `Payments plant` |
| Cycle | select | Sprint / cycle |
| Milestone | select | Release milestone |
| Initiative | select | Strategic initiative |
| Priority | select | `Low` / `Medium` / `High` |
| Labels | multi_select | Linear-style labels |
| Status | select | `Backlog`, `Ready`, `Running`, `Done`, `Archived`, `Failed` |
| Devin | checkbox | One-click assign to Devin |
| Devin Session | url | Created by the Worker |
| PR | url | Created by the Worker |
| Repo | rich_text | `owner/repo` |
| Branch | rich_text | Target branch |
| Linear | url | Legacy Linear reference |
| Assignee | people | Owner |
| Subscribers | people | Watchers |
| Due | date | Due date |
| Target | date | Target / SLA start |
| Started | date | When work started |
| Completed | date | When work finished |
| Estimate | number | Estimate |
| SLA (hours) | number | SLA target |
| Customer Ticket Count | number | Support ticket count |
| Release | select | Release name |
| Parent | relation (self) | Sub-issue parent |
| Related | relation (self) | Related issues |
| Triage | checkbox | Triage flag |
| Platform | select | `user:daytona-linux` |
| Model | select | `swe-1-7-medium` / `swe-1-7` |

## Usage

- **Backlog** issues are dormant.
- **Devin** checkbox: set `Devin = true` on a `Backlog` / `Archived` row to promote it to `Ready`, then a second webhook fires and creates the Devin session.
- **Status = Ready** (manually or from the checkbox above): the Worker creates the Devin session and flips `Status` to `Running`.
- When the session terminates, the Worker writes `Status = Done` or `Failed` and sets `PR` if a PR was opened.

## Tests

```bash
pnpm install
pnpm test
pnpm typecheck
```

Tests cover pure helper functions: Notion property extraction, session terminal-state detection, URL parsing, prompt building, and HMAC verification.

## License

MIT — see [LICENSE](./LICENSE).

## Template / commercial use

The Worker is open source. The Notion data source can be published as a **Notion template** (public duplicate link) or bundled with the Worker as a paid starter kit. The open-source Worker drives traffic and contributions; the template or hosted setup is the product.
