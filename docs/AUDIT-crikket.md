# Crikket (local) Audit

Source: `/Users/shlomokabareti/Projects/crikket` (README, SDK README, server routes, bug-reports package, docs).

## 1. What Crikket Is

Open-source, self-hostable bug reporting. Modern alternative to Jam.dev and Marker.io. Built with Bun + Turborepo.

- **Capture:** screenshot or screen recording from browser.
- **Context:** console logs, network requests, device info, steps, reproduction metadata.
- **Share:** public or private links.
- **Embed:** `@crikket-io/capture` SDK with public key + allowed origins.

## 2. Monorepo Layout

| Path                   | Purpose                               |
| ---------------------- | ------------------------------------- |
| `apps/web`             | Next.js dashboard                     |
| `apps/server`          | Hono API (auth, capture, bug reports) |
| `apps/docs`            | Marketing + docs                      |
| `apps/extension`       | Browser extension                     |
| `sdks/capture`         | Embeddable browser capture SDK        |
| `packages/bug-reports` | Domain logic for bug reports          |

## 3. Capture Flow

1. **Client:** `init({ key, host })` mounts a floating launcher.
2. **Token:** `POST /api/embed/capture-token` returns a short-lived token.
3. **Upload session:** `POST /api/embed/bug-report-upload-session` creates a pending upload with metadata.
4. **Upload:** client uploads video/screenshot and debugger payload to object storage.
5. **Finalize:** `POST /api/embed/bug-report-finalize` completes the report, returns `shareUrl`, `id`.

## 4. Bug Report Object

`packages/bug-reports/src/lib/upload-session.ts`:

- `title` (optional, 200 chars)
- `description` (optional, 3000 chars)
- `priority` (enum, default `none`)
- `tags` (up to 20 strings)
- `url`
- `attachmentType`: `video` | `screenshot`
- `visibility`: `public` | `private`
- `metadata`: duration, page title, SDK version, submitted via, thumbnail URL
- `deviceInfo`: browser, OS, viewport
- `captureContentType`
- `hasDebuggerPayload`
- `debuggerSummary`: counts of actions, logs, network requests

Key insight: the actual debugger payload is uploaded as a separate artifact; the bug report record only keeps a summary. The media and debugger data are object-storage artifacts.

## 5. Domain Tables (inferred from Drizzle schema)

- `bugReport` — the report record.
- `bugReportUploadSession` — pending upload state, TTL 24h.
- Artifacts stored in S3/R2-compatible object storage with presigned URLs.

## 6. Auth / Security

- `better-auth` for workspace auth.
- `public keys` for SDK embeds. Allowed origins restrict where the widget can run.
- `x-crikket-public-key`, `x-crikket-capture-token`, `x-crikket-capture-finalize-token` headers.
- Rate limiting on capture and RPC endpoints.
- CORS explicitly configured for `api/embed/*` routes.

## 7. Notable Primitives

- **Public key per surface:** one key per website/app.
- **Upload session + finalize pattern:** separates reservation from actual upload, avoiding large payloads in the main request.
- **Debugger artifact key:** `buildDebuggerArtifactKey`, `buildCaptureArtifactKey`.
- **Ingestion jobs:** async processing after finalize.
- **Orphan cleanup:** periodic cleanup of stale pending uploads and artifacts.
- **Entitlements:** checks usage limits before creating a report.

## 8. What to Borrow for Vortex

- **Capture channel as a first-class support channel.** A bug report is just a support ticket with `source_channel = capture`.
- **Public key + origin allowlist for embeds.** Reuse for the in-app chat / capture widget.
- **Upload session pattern for large attachments (screenshot/video/debugger).** R2 for artifacts, D1 for ticket metadata.
- **Debugger payload as an attachment.** The `support_ticket_events` table can point to `attachments` for console logs / network JSON.
- **Bug report → issue tracker promotion.** Crikket has share links; Vortex can promote a capture to a `support_ticket` and then to a Vortex `issue` via `issue_id`.
- **Visibility (public/private) on captures.** Useful for customer share links vs internal reports.

## 9. Gaps to Decide

- Crikket is a dedicated bug-reporting product, not a full support inbox. Its "team" model is simpler. Vortex should not copy the entire Crikket dashboard; just the capture + report primitives.
- Crikket uses Bun. Vortex uses pnpm/Cloudflare Workers. Do not copy the monorepo shape; only the data model and API flow.
