# Notion Integration

## Status

- Phase 1 (page import and user mapping): implemented.
- Phase 2 (ongoing webhook sync and database migration into issues): implemented.

## Objective

Let Vortex replace Notion as the source of truth for documents and issue backlogs by importing Notion pages into the existing Vortex `documents` model and Notion databases into Vortex `issues`. Ongoing webhook sync keeps documents in sync after the initial import.

## In scope — Phase 1: page import (done)

- `POST /workspaces/{organizationId}/import`
  - Body: `{ source: "notion", credentials: { token: string }, options?: { rootPageId?: string; spaceId?: string } }`
  - `token` is a Notion internal integration token (`ntn_...`).
  - If `rootPageId` is provided, import that single page.
  - If omitted, use `POST /v1/search` to discover and import all pages reachable by the integration.
  - Parent pages are imported before children where possible; `parentDocumentId` is set on a second pass using `notion_page_mappings`.
  - Creates or updates Vortex documents with `contentFormat: "markdown"`.
  - Preserves parent/child page hierarchy as `parentDocumentId`.
  - Records a `notion_page_mappings` row per page so re-imports update instead of duplicate.
  - Returns a summary: `{ created: number; updated: number; errors: number }`.
- `POST /workspaces/{organizationId}/notion/users`
  - Body: `{ userId: string; notionUserId: string }`
  - Map a Notion user ID to a Vortex user ID for `createdById` / `updatedById`.
- D1 tables:
  - `notion_installations` — `organizationId`, `workspaceId`, `token` (encrypted at rest by D1), `createdAt`.
  - `notion_users` — `organizationId`, `notionUserId`, `userId`.
  - `notion_page_mappings` — `organizationId`, `notionPageId`, `documentId`, `createdAt`, `updatedAt`.
- Notion API calls:
  - `GET /v1/pages/{page_id}` for title, icon, parent, created/last-edited users.
  - `GET /v1/pages/{page_id}/markdown` for content.
  - `POST /v1/search` to list pages when no `rootPageId` is given.
- Content handling:
  - Store Notion markdown directly in `document.content` with `contentFormat: "markdown"`.
  - Title from `properties.title` or first `# h1` in markdown.
  - Icon emoji copied to `document.icon` if present.
- OpenAPI / MCP / client / CLI parity regenerated.
- Integration tests using mocked Notion API responses.

## In scope — Phase 2a: database migration into issues (done)

- `POST /workspaces/{organizationId}/import`
  - Body: `{ source: "notion", credentials: { token: string }, options: { databaseId: string; teamId?: string } }`
  - `databaseId` is a Notion database ID.
  - Fetches database metadata with `GET /v1/databases/{database_id}` to discover the title property.
  - Paginates through rows with `POST /v1/databases/{database_id}/query`.
  - For each row, fetches `GET /v1/pages/{page_id}/markdown` for the description.
  - Creates or updates Vortex `issues` through the native Workspace DO `createIssue` / `updateIssue` paths.
  - Records `notion_issue_mappings` (organizationId, notionPageId, issueId) for idempotent re-imports.
  - `teamId` is passed through to `createIssue`; the workspace default team is used otherwise.
- D1 tables:
  - `notion_issue_mappings` — `organizationId`, `notionPageId`, `issueId`, `createdAt`, `updatedAt`.

## Out of scope

- Writing Vortex document edits back to Notion.
- Importing comments, permissions, file attachments, or embedded databases.
- Converting Notion blocks to BlockNote JSON (markdown is sufficient for page content).

## Data flow

```
POST /workspaces/{organizationId}/import { source: "notion" }
  ├─ validate token with GET /v1/users/me
  ├─ upsert notion_installations
  ├─ fetch Notion page(s)
  ├─ for each page:
  │   ├─ GET /v1/pages/{id}            → title, icon, parent, authors
  │   ├─ GET /v1/pages/{id}/markdown   → content
  │   ├─ resolve parentDocumentId from notion_page_mappings
  │   ├─ resolve createdById/updatedById from notion_users (fallback to importer)
  │   ├─ create or update Vortex document via WorkspaceDO
  │   └─ upsert notion_page_mappings
  └─ return summary
```

## Webhooks — Phase 2 (implemented)

Notion sends signed `POST` events to `/notion/{organizationId}/{workspaceId}`:

- Handshake request has no `X-Notion-Signature`; body is `{ verification_token }`. The token is stored on the matching `notion_installations` row.
- Event requests include `X-Notion-Signature: sha256=<hmac>` signed with the workspace's stored `verification_token`. The handler uses a constant-time comparison.
- Supported events: `page.created`, `page.content_updated`, `page.properties_updated`, `page.deleted`, `page.moved`.
- Event payload contains `entity.id` (page id) and `workspace_id`; handler fetches full page + markdown on create/update/move events and reuses the shared `syncNotionPage` logic.
- Update or create the mapped Vortex document; soft-delete on `page.deleted` by setting `trashedAt`.

## Security

- The import token travels only from the request body to a Notion API call; it is not logged.
- For ongoing webhooks, the `verification_token` is stored per workspace and used only for HMAC verification.
- All D1 writes use the existing RLS middleware.

## Verification

- `pnpm run typecheck`
- `pnpm run check`
- `pnpm run knip`
- `pnpm run scan:secrets`

## Files expected to change

- `src/import/notion.ts` — shared import adapter for pages and database migration.
- `src/api/import.ts` — registers `source: "notion"` on the shared `/import` route.
- `src/api/notion.ts` — Notion user mapping routes.
- `src/api/notion-webhook.ts` — Notion webhook handler.
- `src/platform/security.ts` — `/notion/*` as a public webhook path.
- `src/global/notion-client.ts` — typed Notion API helpers including database query.
- `src/global/notion-installations.ts`, `src/global/notion-users.ts`, `src/global/notion-page-mappings.ts`, `src/global/notion-issue-mappings.ts` — D1 helpers.
- `src/global/schema.ts` — `notion_installations`, `notion_users`, `notion_page_mappings`, `notion_issue_mappings` tables.
- `src/api/index.ts` — register Notion routes and webhook route.
- `src/api/index.test.ts` — import, webhook, and database tests.
- Generated OpenAPI / MCP / client / CLI artifacts.
- `migrations/` — D1 schema migrations for Notion tables.
