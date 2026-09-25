# Disaster recovery runbook

Pile state lives in four places:

| Store | What's in it | Backup |
|---|---|---|
| `pile-global` (D1) | Orgs, members, auth, tickets, votes, changelog, channels | `wrangler d1 export` (schema + data) |
| `WorkspaceDO` (DO SQLite) | Issues, comments, history, attachments refs, notifications | `GET /workspaces/{org}/export` |
| `pile-attachments` (R2) | Upload/capture blobs | object manifest; objects are content-addressed |
| Config/secrets | `wrangler.toml` (committed) + `wrangler secret` values | secrets live in Veil/1Password, not the dump |

## Cadence

`./scripts/backup.sh` — writes `backups/<ts>/` with `d1-schema.sql`, `d1-data.sql`, `workspace-<org>.json`, `r2-manifest.json`. Run before any migration batch and weekly at minimum. RPO target: 24h (manual until scheduled). RTO target: 4h.

## Restore drill (verified 2026-09-25)

```bash
./scripts/dr-restore.sh pile-dr-restore-test backups/<ts>
```

Creates a fresh D1, applies the schema, then restores data per-table with FK fixpoint retries and verifies row counts against the dump. Verified end-to-end: 39/39 tables, exact row counts.

**Why per-table?** `wrangler d1 execute --remote --file` batches statements concurrently, so a monolithic dump fails on FK ordering (`no such table` / `FOREIGN KEY constraint failed`). A single-transaction workaround is impossible — D1 rejects `BEGIN TRANSACTION` remotely. Local verification of a dump is still one step: `sqlite3 restored.db < d1-*.sql && PRAGMA foreign_key_check`.

## Recovery steps

1. **D1** — `dr-restore.sh` into a new database; point `[[d1_databases]].database_id` in `wrangler.toml` at it; deploy.
2. **DO workspaces** — each workspace DO rehydrates from `workspace-<org>.json` via the import path used for workspace migration (`exportState`/`importState` RPC on `WorkspaceDO`).
3. **R2** — objects are content-addressed; re-upload from local copies or re-capture. Missing objects surface as broken attachment links, not data corruption.
4. **Secrets** — re-set `wrangler secret` values (`BETTER_AUTH_SECRET`, etc.) from Veil.
5. **DNS/domain** — `pile.nyc` and `docs.pile.nyc` workers custom domains reattach via zone API.
6. **Queue** — webhook queue is at-least-once with delivery dedupe; replay is idempotent, no action needed.

## Validation after restore

- `GET /health` green.
- `GET /workspaces/org_vortex_main/issues?limit=5` returns issues.
- Spot-check a support ticket thread and the public board.

## Roles

Incident lead restores; second reviewer confirms row counts and closes the drill ticket in Pile (`ISS` team).
