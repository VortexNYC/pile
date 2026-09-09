# Notion Integration

## Objective

Let Vortex replace Notion as the source of truth for documents by importing Notion pages into the existing Vortex `documents` model. The first slice is a one-time page import; ongoing webhook sync and database migration can follow.

## In scope — Phase 1: page import

- `POST /workspaces/{organizationId}/notion/import`
  - Body: `{ token: string; rootPageId?: string; spaceId?: string }`
  - `token` is a Notion internal integration token (`ntn_...`).
  - If `rootPageId` is provided, recursively import that page and its child pages.
  - If omitted, use `POST /v1/search` to discover all top-level pages reachable by the integration.
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

## Out of scope (future phases)

- Real-time webhook sync from Notion to Vortex.
- Writing Vortex document edits back to Notion.
- Syncing Notion databases into Vortex issues.
- Importing comments, permissions, file attachments, or embedded databases.
- Converting Notion blocks to BlockNote JSON (markdown is sufficient for Phase 1).

## Data flow

```
POST /notion/import
  ├─ fetch Notion page(s)
  ├─ for each page:
  │   ├─ GET /v1/pages/{id}        → title, icon, parent, authors
  │   ├─ GET /v1/pages/{id}/markdown → content
  │   ├─ resolve parentDocumentId from notion_page_mappings
  │   ├─ resolve createdById/updatedById from notion_users (fallback to importer)
  │   ├─ create or update Vortex document via WorkspaceDO
  │   └─ upsert notion_page_mappings
  └─ return summary
```

## Webhooks — Phase 2 (spec only)

Notion sends signed `POST` events to `/notion`:

- Handshake request has no `X-Notion-Signature`; body is `{ verification_token }`.
- Event requests include `X-Notion-Signature: sha256=<hmac>` signed with the workspace's stored `verification_token`.
- Supported events: `page.created`, `page.content_updated`, `page.properties_updated`, `page.deleted`, `page.moved`.
- Event payload contains `entity.id` (page id) and `workspace_id`; fetch full page + markdown on update events.
- Update or create the mapped Vortex document; soft-delete on `page.deleted`.

## Security

- The import token travels only from the request body to a Notion API call; it is not logged.
- For ongoing webhooks, the `verification_token` is stored per workspace and used only for HMAC verification.
- All D1 writes use the existing RLS middleware.

## Verification

- `pnpm run typecheck`
- `pnpm run check`
- `pnpm run knip`
- `pnpm run scan:secrets`

## Files expected to change (Phase 1)

- `src/api/notion.ts` — new routes and handlers.
- `src/global/notion-installations.ts`, `src/global/notion-users.ts`, `src/global/notion-page-mappings.ts` — new D1 helpers.
- `src/global/schema.ts` — new D1 tables.
- `src/types/env.ts` — optional `NOTION_API_URL` / `NOTION_API_VERSION` defaults.
- `src/api/index.ts` — register Notion routes.
- `src/api/index.test.ts` — import tests.
- Generated OpenAPI / MCP / client / CLI artifacts.
