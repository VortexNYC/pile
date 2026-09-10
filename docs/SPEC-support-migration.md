# Spec: support-migration

## Objective

Define the fifth module of the customer support layer: import and ongoing sync from external support providers.

`support-migration` does two things. It bulk-imports historical conversations, customers, companies, and labels from Intercom, Zendesk, and Plain. It also exposes the primitives that webhook handlers in `support-channels` use for real-time updates.

This module validates that the `support-contacts`, `support-tickets`, and `support-content` data models can represent the data from all three providers.

## Tech Stack

- TypeScript.
- Hono + `@hono/zod-openapi`.
- Drizzle ORM on D1.
- Zod for credential and payload validation.
- Native fetch + provider APIs (Intercom REST, Zendesk REST, Plain GraphQL).
- Native Web Crypto for HMAC webhook verification.

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
src/support-migration/
  intercom.ts                 # Intercom bulk + upsert primitives
  zendesk.ts                  # Zendesk bulk + upsert primitives
  plain.ts                    # Plain bulk + upsert primitives
  types.ts                    # shared adapter types
src/import/                   # existing generic import job framework
src/global/support-migration.ts # D1 helpers
src/api/support-migration.ts    # REST routes
src/mcp/...                   # generated
packages/client/src/types.ts  # generated
packages/cli/src/commands.ts  # generated
migrations/                   # Drizzle-generated D1 migrations
```

## Data Model

### Reused Tables

`support-migration` does not create new tables for import runs. It reuses the existing:

- `import_jobs` — tracks import runs.
- `import_mappings` — generic source-id → target-id mapping.
- `intercom_conversations` — already exists for Intercom conversation → ticket mapping.

If `import_jobs` or `import_mappings` are missing fields, they are extended in their own migrations, not duplicated.

### New Mapping Tables (v1)

Only `intercom_conversations` exists today. The following are added for Zendesk and Plain:

| Table             | Purpose                                              |
| ----------------- | ---------------------------------------------------- |
| `zendesk_tickets` | Zendesk `ticket.id` → `support_tickets.id` mapping   |
| `plain_threads`   | Plain `thread.id` → `support_tickets.id` mapping     |
| `plain_customers` | Plain `customer.id` → `support_customers.id` mapping |

These tables are shaped like `intercom_conversations`: `id`, `organization_id`, `external_id`, `issue_id` / `ticket_id`, `created_at`.

## Code Style

```ts
export const supportMigrationCredentialsSchema = z.discriminatedUnion(
  "source",
  [
    z.object({
      source: z.literal("intercom"),
      token: z.string(),
      clientSecret: z.string().optional(),
    }),
    z.object({
      source: z.literal("zendesk"),
      subdomain: z.string(),
      token: z.string(),
    }),
    z.object({
      source: z.literal("plain"),
      apiKey: z.string(),
    }),
  ]
);

export type SupportMigrationCredentials = z.infer<
  typeof supportMigrationCredentialsSchema
>;
```

- No `any`. Union types are modeled with `z.discriminatedUnion`.
- Provider-specific credential fields are explicit.

## Adapter Interface

Each source implements the existing `ImportSource<TCredentials, TOptions>` interface from `src/import/types.ts`:

```ts
interface ImportSource<TCredentials, TOptions = unknown> {
  name: string;
  validate(credentials: TCredentials): ImportValidationResult;
  run(
    ctx: ImportContext,
    credentials: TCredentials,
    options: TOptions,
    state?: ImportRunState
  ): Promise<ImportBatchResult>;
}
```

The `ctx` includes `ctx.db`, `ctx.organizationId`, `ctx.stub` (workspace DO), `ctx.importerId`. For `support-migration` the adapter uses `ctx.db` only and writes `support_*` tables; it does not call the workspace Durable Object.

## API Surface

### `POST /workspaces/{organizationId}/support/imports`

Start an import. Body:

```json
{
  "source": "intercom",
  "credentials": { "token": "..." },
  "options": { "teamId": "...", "state": "all", "limit": 1000 }
}
```

Returns an `import_id`.

### `GET /workspaces/{organizationId}/support/imports/{importId}`

Get import status and counts.

### `POST /workspaces/{organizationId}/support/imports/{importId}/resume`

Resume a paused import from its cursor.

### `POST /workspaces/{organizationId}/support/imports/{importId}/cancel`

Cancel a running import.

### `POST /workspaces/{organizationId}/support/imports/{importId}/validate`

Validate credentials without running a full import.

## Provider Mappings

### Intercom

- API: `https://api.intercom.io`.
- Version: `Intercom-Version: 2.16`.
- Auth: Bearer token.
- Endpoints:
  - `GET /conversations` → `support_tickets`
  - `GET /contacts` → `support_customers`
  - `GET /companies` → `support_companies`
- State mapping: `open` → `todo`, `closed` → `done`, `snoozed` → `snoozed`.
- Webhook: `POST /support/webhooks/intercom/{organizationId}` (handler lives in `support-channels`; calls `upsertIntercomTicket`).

### Zendesk

- API: `https://{subdomain}.zendesk.com/api/v2`.
- Auth: Bearer token.
- Endpoints:
  - `GET /api/v2/tickets` → `support_tickets`
  - `GET /api/v2/users` → `support_customers`
  - `GET /api/v2/organizations` → `support_companies`
- State mapping: `new`/`open` → `todo`, `pending` → `todo`, `solved`/`closed` → `done`.
- Webhook: `POST /support/webhooks/zendesk/{organizationId}`.

### Plain

- API: `https://core-api.uk.plain.com/graphql/v1`.
- Auth: Bearer API key.
- Operations:
  - `threads` query → `support_tickets`
  - `customers` query → `support_customers`
  - `tiers` query → `support_tiers`
  - `labels` query → `labels` with `kind = "support"`
- State mapping: `todo` → `todo`, `done` → `done`.
- Webhook: `POST /support/webhooks/plain/{organizationId}`; signed with `plain-request-signature`.

## Storage Choice

`support-migration` stores import state in **D1** (`import_jobs`, mapping tables). It writes support data into the same D1 `support_*` tables. No Durable Object state is needed for migration.

## Testing Strategy

- Tests in `src/api/support-migration.test.ts`.
- Mock Intercom/Zendesk/Plain HTTP responses using `msw` or the existing test harness.
- Assert that imports create the right `support_customers`, `support_companies`, `support_tickets`, `support_ticket_events` rows.
- Assert that re-running an import with the same `external_id` is idempotent (updates, not duplicates).

## Migration Path

The existing `src/import/intercom.ts` is the workspace-issue adapter. `support-migration/intercom.ts` is a new adapter that targets `support_*` tables. The two can coexist: the existing one is for `ISS-3` (engineering issue tracker use), the new one is for `ISS-9` (support). If they must merge later, they share the same credential validation and list logic.

```ts
import { supportIntercomImportSource } from "../support-migration/intercom.js";
```

## Boundaries

### Always

- Validate credentials before any network call.
- Run `vp check` and `pnpm test` before committing.
- Use `z.discriminatedUnion` for provider credentials.
- Keep D1 schema changes in Drizzle migrations.

### Ask First

- Adding a new provider to `support-migration`.
- Removing the existing `src/import/intercom.ts` workspace-issue adapter.
- Moving import state to the workspace Durable Object.

### Never

- Commit provider tokens or secrets.
- Store PII in logs or generated client docs.
- Use `any`.

## Success Criteria

- [ ] `support-migration/intercom.ts` adapter creates `support_customers`, `support_companies`, `support_tickets`, `support_ticket_events`.
- [ ] `support-migration/zendesk.ts` and `support-migration/plain.ts` stubs exist with credential schemas.
- [ ] `POST /workspaces/{id}/support/imports` starts a job and returns an `import_id`.
- [ ] Re-imports are idempotent.
- [ ] OpenAPI/MCP/CLI artifacts are regenerated.
- [ ] `vp check` passes.
- [ ] `pnpm test` passes with new tests.

## Open Questions

1. Should the existing `src/import/intercom.ts` workspace-issue adapter be kept, renamed, or deleted once `support-migration/intercom.ts` exists?
2. Do we import Plain's `customers` and `tenants` first, or import `threads` first and create missing customers on the fly?
3. Should `support-migration` own the webhook handlers, or should `support-channels` own the HTTP routes and call `support-migration` upsert primitives?
