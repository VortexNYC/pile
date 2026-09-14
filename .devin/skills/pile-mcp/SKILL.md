---
name: pile-mcp
description: Connect a coding agent to Pile through the MCP server to create and manage issues, support tickets, and workspaces.
---

# Pile MCP

## Overview

The Pile MCP server exposes the entire OpenAPI contract as typed MCP tools. An agent can list resources, create issues, manage support tickets, and inspect workspace state through JSON-RPC calls over HTTP.

## When to use

- Provisioning or discovering Pile workspaces.
- Creating issues, teams, and support tickets from a coding agent.
- Querying the issue and ticket state without writing raw HTTP requests.

## Setup

1. Obtain a workspace-scoped API key from Pile (`/api/auth/api-keys` or the web auth flow).
2. Configure your MCP client with the endpoint `https://<your-worker>/mcp`.
3. Send the API key in the `Authorization: Bearer <token>` header.
4. Call `tools/list` to discover the available tools.

## Common workflows

- Create a workspace: `postWorkspaces`
- Create a team: `postWorkspacesOrganizationIdTeams`
- Create an issue: `postWorkspacesOrganizationIdIssues`
- List issues: `getWorkspacesOrganizationIdIssues`
- Create a support customer: `postWorkspacesOrganizationIdSupportCustomers`
- Create a support ticket: `postWorkspacesOrganizationIdSupportTickets`

## Verification

- `tools/list` returns the tool catalog.
- `getWorkspaces` returns an array of workspaces.
- `postWorkspaces` returns a workspace record when authenticated as a human session.
