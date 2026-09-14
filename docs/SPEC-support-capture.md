# Spec: support-capture

## Objective

Define the bug-capture module for the customer support layer.

`support-capture` lets customers and agents record bugs from a website or app, attach screenshots, screen recordings, console logs, network requests, and device info, and turn the result into a `support_ticket` with attachments. It is a Jam / Crikket-style capture channel that feeds the same `support_tickets` and `support_ticket_events` tables as email, Slack, and chat.

This module depends on `support-contacts` and `support-tickets`.

## Tech Stack

- TypeScript.
- Hono + `@hono/zod-openapi`.
- Drizzle ORM on D1.
- Zod for input validation.
- Cloudflare R2 for artifact storage (`ATTACHMENTS_BUCKET`).
- Native Web Crypto for token signing.

## Commands

```bash
pnpm exec vp check --fix
pnpm test
pnpm run db:generate
CLOUDFLARE_API_TOKEN=... pnpm exec wrangler d1 migrations apply issuetracker-global -e production --remote
CLOUDFLARE_API_TOKEN=... pnpm exec wrangler deploy -e production
```

## Project Structure

```
src/global/support-capture.ts     # D1 helpers
src/global/schema.ts              # support_capture_public_keys, support_capture_sessions, support_ticket_attachments tables
src/capture/                      # token, upload, finalize handlers
src/api/support-capture.ts        # REST routes
src/mcp/...                       # generated
packages/client/src/types.ts      # generated
packages/cli/src/commands.ts      # generated
migrations/                       # Drizzle-generated D1 migrations
```

## Data Model

### `support_capture_public_keys`

Public keys scoped to a website or app surface. Reuses the Crikket pattern.

| Column            | Type                   | Notes                            |
| ----------------- | ---------------------- | -------------------------------- |
| `id`              | text PK                | Vortex UUID                      |
| `organization_id` | text FK → organization | workspace                        |
| `name`            | text                   | not null; e.g., "Marketing Site" |
| `key`             | text                   | not null; `crk_...` or `vtx_...` |
| `allowed_origins` | text                   | JSON array of exact origins      |
| `is_active`       | boolean                | default true                     |
| `created_at`      | text                   | ISO timestamp                    |
| `updated_at`      | text                   | ISO timestamp                    |

Unique: `(organization_id, key)`.

### `support_capture_sessions`

Pending upload session. Crikket calls this `bugReportUploadSession`.

| Column            | Type                                  | Notes                                                                  |
| ----------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `id`              | text PK                               | Vortex UUID                                                            |
| `organization_id` | text FK → organization                | workspace                                                              |
| `public_key_id`   | text FK → support_capture_public_keys | which key started it                                                   |
| `customer_id`     | text FK → support_customers           | nullable until identified                                              |
| `ticket_id`       | text FK → support_tickets             | nullable until finalized                                               |
| `status`          | text                                  | `pending`, `uploading`, `finalized`, `expired`                         |
| `metadata`        | text                                  | JSON; title, description, url, tags, device info, priority, visibility |
| `expires_at`      | text                                  | ISO timestamp                                                          |
| `created_at`      | text                                  | ISO timestamp                                                          |

Index: `(organization_id, status, expires_at)`.

### `support_ticket_attachments`

Artifacts linked to a ticket. Screenshot, video, or debugger payload.

| Column            | Type                            | Notes                                                    |
| ----------------- | ------------------------------- | -------------------------------------------------------- |
| `id`              | text PK                         | Vortex UUID                                              |
| `organization_id` | text FK → organization          | workspace                                                |
| `ticket_id`       | text FK → support_tickets       | not null                                                 |
| `event_id`        | text FK → support_ticket_events | the message/note this attachment belongs to              |
| `type`            | text                            | `screenshot`, `video`, `debugger_json`, `log`, `network` |
| `content_type`    | text                            | e.g., `image/png`, `video/webm`                          |
| `r2_key`          | text                            | not null                                                 |
| `r2_size_bytes`   | integer                         | nullable                                                 |
| `url`             | text                            | presigned / public R2 URL                                |
| `created_at`      | text                            | ISO timestamp                                            |

Index: `(ticket_id, type)`.

## Code Style

```ts
export const supportCaptureSessionSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  publicKeyId: z.string(),
  customerId: z.string().optional(),
  ticketId: z.string().optional(),
  status: z.enum(["pending", "uploading", "finalized", "expired"]),
  metadata: z.record(z.unknown()).default({}),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export type SupportCaptureSession = z.infer<typeof supportCaptureSessionSchema>;
```

- snake_case in SQL, camelCase in TypeScript.
- `metadata` is `record(unknown)`; validated by capture-specific Zod on read/write.
- No `any`.

## API Surface

### `POST /workspaces/{organizationId}/support/capture/public-keys`

Create a public key for an embed surface. Body: `name`, `allowedOrigins`.

### `GET /workspaces/{organizationId}/support/capture/public-keys`

List public keys.

### `DELETE /workspaces/{organizationId}/support/capture/public-keys/{keyId}`

Revoke a key.

### `POST /support/capture/token`

Client-side endpoint. Returns a short-lived capture token. Headers: `x-pile-capture-public-key`, `origin`.

### `POST /support/capture/upload-session`

Client-side. Creates a pending capture session and returns an `uploadUrl` for the artifact. Body: `title`, `description`, `priority`, `tags`, `url`, `attachmentType`, `visibility`, `metadata`, `deviceInfo`.

### `POST /support/capture/upload/{sessionId}`

Direct R2 upload or presigned URL. For v1, the client uploads the screenshot/video directly to R2 using a presigned URL returned by `upload-session`.

### `POST /support/capture/finalize`

Client-side. Completes the upload, creates/updates the `support_ticket`, creates the `support_ticket_events` row, and returns the `ticketId` and `shareUrl`. Headers: `x-pile-capture-token`, `x-pile-capture-finalize-token`. Body: `sessionId`, `captureSizeBytes`, `debuggerSizeBytes`.

### `POST /support/capture/metadata`

Client-side SDK helper. Accepts `metadata` to attach to the next capture. This is the `jam.metadata()` pattern.

## Storage Choice

- **D1** for `support_capture_public_keys`, `support_capture_sessions`, `support_ticket_attachments`.
- **R2** for the actual screenshot, video, and debugger JSON blobs.
- Presigned R2 URLs for client upload and viewing.

## Testing Strategy

- Tests in `src/api/support-capture.test.ts`.
- Generate a public key, start a session, simulate an upload, finalize, and assert the `support_tickets` and `support_ticket_attachments` rows exist.
- Test origin rejection with an unauthorized origin.
- Test expired session cleanup.

## Migration Path

`support-capture` does not import from Jam or Crikket. It is a new native channel. The Jam/Crikket audits are used as the design reference.

## Boundaries

### Always

- Validate public key and origin before issuing a capture token.
- Run `vp check` and `pnpm test` before committing.
- Keep D1 schema changes in Drizzle migrations.

### Ask First

- Adding new `attachmentType` values.
- Changing the token/signature scheme.
- Moving artifact storage from R2 to another provider.

### Never

- Commit capture signing secrets.
- Store PII in logs or generated client docs.
- Use `any`.

## Success Criteria

- [ ] D1 tables `support_capture_public_keys`, `support_capture_sessions`, `support_ticket_attachments` exist.
- [ ] Client can initialize a capture from an allowed origin.
- [ ] `POST /support/capture/finalize` creates a `support_ticket` and `support_ticket_attachments`.
- [ ] Invalid origin or public key returns 401.
- [ ] OpenAPI/MCP/CLI artifacts are regenerated.
- [ ] `vp check` passes.
- [ ] `pnpm test` passes with new tests.

## Open Questions

1. Should the capture widget be a standalone `@vortex/capture` SDK, or is it a `vortexSupport.capture()` method in a future client SDK?
2. Do we support video and screenshot in v1, or just screenshot?
3. Should the debugger payload be stored as one large JSON, or split into `console_logs`, `network_requests`, and `user_events` files?
