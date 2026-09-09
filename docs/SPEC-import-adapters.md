# Import Adapters

## Objective

Make Vortex the easiest place to land engineering data from Linear, Jira, Notion, Confluence, or any other source. A single `POST /workspaces/{id}/import` endpoint accepts a `source` name and source-specific credentials, runs the import inside the workspace Durable Object, and returns a summary of what was imported.

This spec covers the framework plus the first two new adapters: **Jira** (issues) and **Confluence** (pages). Linear and Notion already exist as separate routes and will be folded into the framework in a later pass.

## Capability map

| Module              | Responsibility                                                                    | Depends on                                                         |
| ------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `import-core`       | Shared `ImportSource` contract, runner, and `POST /workspaces/{id}/import` route  | —                                                                  |
| `import-jira`       | Jira Cloud issue import: projects, statuses, users, issues, comments, attachments | `import-core`                                                      |
| `import-confluence` | Confluence Cloud page import: spaces, pages, ADF-to-markdown conversion           | `import-core`, `import-jira` (Atlassian credentials are identical) |
| `import-notion`     | Existing Notion page import, folded into framework later                          | `import-core`                                                      |
| `import-linear`     | Existing Linear migration, folded into framework later                            | `import-core`                                                      |

Build order: `import-core` → `import-jira` → `import-confluence` → `import-notion`/`import-linear`.

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
    runner.ts          # runImport(source, ctx, credentials, options)
    jira.ts            # JiraCloud adapter
    confluence.ts      # ConfluenceCloud adapter
  global/
    adf-to-markdown.ts # Atlassian Document Format → markdown converter
  api/
    import.ts          # POST /workspaces/{id}/import
```

## Code style

- Each adapter is a single object implementing `ImportSource`.
- Credentials and options are plain objects parsed by Zod in the route.
- External API responses are validated with Zod; failures throw `ImportError`.
- Sequential API calls where rate limits exist; no `Promise.all` over unbounded lists.
- User resolution: try email first, create a placeholder Vortex user if no email is available.

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
- Body: `{ source: "jira" | "confluence"; credentials: ...; options?: ... }` (discriminated union).
- `ImportContext` carries `env`, `organizationId`, `importerId`, `db`, `stub`.
- `ImportSource` interface: `validate(credentials)` and `run(ctx, credentials, options)`.
- `runImport` wraps validation, emits `import.started`/`import.completed` events, and returns `{ source, counts, errors }`.

### Jira adapter

Credentials:

- `host`: `https://{domain}.atlassian.net`
- `email`: Atlassian account email
- `token`: Atlassian API token
- `projectKey?`: import one project only
- `jql?`: custom JQL override

Behavior:

- Validate with `GET /rest/api/3/myself`.
- Fetch statuses and create Vortex `states` (todo, in_progress, done mapping).
- Fetch projects and create Vortex `projects`.
- Fetch users by email and create Vortex users as needed.
- Search issues with `POST /rest/api/3/search/jql`.
- Map each Jira issue to a Vortex issue:
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
  - Create/update Vortex document.
  - Resolve `parentDocumentId` on a second pass.
  - Map `authorId` / `ownerId` to Vortex users via account lookup.

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
- `POST /workspaces/{id}/import` with `source: "confluence"` imports pages as Vortex documents with markdown content.
- `pnpm run check` passes with no errors and `knip` reports no unused exports.
- Adapters are isolated; adding a new source requires only a new adapter file and a route schema branch.

## Open questions

1. Should existing `/migrate/linear` and `/notion/import` be deprecated in favor of `/import`? Phase 2.
2. Should we persist import jobs with status/pagination for large workspaces? Out of scope for first slice; imports are synchronous.
