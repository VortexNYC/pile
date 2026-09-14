---
name: pile-sdk
description: Use the generated TypeScript SDK (openapi-fetch wrapper) to call the Pile API with full type safety.
---

# Pile SDK

## Overview

The `pile-client` package is an `openapi-fetch` client typed against the Pile OpenAPI spec. Import it to call Pile endpoints with end-to-end type inference.

## When to use

- You are building a TypeScript or JavaScript automation or integration.
- You want type-safe access to the Pile HTTP API.
- You need a lightweight client with minimal setup.

## Setup

1. Install `pile-client` from the workspace or registry.
2. Create a client with a base URL and workspace-scoped API key.
3. Call typed methods like `client.GET`, `client.POST`, etc.

```typescript
import { createPileClient } from "pile-client";

const client = createPileClient({
  baseUrl: "https://pile.nyc",
  apiKey: process.env.PILE_API_KEY!,
});
```

### Auth options

```typescript
// Workspace API key (default)
createPileClient({ baseUrl, apiKey });
// Explicit session cookie (server-side, on behalf of a signed-in user)
createPileClient({ baseUrl, auth: { type: "session", cookie: "better-auth.session_token=..." } });
// Browser: send the ambient session cookie via credentials: "include"
createPileClient({ baseUrl, auth: { type: "browser" } });
```

### Retries

Idempotent requests (`GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`) are retried on network failures and
408/425/429/5xx with exponential backoff (2 retries, `Retry-After` honoured). Tune with
`retry: { maxRetries, retryOnStatus, retryMethods, baseDelayMs, maxDelayMs }` or disable with `retry: false`.

### Typed errors

```typescript
import { unwrap, PileRequestError, isPileErrorCodeOf, toPileError } from "pile-client";

try {
  const data = await unwrap(client.GET("/workspaces", {}));
} catch (err) {
  if (err instanceof PileRequestError && isPileErrorCodeOf(err.error, "UNAUTHORIZED")) { /* ... */ }
}

// or without throwing:
const { error, response } = await client.GET("/workspaces", {});
if (error) {
  const pileError = toPileError(error, response); // PileApiError | PileHttpError | PileNetworkError
}
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
