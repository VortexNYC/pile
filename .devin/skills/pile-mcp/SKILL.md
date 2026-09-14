---
name: pile-mcp
description: Connect a coding agent to Pile through the MCP server to create and manage issues, support tickets, and workspaces.
---

# Pile MCP

## Overview

The Pile MCP server exposes the entire OpenAPI contract as typed MCP tools. An agent can list resources, create issues, manage support tickets, and inspect workspace state through JSON-RPC calls over HTTP.

Every operation is available under a generated name derived from its route (for example `postWorkspacesOrganizationIdIssues` for `POST /workspaces/{organizationId}/issues`). The most common operations also have short aliases (`create_issue`, `list_issues`, ...). Both names accept identical arguments; use whichever you prefer.

## When to use

- Provisioning or discovering Pile workspaces.
- Creating issues, teams, and support tickets from a coding agent.
- Querying the issue and ticket state without writing raw HTTP requests.

## Setup

1. Obtain a workspace-scoped API key from Pile (`/api/auth/api-keys` or the web auth flow).
2. Configure your MCP client with the endpoint `https://<your-worker>/mcp` (the `BETTER_AUTH_URL` of your deployment, or `http://127.0.0.1:8787/mcp` for local `wrangler dev`).
3. Send the API key in the `Authorization: Bearer <token>` header.
4. Call `tools/list` to discover the available tools.

## Argument shape (read this first)

Tool arguments mirror the HTTP request, and every tool description spells out which fields it takes:

- **Path parameters** (`organizationId`, `id`, `issueId`, `ticketId`, ...) are **top-level** arguments and are always required.
- **Query parameters** (`identifier`, `status`, `limit`, ...) are **top-level** arguments and are optional.
- **The request body is wrapped in a `body` object.** Do not put body fields (`title`, `teamId`, ...) at the top level; they will be ignored or rejected.

```json
{
  "name": "create_issue",
  "arguments": {
    "organizationId": "org_vortex_main",
    "body": {
      "title": "Fix login redirect",
      "teamId": "team_123",
      "priority": "high"
    }
  }
}
```

The description of each tool lists the body fields and marks required ones with `*`, e.g.
`Request body goes in the "body" object (required); fields: title*, teamId, description, status, priority, ... (* = required).`

## Aliases

Alias names map 1:1 to generated names. The full list lives in `src/mcp/mcp-aliases.ts`; the ones you will use most:

| Alias                     | Generated name                                      | Route                                                         |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| `list_workspaces`         | `getWorkspaces`                                     | `GET /workspaces`                                             |
| `create_workspace`        | `postWorkspaces`                                    | `POST /workspaces`                                            |
| `list_teams`              | `getWorkspacesOrganizationIdTeams`                  | `GET /workspaces/{organizationId}/teams`                      |
| `create_team`             | `postWorkspacesOrganizationIdTeams`                 | `POST /workspaces/{organizationId}/teams`                     |
| `list_issues`             | `getWorkspacesOrganizationIdIssues`                 | `GET /workspaces/{organizationId}/issues`                     |
| `get_issue`               | `getWorkspacesOrganizationIdIssuesId`               | `GET /workspaces/{organizationId}/issues/{id}`                |
| `create_issue`            | `postWorkspacesOrganizationIdIssues`                | `POST /workspaces/{organizationId}/issues`                    |
| `update_issue`            | `patchWorkspacesOrganizationIdIssuesId`             | `PATCH /workspaces/{organizationId}/issues/{id}`              |
| `create_issue_comment`    | `postWorkspacesOrganizationIdIssuesIssueIdComments` | `POST /workspaces/{organizationId}/issues/{issueId}/comments` |
| `get_issue_branch_name`   | `getWorkspacesOrganizationIdIssuesIdBranchname`     | `GET /workspaces/{organizationId}/issues/{id}/branch-name`    |
| `search`                  | `postWorkspacesOrganizationIdSearch`                | `POST /workspaces/{organizationId}/search`                    |
| `create_support_customer` | `postWorkspacesOrganizationIdSupportCustomers`      | `POST /workspaces/{organizationId}/support/customers`         |
| `create_support_ticket`   | `postWorkspacesOrganizationIdSupportTickets`        | `POST /workspaces/{organizationId}/support/tickets`           |
| `list_support_tickets`    | `getWorkspacesOrganizationIdSupportTickets`         | `GET /workspaces/{organizationId}/support/tickets`            |

The generated tool's description ends with `Alias: <name>.` and the alias's description ends with `Same as <generated name>.`, so either can be found from the other in `tools/list`.

## Worked examples

All examples are `tools/call` requests; only `params` is shown.

Create a workspace (human session required):

```json
{
  "name": "create_workspace",
  "arguments": { "body": { "name": "Acme", "slug": "acme" } }
}
```

Create a team:

```json
{
  "name": "create_team",
  "arguments": {
    "organizationId": "org_123",
    "body": { "key": "ISS", "name": "Issue Tracker" }
  }
}
```

Look up an issue by identifier (query param, top level):

```json
{
  "name": "list_issues",
  "arguments": { "organizationId": "org_vortex_main", "identifier": "ISS-29" }
}
```

Create an issue (`title` is the only required body field):

```json
{
  "name": "create_issue",
  "arguments": {
    "organizationId": "org_vortex_main",
    "body": {
      "title": "MCP tool names are not agent-friendly",
      "teamId": "team_123",
      "description": "Add aliases and document the body wrapper.",
      "priority": "medium",
      "labelIds": ["label_abc"]
    }
  }
}
```

Update an issue's status (path param `id`, body carries the change):

```json
{
  "name": "update_issue",
  "arguments": {
    "organizationId": "org_vortex_main",
    "id": "issue_456",
    "body": { "status": "in_progress" }
  }
}
```

Comment on an issue (note the path param is `issueId` here, not `id`):

```json
{
  "name": "create_issue_comment",
  "arguments": {
    "organizationId": "org_vortex_main",
    "issueId": "issue_456",
    "body": { "body": "PR opened: https://github.com/VortexNYC/pile/pull/1" }
  }
}
```

Create a support ticket:

```json
{
  "name": "create_support_ticket",
  "arguments": {
    "organizationId": "org_123",
    "body": {
      "customerId": "cust_789",
      "title": "Cannot log in",
      "sourceChannel": "api",
      "message": "Customer reports a redirect loop."
    }
  }
}
```

## Common mistakes

- Putting body fields at the top level instead of inside `body`.
- Using `id` where the route uses `issueId` (or vice versa). Check the tool description: `Path params (top-level, required): organizationId, issueId.`
- Passing an API key that is not scoped to the `organizationId` you are calling; the tool returns `isError: true` with the HTTP error body as text.

## Verification

- `tools/list` returns the tool catalog (generated names plus aliases; no duplicates).
- `list_workspaces` (or `getWorkspaces`) returns an array of workspaces.
- `create_workspace` returns a workspace record when authenticated as a human session.
- `create_issue` followed by `list_issues` returns the new issue.
