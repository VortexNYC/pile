# Lane integration coverage audit (VTX-620)

Confidence audit for the claim "dispatched agents reliably finish technical
work" — the devin-cli lane on every compute substrate it can land on:
Daytona (toolbox HTTP API), Cloudflare sandbox-sdk 0.12 (`CloudflareBackend`),
sandbox-sdk 1.0 lane DOs (`LaneSandboxBackend`), and the Daytona→lane-pool
`FailoverBackend` wrapper. devin-cli is the representative
`SandboxCliAgentProvider` — cursor/codex/claude share the same lifecycle.

## Pipeline stages and where they are covered

| Stage                                                                                                                                                  | Implementation                                                       | Coverage                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dispatch validation (session id, repo, branch safety, git identity, external-execution permission gate)                                                | `sandbox-cli.ts` `dispatch`                                          | `devin-cli.test.ts`, `index.test.ts` (cap park, stale-dispatch refusal)                                                                                               |
| credential resolve (single → pool → fallback note)                                                                                                     | `sandbox-cli.ts` `resolveCredential`                                 | `subscription-pool.test.ts`, `credentials.test.ts`; devin `normalizeCredentialsB64` in `devin-cli.test.ts`                                                            |
| provision (find-existing → create → cache mount → putFiles → startRunner → waitForRunner, bounded by `PROVISION_TIMEOUT_MS`, transient-class retry ×3) | `sandbox-cli.ts` `start`                                             | `sandbox-cli.test.ts` (retry/backoff/budget), `devin-cli.test.ts` (hang bound), `devin-cli-backends.test.ts` (per-backend e2e)                                        |
| sandbox file delivery (lane.env 0600, prompt.md, run.py — nothing over the 128KB execve cap)                                                           | `sandbox-cli.ts` `laneFiles`                                         | `sandbox-cli.test.ts` (PILE-595 payload tests), per-backend upload asserts                                                                                            |
| runner (clone → hooks → agent turn → commit/push → PR → result file)                                                                                   | `runner/core.py` + drivers                                           | `core.node.test.ts` (PR resolution, hooks, push states, rate-limit parsing), `devin.node.test.ts` (credentials.toml, MCP config, tool policy, follow-up inject/drain) |
| poll → result (created/running/terminal, truncation continuation, rate-limit park flags, preview tunnel)                                               | `sandbox-cli.ts` `poll`                                              | `devin-cli.test.ts`, `devin-cli-backends.test.ts`, `sandbox-cli.test.ts` (continuation cap/fallback)                                                                  |
| follow-up (mid-run stdin inject vs `-fu` spawn vs worktree-restore revive)                                                                             | `sandbox-cli.ts` `sendPrompt`, `devin.py`                            | `devin-cli-backends.test.ts` (CF + lane DO), `devin-cli.test.ts` (Daytona), `devin.node.test.ts` (inject/drain)                                                       |
| result seam → sweep (rateLimited/rateLimitUntil park, infraFailure retry)                                                                              | `runnerResultSchema` → `sweep.ts` → `durable-object.ts`              | `devin-cli-backends.test.ts` (poll passthrough), `core.node.test.ts` (fail_result payload), `durable-object.test.ts` (park escalation), `sweep.test.ts` (drain)       |
| teardown (cancel by name, orphan sweep, kept-sandbox reaper, worktree backup/restore)                                                                  | `cancel`, `sweepOrphanSandboxes`, `backupWorktree`/`restoreWorktree` | `compute.test.ts`, `devin-cli-backends.test.ts`                                                                                                                       |

## What the VTX-620 pass added on top of PR #535

- `poll` passthrough of `rateLimited`/`rateLimitUntil` — the seam the
  rate-limit park (VTX-634/638) depends on; previously only the DO side and
  the runner parser were pinned.
- `fail_result` result-file contract in `core.node.test.ts` — rate-limit →
  `rateLimited` + `rateLimitUntil`; `TransportError` → `infraFailure`; plain
  error → neither.
- `LaneSandboxBackend.findSandbox` result-file fallback (slept/restarted
  container still yields its result) at both backend and provider level.
- Daytona `runnerBusy` (`<sess>` + `<sess>-fu`), `startRunner` env-file
  wrapping, `putFiles` upload-v2→legacy fallback, `deleteSandbox` 404.
- devin-cli `sendPrompt` on Daytona: stdin-inject while busy, `-fu` process
  session when idle.
- `inject_followups` mid-run stdin channel in `devin.node.test.ts`.
- CF `backupWorktree`/`restoreWorktree` staging commands (credentials stay in
  `$HOME`, outside the backup).
- Truncation-continuation env recovery from `sandbox.runnerEnv` (pre-595
  lanes without `/tmp/pile/lane.env`).
- `getState` (runner state + transcript/log tail) on both CF backends.

## Remaining gaps — cannot be covered in the vitest pool

These paths need a real substrate; they are verified by canary/manual runs,
not CI. Listed so the next coverage pass knows where the floor is:

- `LaneSandboxBase` DO internals (`spawn` wrapper script, `.exit`/`.pid`
  sentinels, `sessionBusy`, `probe`, `DirectoryBackup`): the class runs
  inside `ctx.container`, which `wrangler.test.toml` cannot bind — the RPC
  surface is mocked in every test. A real container run is the only proof
  the sentinel logic works.
- Real Daytona API behavior: schema drift (`daytonaSandboxSchema` strictness),
  actual `Retry-After` headers, real toolbox session/exec semantics. All
  Daytona tests mock `fetch` against the documented API shape.
- The devin CLI binary itself: `ensure()`'s install path, `devin -p` argv,
  real stdout parsing, real permission-mode behavior. Runner tests stub or
  skip the binary entirely.
- `cfAdmit` against the real cloudflare-ci scheduler DO (429 contract,
  fail-open on unreachable) — only the response-shape branches are mocked.
- `maybePostPreview` (preview tunnel → PR comment): needs `.pile/config.json`
  fetch + GitHub comment POST; not covered.
- MCP lane endpoint (`write_lane_mcp_config` writes config, but the actual
  `pile-lane` server tools are exercised only by the real agent).
- `devin.py` `main()` FOLLOWUP=1 ordering (stale-result removal → resume_repo
  → run_turn → drain → finalize) — covered piecewise, not as one run.

## Suggested manual/canary verification

A real lane on each substrate is the only end-to-end proof; the cheapest
canary is a repo-less devin-cli dispatch per backend
(`COMPUTE_PROVIDER=daytona`, `cloudflare`, `cloudflare+LANE_SDK=v1`,
`daytona+LANE_FAILOVER=v1`), asserting the result file lands and
`poll`→session→receipt completes. Any regression in the mocked seams above
would show up there first.
