# Spec: support-contacts

## Objective

Define the first module of the customer support layer: the contact model. This module is the foundation for `support-tickets`, `support-migration`, and `support-inbox`.

`support-contacts` stores the people and organizations that can open support tickets. It must be simple enough to import from Intercom and Zendesk, and rich enough to eventually replace Plain.com's customer and tenant model.

## Tech Stack

- TypeScript.
- Hono + `@hono/zod-openapi`.
- Drizzle ORM on D1 (global metadata).
- Zod for input and webhook payload validation.
- Native provider primitives only (no custom ORM/validation wrappers).

## Commands

```bash
# Format/lint
pnpm exec vp check --fix

# Tests
pnpm test

# Generate D1 migration after schema changes
pnpm run db:generate

# Apply D1 migration to production
CLOUDFLARE_API_TOKEN=... pnpm exec wrangler d1 migrations apply issuetracker-global -e production --remote

# Deploy
CLOUDFLARE_API_TOKEN=... pnpm exec wrangler deploy -e production
```

## Project Structure

```
src/global/support-contacts.ts   # D1 helpers
src/global/schema.ts             # support_customers, support_companies tables
src/api/support-contacts.ts      # REST routes
src/mcp/...                      # generated
packages/client/src/types.ts     # generated
packages/cli/src/commands.ts     # generated
migrations/                      # Drizzle-generated D1 migrations
```

## Data Model

### `support_customers`

| Column            | Type                   | Notes                                    |
| ----------------- | ---------------------- | ---------------------------------------- |
| `id`              | text PK                | Vortex UUID                              |
| `organization_id` | text FK → organization | workspace                                |
| `user_id`         | text FK → user         | optional; internal user submitting a bug |
| `external_id`     | text                   | optional Intercom/Zendesk/Plain id       |
| `external_source` | text                   | `intercom`, `zendesk`, `plain`, `manual` |
| `email`           | text                   | unique per workspace                     |
| `full_name`       | text                   | nullable                                 |
| `phone`           | text                   | nullable                                 |
| `created_at`      | text                   | ISO timestamp                            |
| `updated_at`      | text                   | ISO timestamp                            |

Unique: `(organization_id, email)`.
Index: `(organization_id, external_id, external_source)`.

`user_id` is optional. Support customers are separate from workspace users, but an internal user can be attached to a customer for cases like bug submissions or org-internal support.

### `support_companies`

| Column            | Type                   | Notes                             |
| ----------------- | ---------------------- | --------------------------------- |
| `id`              | text PK                | Vortex UUID                       |
| `organization_id` | text FK → organization | workspace                         |
| `external_id`     | text                   | optional external id              |
| `external_source` | text                   | source system                     |
| `name`            | text                   | not null                          |
| `domain`          | text                   | nullable; used for email matching |
| `created_at`      | text                   | ISO timestamp                     |
| `updated_at`      | text                   | ISO timestamp                     |

Unique: `(organization_id, name)`.
Index: `(organization_id, domain)`.

`domain` is used for auto-resolution: an incoming email like `jane@acme.com` attaches to the company with `domain = acme.com` if one exists in the workspace.

### `support_customer_identities`

| Column        | Type                        | Notes                             |
| ------------- | --------------------------- | --------------------------------- |
| `id`          | text PK                     | Vortex UUID                       |
| `customer_id` | text FK → support_customers | not null                          |
| `type`        | text                        | `email`, `phone`, `slack`, `chat` |
| `value`       | text                        | not null                          |
| `is_primary`  | boolean                     | default false                     |
| `created_at`  | text                        | ISO timestamp                     |

Unique: `(customer_id, type, value)`.

This table lets a customer have multiple identities (work email, personal email, phone, Slack DM id) without overloading the `support_customers` table.

### `support_customer_companies`

| Column        | Type                        | Notes                          |
| ------------- | --------------------------- | ------------------------------ |
| `id`          | text PK                     | Vortex UUID                    |
| `customer_id` | text FK → support_customers | not null                       |
| `company_id`  | text FK → support_companies | not null                       |
| `is_primary`  | boolean                     | default false; primary company |
| `created_at`  | text                        | ISO timestamp                  |

Unique: `(customer_id, company_id)`.
Index: `(company_id)`.

A customer can belong to multiple companies (Plain-style tenants). v1 always writes one row per customer, but the schema supports many from the start.

## Code Style

```ts
export const supportCustomerSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string().optional(),
  externalId: z.string().optional(),
  externalSource: z
    .enum(["intercom", "zendesk", "plain", "manual"])
    .default("manual"),
  email: z.string().email(),
  fullName: z.string().optional(),
  phone: z.string().optional(),
  companies: z
    .array(
      z.object({
        companyId: z.string(),
        isPrimary: z.boolean().default(false),
      })
    )
    .default([]),
  identities: z
    .array(
      z.object({
        type: z.enum(["email", "phone", "slack", "chat"]),
        value: z.string(),
        isPrimary: z.boolean().default(false),
      })
    )
    .default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SupportCustomer = z.infer<typeof supportCustomerSchema>;
```

- snake_case in SQL, camelCase in TypeScript.
- Native Drizzle columns; no `any`.
- `external_source` is a string enum, not a custom type.

## API Surface

### `POST /workspaces/{organizationId}/support/customers`

Create a customer. Body is `SupportCustomerInput` (without `id`, `createdAt`, `updatedAt`, `companies`, `identities` — those are populated by separate endpoints or nested upserts).

### `GET /workspaces/{organizationId}/support/customers`

Paginated list. Query params: `limit`, `cursor`, `companyId`, `q` (search email/name).

### `GET /workspaces/{organizationId}/support/customers/{customerId}`

Get one customer with companies and identities.

### `PATCH /workspaces/{organizationId}/support/customers/{customerId}`

Update fields. To change companies or identities, use the nested endpoints.

### `PUT /workspaces/{organizationId}/support/customers/{customerId}/companies`

Set the customer's company memberships (replaces existing rows).

### `PUT /workspaces/{organizationId}/support/customers/{customerId}/identities`

Set the customer's identities (replaces existing rows).

### `POST /workspaces/{organizationId}/support/companies`

Create a company.

### `GET /workspaces/{organizationId}/support/companies`

Paginated list. Query params: `limit`, `cursor`, `q`.

### `GET /workspaces/{organizationId}/support/companies/{companyId}`

Get one company with customer list.

## Storage Choice

`support-contacts` lives in **D1** (global metadata), not in the workspace Durable Object. Contacts are cross-workspace entities used by migration, webhooks, and the inbox. D1 is the right place for indexed lookups by `email`, `external_id`, and `domain`.

## Testing Strategy

- Unit tests in `src/api/support-contacts.test.ts` using the existing `@cloudflare/vitest-pool-workers` setup.
- Each test creates a workspace, creates/updates customers and companies, asserts responses.
- Test data is isolated per test via random organization ids.
- Contract tests: `pnpm run contract:check` after route changes.

## Migration Path

`support-migration` (later module) will use the same D1 tables. It inserts or updates rows from Intercom/Zendesk/Plain using `external_id` + `external_source` as the stable key. `support-contacts` must expose an upsert helper:

```ts
upsertCustomerByExternal(db, organizationId, {
  externalId,
  externalSource,
  email,
  fullName,
  phone,
  companyId,
  identities,
});
```

The helper creates or updates `support_customers`, then syncs `support_customer_companies` and `support_customer_identities` using the primary company and identity list.

## Boundaries

### Always

- Validate inputs with Zod.
- Run `vp check` and `pnpm test` before committing.
- Keep D1 schema changes in Drizzle migrations.

### Ask First

- Renaming `support_customers` or `support_companies`.
- Adding user authentication to customer identity resolution.
- Changing storage from D1 to Durable Object.

### Never

- Store PII in logs or generated client docs.
- Commit secrets.
- Use `any`.

## Success Criteria

- [ ] D1 tables `support_customers`, `support_companies`, `support_customer_identities`, `support_customer_companies` exist.
- [ ] REST routes for create/list/get/update customers and companies return correct JSON.
- [ ] OpenAPI/MCP/CLI artifacts are regenerated.
- [ ] `vp check` passes.
- [ ] `pnpm test` passes with new tests.
- [ ] `support-migration` can upsert contacts by `external_id` + `external_source`.

## Decisions

1. **Vortex `user` vs support customer** — keep them separate. `support_customers` has an optional `user_id` for internal bug submissions, but the support contact is a separate entity.
2. **Leads** — no `support_leads` table for v1. `support_customers` covers all contacts; sales leads will be a future concern.
3. **Company auto-resolution** — yes. Match incoming email domain to `support_companies.domain` when a company with that domain exists.
4. **Tenants** — use a join table `support_customer_companies` so one customer can belong to multiple companies. v1 creates one row per customer, but the schema supports many.
5. **URL namespace** — use `/support/customers` and `/support/companies` to avoid collision with existing `/users` and `/teams` and to keep the support surface namespaced.
