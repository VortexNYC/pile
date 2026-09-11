---
name: vortex-sdk
description: Use the generated TypeScript SDK (openapi-fetch wrapper) to call the Vortex API with full type safety.
---

# Vortex SDK

## Overview

The `issuetracker-client` package is an `openapi-fetch` client typed against the Vortex OpenAPI spec. Import it to call Vortex endpoints with end-to-end type inference.

## When to use

- You are building a TypeScript or JavaScript automation or integration.
- You want type-safe access to the Vortex HTTP API.
- You need a lightweight client with minimal setup.

## Setup

1. Install `issuetracker-client` from the workspace or registry.
2. Create a client with a base URL and workspace-scoped API key.
3. Call typed methods like `client.GET`, `client.POST`, etc.

```typescript
import { createIssueTrackerClient } from "issuetracker-client";

const client = createIssueTrackerClient({
  baseUrl: "https://<your-worker>",
  apiKey: process.env.VORTEX_API_KEY!,
});
```

## Common workflows

- List workspaces: `client.GET("/workspaces", {})`
- Create an issue:
  ```typescript
  await client.POST("/workspaces/{organizationId}/issues", {
    params: { path: { organizationId: "org-1" } },
    body: { title: "Bug", teamId: "team-1", priority: "medium" },
  });
  ```
- List support tickets: `client.GET("/workspaces/{organizationId}/support/tickets", { params: { path: { organizationId: "org-1" } } })`

## Verification

- `client.GET("/workspaces", {})` returns `{ data, error, response }`.
- `Authorization: Bearer <apiKey>` is sent on every request.
- Non-OK responses are returned in `error` rather than thrown.
