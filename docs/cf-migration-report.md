# cf migration report — wrangler.toml → cloudflare.config.ts

Analysis for PILE-243. Produced by running `cf migrate` (cf 1.0.0-beta.7) against
`wrangler.toml` in a scratch copy of the repo — no repository files were
modified. `cf migrate --dry-run` reports "Would update 4 file(s):
cloudflare.config.ts, wrangler.config.ts, package.json, pnpm-lock.yaml" and
leaves `wrangler.toml` in place.

## Verdict

The generated skeleton is structurally correct but **incomplete by design**: it
emits a literal `throw new Error("Migration incomplete…")` at the top of
`cloudflare.config.ts` until every `TODO(@cloudflare)` comment is resolved. The
five flagged areas are covered below. Do not merge a config change until each
risk row is verified.

## Files the migration touches

| File                   | Change                                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare.config.ts` | New. `defineConfig((ctx) => switch (ctx.mode))` returning `{ worker: {...} }` per mode.                                                                                                |
| `wrangler.config.ts`   | New. `defineWranglerConfig` with `types.generate: false` in both modes (wrangler ≥4.100 experimental config; wrangler 4.129 in this repo supports it via `--experimental-new-config`). |
| `package.json`         | `cf` added as a dev dependency (skipped here via `--no-install`).                                                                                                                      |
| `pnpm-lock.yaml`       | Lockfile update for the `cf` dep.                                                                                                                                                      |
| `wrangler.toml`        | **Left in place.** Plain `wrangler` commands keep reading it.                                                                                                                          |

Bundler note: `@cloudflare/vite-plugin` is not declared, so cf selected the
**wrangler bundler** and `cf dev` / `cf deploy` delegate builds back to
wrangler. This matches the issue's interim posture (cf for ops, wrangler for
deploys).

## 1. Durable Object bindings (5 bindings × 2 modes)

Wrangler semantic (per env):

```toml
[[durable_objects.bindings]]
name = "WORKSPACE_DURABLE_OBJECT"
class_name = "WorkspaceDO"
```

(no `script_name` → self-referencing binding)

Generated cf equivalent:

```ts
WORKSPACE_DURABLE_OBJECT: bindings.durableObject({
  worker: "pile",            // "pile-dev" in the default branch
  exportName: "WorkspaceDO",
}),
```

| wrangler field        | cf field               | Risk                                                                                                                                                                                                                                                                                                     |
| --------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` (binding)      | object key under `env` | Faithful — binding name preserved.                                                                                                                                                                                                                                                                       |
| `class_name`          | `exportName`           | Faithful, but **stringly-typed**: when `worker` is a string, `exportName` is just `string` — no check that the class is actually in the worker's `exports` map. A typo deploys and fails only at runtime. Passing a `WorkerDefinition` instead of a name enables `InferDurableNamespaces` type-checking. |
| omitted `script_name` | `worker: "<own-name>"` | Self-reference by name must match the branch's `worker.name` (`pile` vs `pile-dev`). Generated correctly in both branches; keep them in sync if names become variables.                                                                                                                                  |

## 2. DO migrations — `[[migrations]] new_sqlite_classes` → `worker.exports` (HIGH RISK)

Wrangler semantic: three ordered migration tags provisioned SQLite-backed DO
namespaces:

- `v1`: `new_sqlite_classes = ["WorkspaceDO"]`
- `v2`: `new_sqlite_classes = ["Sandbox"]`
- `v3`: `new_sqlite_classes = ["CursorSandbox", "DevinSandbox", "CodexSandbox"]`

`cf migrate` does **not** translate these. The cf model replaces the migration
chain with a declarative `exports` lifecycle map on the worker:

```ts
exports: {
  WorkspaceDO:   exports.durableObject({ storage: "sqlite" }),
  Sandbox:       exports.durableObject({ storage: "sqlite", container: sandbox }),
  CursorSandbox: exports.durableObject({ storage: "sqlite", container: cursorSandbox }),
  DevinSandbox:  exports.durableObject({ storage: "sqlite", container: devinSandbox }),
  CodexSandbox:  exports.durableObject({ storage: "sqlite", container: codexSandbox }),
},
```

Risks:

- **`storage` must be `"sqlite"`** for all five classes — that's what
  `new_sqlite_classes` meant (the AGENTS.md `new_sqlite_classes` vs
  `new_classes` gotcha carries over verbatim). `"legacy-kv"` would provision
  KV-backed namespaces: new DOs would have the wrong storage engine and
  `WorkspaceDO`'s per-workspace issue state would be unreachable.
- **Omission is dangerous.** The `exports` map is the declared end state of the
  worker's DO namespaces — the same map supports `state: "deleted"`,
  `"renamed"`, `"transferred"`, `"expecting-transfer"` tombstones. A missing
  live class is ambiguous at best and risks namespace detach/deletion
  semantics at worst. All five classes must be listed, in both mode branches.
- Ordering (`v1` → `v2` → `v3`) is history-only: all three tags are already
  applied to `pile` in production, and a fresh `pile-dev` deploy reaches the
  same end state with all five declared at once. No ordering risk.
- Export names verified against the entrypoint: `src/index.ts` exports
  `WorkspaceDO`, `Sandbox`, `CursorSandbox`, `DevinSandbox`, `CodexSandbox`.
- The `exports` field must appear inside each mode's `worker` object — the
  generated file has no `exports` key at all yet.
- Future lifecycle ops (delete/rename/transfer a class) move from wrangler
  migration tags to `exports.durableObject({ state: ... })` entries.

## 3. Containers — `[[containers]]` → `defineContainer` + `exports.durableObject({ container })` (HIGH RISK)

Wrangler semantic: four `[[containers]]` blocks per env, each linking a
container app to a DO class via `class_name` (`Sandbox`, `CursorSandbox`,
`DevinSandbox`, `CodexSandbox`), with `image`, `max_instances = 20`,
`instance_type = "standard-1"`. Dev images are Dockerfiles; production images
are pinned registry digests (`registry.cloudflare.com/…/pile-<app>-production@sha256:…`).

`cf migrate` does not migrate containers at all. The cf model (per
`@cloudflare/config` types):

```ts
const sandbox = defineContainer({
  name: "pile-sandbox-production", // see naming risk below
  image: { reference: "registry.cloudflare.com/…@sha256:…" }, // or { dockerfile: "./Dockerfile.sandbox" }
  maxInstances: 20,
  instanceType: "standard-1",
});
export default defineConfig((ctx) => ({
  worker: {
    /* … exports.durableObject({ storage: "sqlite", container: sandbox }) */
  },
  containers: [sandbox /* … */],
}));
```

Risks:

- **App naming must match wrangler's derivation.** Wrangler names apps
  `<worker>-<class>` and appends `-<env>` for named environments, so the live
  apps are `pile-sandbox-production`, `pile-cursorsandbox-production`,
  `pile-devinsandbox-production`, `pile-codexsandbox-production` (dev:
  `pile-dev-sandbox`, …). The registry tags in `wrangler.toml` confirm this.
  `cf` requires an explicit `name`; a different name provisions **new**
  container applications, orphaning existing instances and doubling quota.
- **Two container config shapes exist.** `StandardContainerConfig` (has
  `image`, `maxInstances`, `instanceType`, `schedulingPolicy: "default" |
"regional"`) vs `DurableObjectContainerConfig` (`schedulingPolicy:
"durable-object"`, `images: Record<string, ContainerImage>` — named images
  the DO can start). Wrangler's `class_name` linkage is implicitly
  DO-managed. Whether to map to the standard shape + `exports.*.container`
  reference, or the durable-object shape, needs verification against
  `cf deploy` behavior — the types alone don't settle it.
- **Per-mode divergence.** Dev builds from Dockerfiles (`{ dockerfile:
"./Dockerfile.sandbox*" }`); production pins digests (`{ reference: … }`)
  precisely because cloudflare-ci has no Docker daemon. Containers must be
  returned inside the `switch (ctx.mode)` branches, not at top level, to
  preserve this.
- `cf deploy --containers-rollout` exists (`immediate`/`gradual`/`none`) and
  `cf containers applications instances` covers instance inspection for ops.
- Releasing a new image remains a docker-host step (`wrangler containers build
-p -t …`, then update the digest) — the wrangler.toml comment documenting
  that workflow should move to the new config.

## 4. D1 `migrations_dir` → no config equivalent (MEDIUM RISK)

Wrangler semantic: `migrations_dir = "migrations"` on the `[[d1_databases]]`
binding tells `wrangler d1 migrations {list,apply}` where the SQL files live.

cf model: `bindings.d1({ name, id })` has **no migrations field** — confirmed in
`D1BindingOptions` (`id`, `name`, `dev` only). Migrations are a pure CLI
concern under cf:

```
cf d1 migrations apply <database> --dir ./migrations
```

- `--dir` defaults to `./migrations` and `--pattern` defaults to
  `<dir>/*.sql` — both match this repo's flat `migrations/NNNN_*.sql` layout,
  so behavior is preserved by default. (Drizzle's nested layout would need
  `--pattern "<dir>/*/migration.sql"`.)
- `--table` defaults to `d1_migrations`, same as wrangler — applied-migration
  bookkeeping carries over.
- **Interface change:** cf takes the database (name/ID) directly; there's no
  binding-name resolution or `-e production` coupling. Current call sites:
  - `.github/workflows/migrate.yml`: `wrangler d1 migrations apply
issuetracker-global --env production --remote`
  - `scripts/selfhost.sh`: `wrangler d1 migrations apply D1 --remote`
  - `scripts/backup.sh` / `scripts/dr-restore.sh`: `wrangler d1 export
pile-global --remote … -e production`
- **Pre-existing discrepancy flagged:** migrate.yml targets
  `issuetracker-global` while `wrangler.toml` declares `database_name =
"pile-global"` (prod binding pins `database_id
c4f71628-3f93-4be1-ac11-48b5611f5934`, so the binding itself is unaffected —
  but the remote name wrangler resolves during `migrations apply` differs from
  the declared one). Worth confirming the real database name before moving the
  step to `cf d1 migrations apply <id>`.

## 5. Env split — `[env.production]` → `switch (ctx.mode)` (LOW/MEDIUM RISK)

Generated shape:

```ts
export default defineConfig((ctx) => {
  switch (ctx.mode) {
    case "production": { return { worker: { name: "pile", … } }; }
    default:           { return { worker: { name: "pile-dev", … } }; }
  }
});
```

Selected by `cf … --mode production`; wrangler's experimental new-config loader
maps `--env` to `mode` (`-e production` keeps working via
`--experimental-new-config`), and `CLOUDFLARE_ENV` also feeds `mode`.

Semantic check against wrangler's inheritance rules (verified in the wrangler
4.129 source — `triggers`, `migrations`, `exports`, `compatibility_*`, `name`
are **inheritable**; `vars`, bindings, `containers`, `send_email`, `queues` are
**not**):

- `triggers.crons` is inheritable → the production worker does run the
  `*/5 * * * *` cron today, and the generated config correctly puts
  `triggers.scheduled` in both branches.
- Production redeclares every non-inheritable binding, so the duplicated maps
  in the generated file are faithful — nothing was silently inherited.
- `routes = [{ pattern = "pile.nyc", custom_domain = true }]` → `domains:
["pile.nyc"]` on the production branch only. Correct for a custom domain
  (a non-custom route would instead be `triggers.fetch({ pattern, zone })`).
  Dev keeps `workers.dev` (cf `workersDev` defaults to `true`, matching
  wrangler's default).
- The prod-only vars (`DAYTONA_*`, `DEVIN_MODEL`, `PUBLIC_API_URL`,
  `FEEDBACK_CHANNEL_ID`) appear only in the production branch — faithful.

Risks:

- **`default:` swallows typos.** `--mode prod` (or any unknown mode) silently
  evaluates the dev/self-host branch — under wrangler, `-e prod` errors
  because no such env exists. The final config should guard `default` (e.g.
  `case "development"` / throw on unknown mode) rather than leaving open-ended
  fallthrough.
- Mode string must be threaded everywhere: `cf deploy --mode production`,
  `cf workers types --mode production`, wrangler's `-e`→mode mapping, and
  CI's `deploy`/migrate steps.

## Other observations

- **Secrets:** `.dev.vars.example` was detected but not migrated (only
  `secrets.required` entries move). Secrets stay CLI-managed: `wrangler secret
put` → `cf workers secrets update`, bulk → `cf workers secrets bulk`,
  deploy-time file → `cf deploy --secrets-file`. Verify `.dev.vars` is still
  honored by `cf dev` before switching the dev workflow.
- **Type generation:** the generated `wrangler.config.ts` sets
  `types.generate: false` — cf owns env typing (`InferEnv` /
  `cf workers types`). `pnpm run types` currently runs `wrangler types` against
  `wrangler.toml` and regenerates the committed `worker-configuration.d.ts`;
  that script needs a cf equivalent when the config lands.
- **Dual source of truth during transition:** `wrangler.toml` stays, and plain
  `wrangler deploy`/`wrangler dev` keep reading it, while `cf` reads
  `cloudflare.config.ts`. Until the toml is retired, every binding change has
  to land in two places — define which file is authoritative per operation
  (per this issue: wrangler.toml for deploys) and schedule its deletion.
- **`cf` version pinning:** repo policy prefers pinned deps ≥7 days old;
  `cf@1.0.0-beta.7` is what the migration installs — pin it, don't float
  `latest`.
- **`cf dev` bundles its own workerd** (1.20260930.2 in the global install)
  while the repo pins `compatibility_date = "2026-07-30"` to match
  `workerd 1.20260730.1` — keep the date pinned; if `cf dev` is adopted for
  local dev, verify the runtime version skew is acceptable.
- **Clean-tree requirement:** `cf migrate` refuses to run on a dirty worktree
  (`--force` overrides) and `--install` edits package.json/lockfile.

## Ops surface under cf (per the issue's interim posture)

| Task                | wrangler                        | cf                                                             |
| ------------------- | ------------------------------- | -------------------------------------------------------------- |
| Container instances | `wrangler containers instances` | `cf containers applications instances`                         |
| D1 query            | `wrangler d1 execute`           | `cf d1 query <database>` / `cf d1 raw`                         |
| Worker versions     | `wrangler versions list`        | `cf workers versions`                                          |
| Logs                | `wrangler tail`                 | `cf logs` (query/rayid/datasets — verify tail parity)          |
| Startup check       | `wrangler check startup`        | `cf workers check`                                             |
| D1 migrations       | `wrangler d1 migrations apply`  | `cf d1 migrations apply <db> [--dir]`                          |
| Secrets             | `wrangler secret`               | `cf workers secrets`                                           |
| Deploy              | `wrangler deploy -e production` | keep wrangler (per issue); `cf deploy --mode production` later |
| Dev                 | `wrangler dev`                  | `cf dev` (delegates to wrangler build)                         |
| Env types           | `wrangler types`                | `cf workers types`                                             |

## Review checklist before merging a config change

- [ ] `exports` map lists all 5 DO classes with `storage: "sqlite"` in both
      mode branches; `exportName` in `env` bindings matches export keys.
- [ ] 4 `defineContainer` entries per mode with wrangler-derived names
      (`pile-*-production` / `pile-dev-*`), correct image form per mode,
      `maxInstances: 20`, `instanceType: "standard-1"`, and the right
      scheduling shape verified against `cf deploy`.
- [ ] `container` references wired onto the four sandbox `exports.durableObject`
      entries.
- [ ] `default:` mode branch no longer silently accepts unknown modes.
- [ ] `cf d1 migrations apply` call sites updated (CI, selfhost.sh,
      backup/dr-restore scripts) and the `issuetracker-global` vs `pile-global`
      name question resolved.
- [ ] `pnpm run types` moved to `cf workers types`; `worker-configuration.d.ts`
      regeneration verified.
- [ ] `.dev.vars` handling under `cf dev` confirmed.
- [ ] Plan agreed for retiring `wrangler.toml` (or scoping it to deploy-only
      while `cloudflare.config.ts` exists).
- [ ] `cf` pinned in `package.json`; `contract:check` regenerated artifacts
      unaffected.
