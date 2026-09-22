# Import Adapters

## Objective

Make Pile the easiest place to land engineering data from Linear, Jira, Notion, Confluence, GitHub, or any other source. A single `POST /workspaces/{id}/import` endpoint accepts a `source` name and source-specific credentials, runs the import inside the workspace Durable Object, and returns a summary of what was imported along with a persistent `jobId`.

This spec covers the shared framework plus all adapters folded into it: Jira, Confluence, Linear, Notion, and GitHub Issues.

## Import idempotency (`externalRef`)

Issues may include an optional `externalRef`, which is unique within a workspace. A
`POST /workspaces/{id}/issues` request with an existing `externalRef` returns the
existing issue with status `200` instead of creating a duplicate. The same key can
be queried with `GET /workspaces/{id}/issues?externalRef=...`; clients may also
supply `id` for idempotent creates. The Linear adapter uses the convention
`linear:<IDENTIFIER>` (for example, `linear:VOR-188`).

## Capability map

| Module                 | Responsibility                                                                                              | Depends on                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `import-core`          | Shared `ImportSource` contract, runner, `POST /workspaces/{id}/import` route, and `import_jobs` persistence | —                                                                  |
| `import-jira`          | Jira Cloud issue import: projects, statuses, users, issues, comments, attachments                           | `import-core`                                                      |
| `import-confluence`    | Confluence Cloud page import: spaces, pages, ADF-to-markdown conversion                                     | `import-core`, `import-jira` (Atlassian credentials are identical) |
| `import-notion`        | Notion page and database import into documents and issues                                                   | `import-core`                                                      |
| `import-linear`        | Linear issue migration                                                                                      | `import-core`                                                      |
| `import-github-issues` | GitHub repository issue import into Pile issues                                                             | `import-core`                                                      |

Build order: `import-core` → adapters (Jira, Confluence, Linear, Notion, GitHub Issues).

## Tech stack

- Hono + `@hono/zod-openapi` for the `POST /workspaces/{id}/import` route.
- Native `fetch` for external API calls.
- Zod for response validation.
- D1 for user / state / label / cycle / project lookups and source-specific mapping tables.
- Durable Object SQLite for workspace-local issues, documents, comments, and attachments.
- No `any`; use `unknown` and narrow with Zod.
- No `eslint-disable` or `@ts-ignore`.

## Commands

```bash
pnpm run typecheck
pnpm run check        # format, lint, contract generation, tests
pnpm run knip
pnpm run scan:secrets
```

## Project structure

```
src/
  import/
    types.ts           # ImportSource contract, ImportContext, summary types
    runner.ts          # runImport(source, ctx, credentials, options) → { counts, job }
    jira.ts            # JiraCloud adapter
    confluence.ts      # ConfluenceCloud adapter
    linear.ts          # Linear adapter
    notion.ts          # Notion page/database adapter
    github-issues.ts   # GitHub Issues adapter
  global/
    import-jobs.ts     # D1 helpers for import_jobs table
    adf-to-markdown.ts # Atlassian Document Format → markdown converter
  api/
    import.ts          # POST /workspaces/{id}/import + GET /workspaces/{id}/import/{jobId}
```

## Code style

- Each adapter is a single object implementing `ImportSource`.
- Credentials and options are plain objects parsed by Zod in the route.
- External API responses are validated with Zod; failures throw `ImportError`.
- Sequential API calls where rate limits exist; no `Promise.all` over unbounded lists.
- User resolution: try email first, create a placeholder Pile user if no email is available.

## Testing strategy

- Integration tests in `src/api/index.test.ts` mock `globalThis.fetch` for the external API.
- Each adapter gets one happy-path test and one error-handling test.
- `pnpm run check` must pass before commit.

## Boundaries

- **Always:** validate external API responses, run `pnpm run check`, keep adapters stateless, reuse existing `getWorkspaceStub` and DO methods.
- **Ask first:** adding new top-level API routes beyond `/import`, adding third-party SDKs, changing D1 schema.
- **Never:** commit credentials, use `any`, suppress lint rules, make imports irreversible.

## In scope

### Core

- `POST /workspaces/{id}/import` with `rls("admin")`.
- Body: `{ source: "jira" | "confluence" | "linear" | "notion" | "github-issues"; credentials: ...; options?: ... }` (discriminated union).
- `ImportContext` carries `env`, `organizationId`, `importerId`, `db`, `stub`.
- `ImportSource` interface: `validate(credentials)` and `run(ctx, credentials, options)`.
- `runImport` creates an `import_jobs` row, runs validation, updates the job to `running`, executes the adapter, then marks it `completed` or `failed` with `counts` and `error`. It returns `{ counts, job }`.
- `GET /workspaces/{id}/import/{jobId}` returns the current status and counts for an import job.

### Jira adapter

Credentials:

- `host`: `https://{domain}.atlassian.net`
- `email`: Atlassian account email
- `token`: Atlassian API token
- `projectKey?`: import one project only
- `jql?`: custom JQL override

Behavior:

- Validate with `GET /rest/api/3/myself`.
- Fetch statuses and create Pile `states` (todo, in_progress, done mapping).
- Fetch projects and create Pile `projects`.
- Fetch users by email and create Pile users as needed.
- Search issues with `POST /rest/api/3/search/jql`.
- Map each Jira issue to a Pile issue:
  - `identifier` uses project key + issue number (`KEY-123`).
  - `title` from `fields.summary`.
  - `description` from `fields.description` converted from ADF to markdown.
  - `status` mapped from Jira status name.
  - `assigneeId` resolved from `fields.assignee.emailAddress`.
  - `labelIds` from `fields.labels` plus issue type as a label.
  - `parent` and `subtasks` for hierarchy.
- Import comments (ADF → markdown) and attachments.

### Confluence adapter

Credentials:

- `host`: same as Jira
- `email`, `token`: same as Jira
- `spaceKey?`: limit to one space
- `rootPageId?`: import a single page subtree

Behavior:

- Validate with `GET /wiki/rest/api/space`.
- List pages with `GET /wiki/api/v2/pages?body-format=atlas_doc_format`.
- For each page:
  - Convert `body.atlas_doc_format` from ADF JSON to markdown.
  - Create/update Pile document.
  - Resolve `parentDocumentId` on a second pass.
  - Map `authorId` / `ownerId` to Pile users via account lookup.

### ADF-to-markdown

- Handle: `doc`, `paragraph`, `text` (with marks), `heading`, `bulletList`, `orderedList`, `listItem`, `codeBlock`, `hardBreak`, `rule`, `blockquote`, `panel`, `taskList`, `taskItem`, `table` (basic), `emoji`, `mention`, `media` (placeholder), `inlineCard`/`blockCard` (placeholder link).
- Unsupported nodes fall back to processing children or are skipped with a placeholder comment.

## Out of scope

- Real-time sync / webhooks for Jira or Confluence.
- Bidirectional writeback.
- Folding existing Linear and Notion routes into `/import` (Phase 2).
- OAuth-based Atlassian auth; first slice uses API tokens only.
- Full ADF fidelity (tables without alignment, complex panels as blockquotes).

## Success criteria

- `POST /workspaces/{id}/import` with `source: "jira"` imports issues, comments, and attachments from a Jira Cloud project.
- `POST /workspaces/{id}/import` with `source: "confluence"` imports pages as Pile documents with markdown content.
- `pnpm run check` passes with no errors and `knip` reports no unused exports.
- Adapters are isolated; adding a new source requires only a new adapter file and a route schema branch.

## Notes

- Existing `/migrate/linear` and `/notion/import` have been folded into `/import`; the old routes are removed.
- Import jobs are persisted in D1 with `pending | pending_approval | running | completed | failed | paused` status and a `GET` endpoint for status polling.
- `POST /import/{jobId}/resume` accepts fresh credentials and an optional `limit` and continues from the stored `cursor`.
- `POST /import` with `options.approvalRequired: true` creates a `pending_approval` job and an `import_approvals` row; `/approve` and `/reject` endpoints gate execution.
- `ImportSource.run` now returns `{ counts, nextCursor? }` so the runner can accumulate counts and pause/resume per adapter. GitHub Issues is the first adapter with full cursor support; the rest return `nextCursor: null` for now.

## Consolidating a Linear import

`scripts/consolidate-linear-import.ts` plans a safe, sequential consolidation of
duplicate Linear imports. It is a dry run by default and requires
`PILE_API_KEY`; set `PILE_BASE_URL` when using a non-default deployment.

```bash
PILE_API_KEY=... pnpm exec tsx scripts/consolidate-linear-import.ts \
  --workspace org_vortex_main
PILE_API_KEY=... pnpm exec tsx scripts/consolidate-linear-import.ts \
  --workspace org_vortex_main --apply
PILE_API_KEY=... pnpm exec tsx scripts/consolidate-linear-import.ts \
  --workspace org_vortex_main --apply --delete-duplicates
```
