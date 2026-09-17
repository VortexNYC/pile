# GitLab Integration — First Slice

## Goal

Mirror GitLab issues and issue notes into Pile, matching the existing GitHub integration pattern. This is the smallest useful slice before merge requests, labels, milestones, and assignees.

## Scope

### In scope

- GitLab project webhook ingestion:
  - `Issue Hook` events: `open`, `update`, `close`, `reopen`
  - `Note Hook` events on issues: create / update / delete issue notes
- HMAC/token verification using `X-Gitlab-Token` and a configurable `GITLAB_WEBHOOK_SECRET`.
- Issue mapping via `repoIssues` (add `source` enum defaulting to `github`; allow `gitlab`).
- Comment mapping with `externalSource: "gitlab"` and `externalId` = GitLab note id.
- Outbound writeback: when a Pile comment is added to a GitLab-mapped issue, post it as a GitLab issue note.
- API routes under `/workspaces/{organizationId}/gitlab/install` and `/gitlab/users` to store per-workspace access token and username mappings.
- New global tables `gitlab_installations` and `gitlab_users`, following `github_installations` / `github_users`.

### Out of scope (next slice)

- Merge request sync (open/update/merge/close/draft, `fixes KEY-123` linking, `prState` updates).
- MR notes / diff notes.
- Label / milestone / assignee sync.

## Data model

### `gitlab_installations`

| column         | type                                         |
| -------------- | -------------------------------------------- |
| id             | text primary key                             |
| organizationId | text not null                                |
| projectId      | text (GitLab project id)                     |
| projectPath    | text (e.g. `vortexnyc/pile`)                 |
| token          | text (encrypted at rest — not persisted raw) |
| webhookSecret  | text                                         |
| createdAt      | text                                         |
| updatedAt      | text                                         |

For the first slice the token is a GitLab personal/project access token provided by the workspace admin. We do not implement OAuth app flow.

### `gitlab_users`

| column         | type             |
| -------------- | ---------------- |
| id             | text primary key |
| organizationId | text not null    |
| userId         | text (Pile user) |
| gitlabUsername | text             |

### `repoIssues` extension

Add `source: text` default `'github'`. Existing GitHub rows stay `github`; GitLab rows use `gitlab`.

## Webhook contract

Inbound route: `POST /gitlab` (no authz middleware; verification is token-based).

Headers:

- `X-Gitlab-Event` — e.g. `Issue Hook`, `Note Hook`
- `X-Gitlab-Token` — matches `GITLAB_WEBHOOK_SECRET` or installation `webhookSecret`

Payloads are parsed with Zod. Duplicates are ignored by `object_attributes.id` / `object_attributes.note_id` + event type.

## Issue mapping

GitLab project path (`project.path_with_namespace`) + issue IID (`object_attributes.iid`) maps to one Pile issue.

- `open` → create issue if missing, otherwise update status to `backlog`/`triage`.
- `update` → update title/description.
- `close` → status `canceled` unless MR merged (out of scope).
- `reopen` → status `backlog`.

Issue identifiers follow existing `identifier` scheme (team key + number). If the workspace has no team mapping for the project, use default team.

## Comment mapping

Issue note `object_attributes.note_id` is `externalId`; `externalSource` is `"gitlab"`. Create/update/delete are handled via `Note Hook` `object_attributes.action`.

## Outbound writeback

When `src/api/comments.ts` creates a comment on an issue whose `repoIssues.source = 'gitlab'`, post the comment body to the GitLab issue notes endpoint using the stored token and record the returned note id as `externalId`.

## Env / config

- `GITLAB_WEBHOOK_SECRET` — default fallback for webhook verification.
- `GITLAB_API_URL` — optional, defaults to `https://gitlab.com/api/v4`.

## Files to add / modify

- `src/types/env.ts` — add `GITLAB_WEBHOOK_SECRET`, `GITLAB_API_URL`.
- `src/global/schema.ts` — add `gitlab_installations`, `gitlab_users`; add `source` to `repoIssues`.
- `src/global/db.ts` — no change unless new helpers.
- `src/global/gitlab-auth.ts` — token fetch/header builder.
- `src/global/gitlab-installations.ts` — CRUD.
- `src/global/gitlab-users.ts` — CRUD.
- `src/agents/gitlab.ts` — webhook verifier + event dispatcher.
- `src/api/gitlab.ts` — install / user routes.
- `src/api/index.ts` — register `POST /gitlab`.
- `src/api/comments.ts` — outbound GitLab note writeback.
- `src/workspace/durable-object.ts` — `findCommentByExternalId` already exists; ensure `externalSource` handling covers `gitlab`.

## Verification

- `pnpm run typecheck`
- `pnpm exec vp check`
- `pnpm test`
- `pnpm run knip`
- Manual webhook test with `ngrok`/`cloudflared` or a GitLab test project.

## Future slices

1. ✅ Merge request sync and `fixes KEY-123` / `closes KEY-123` parsing.
2. ✅ MR notes / diff notes.
3. ✅ Label, milestone, and assignee sync.

## Out of scope for this integration

- Pipeline / CI status sync.
- Branch/commit push hooks.
- GitLab OAuth app flow.
