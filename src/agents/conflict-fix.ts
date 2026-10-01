// PILE-251 — deterministic merge-conflict resolution. When a lane's PR is
// reported unmergeable, first check whether every file that changed on both
// sides of the merge base is a repo-declared generated artifact
// (.pile/config.json `conflict.generated`). If so, a scripted fixer sandbox —
// not an LLM lane — clones the PR branch, merges the base ref, regenerates
// the artifacts (`conflict.regen`), commits, and pushes. Source conflicts,
// missing config, unknown conflict sets, and fixer failures all fall through
// to the lane follow-up.
//
// Fixer lifecycle is tracked on the session's event stream (`pr.conflict_fix`
// events with {headSha, state}) so the multi-minute sandbox run spans sweep
// ticks: started → resolved | source_conflict | failed.
import { parsePileRepoConfig } from "../global/pile-repo-config.js";
import type { WorkerEnv } from "../platform/middleware.js";
import {
  DEFAULT_GIT_IDENTITY_REPO,
  type AgentSession,
} from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { computeBackend, type ComputeBackend } from "./compute.js";
import { loadProviderConfig } from "./credentials.js";
import { resolveAgentEnv } from "./daytona.js";

const FIXER_RESULT_PATH = "/tmp/pile-conflict-fix.json";
// A fixer run is clone + merge + regen — seconds when warm, minutes cold.
// Past this bound the sandbox is presumed wedged; the sweep stops waiting and
// hands the conflict to the lane.
const FIXER_MAX_AGE_MS = 20 * 60 * 1000;
// Daytona sandboxes can take a couple of minutes to register in the list API
// — don't declare a just-launched fixer missing while it is still
// provisioning.
const FIXER_PROVISION_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_PROBE_MS = 90_000;
// The compare API paginates at 300 files; past that the conflict set is
// unknowable — fall back to the lane rather than guess.
const COMPARE_FILE_CAP = 300;

export interface ConflictFixDeps {
  /** Compute backend factory — injected in tests; defaults to the real one. */
  compute?: (env: WorkerEnv, agentId: string) => ComputeBackend;
  probeTimeoutMs?: number;
}

/** How a conflicting PR was handled this sweep. `resolved` and `in_flight`
 *  suppress the lane nudge; `lane` falls through to it. */
export type ConflictPath = "resolved" | "in_flight" | "lane";

type FixerOutcome =
  | "running"
  | "resolved"
  | "noop"
  | "source_conflict"
  | "failed";

interface FixerEvent {
  headSha: string | null;
  state: "started" | "resolved" | "source_conflict" | "failed";
  createdAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function fixerName(sessionId: string): string {
  return `pile-fix-${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
}

function fixerId(sessionId: string): string {
  return `fix-${sessionId.replace(/[^a-zA-Z0-9-]/g, "")}`;
}

/** Latest `pr.conflict_fix` lifecycle marker for the session, if any. The
 *  event stream is the dedupe + tracking store — one fixer at a time per
 *  lane. */
function latestFixEvent(
  events: Array<{ type: string; payload: unknown; createdAt?: string | null }>
): FixerEvent | null {
  for (const e of events) {
    if (e.type !== "pr.conflict_fix" || typeof e.payload !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(e.payload);
      if (!isRecord(parsed)) continue;
      const state = parsed.state;
      if (
        state !== "started" &&
        state !== "resolved" &&
        state !== "source_conflict" &&
        state !== "failed"
      )
        continue;
      const createdAtMs = Date.parse(e.createdAt ?? "");
      return {
        headSha: typeof parsed.headSha === "string" ? parsed.headSha : null,
        state,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
      };
    } catch {
      continue;
    }
  }
  return null;
}

interface ConflictConfig {
  generated: Set<string>;
  regen: string;
}

/** `.pile/config.json` at the BASE ref — the default branch declares which
 *  paths regenerate deterministically and the command that regenerates them.
 *  Read from base, not the PR head: `regen` is a shell command the fixer runs
 *  with the installation token, so it must come from the trusted branch. */
async function fetchConflictConfig(
  ghGet: (path: string) => Promise<unknown>,
  repoFull: string,
  ref: string
): Promise<ConflictConfig | null> {
  try {
    const res = await ghGet(
      `/repos/${repoFull}/contents/.pile/config.json?ref=${encodeURIComponent(ref)}`
    );
    if (!isRecord(res)) return null;
    if (res.encoding !== "base64" || typeof res.content !== "string")
      return null;
    const config = parsePileRepoConfig(
      JSON.parse(atob(res.content.replace(/\s/g, "")))
    );
    if (!config?.conflict) return null;
    return {
      generated: new Set(config.conflict.generated),
      regen: config.conflict.regen,
    };
  } catch {
    return null;
  }
}

function compareFileNames(raw: unknown): string[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.files)) return null;
  const files = raw.files;
  if (files.length >= COMPARE_FILE_CAP) return null;
  const names: string[] = [];
  for (const f of files) {
    if (!isRecord(f)) continue;
    if (typeof f.filename === "string") names.push(f.filename);
    // Renames conflict under the old path too — count both names.
    if (typeof f.previous_filename === "string")
      names.push(f.previous_filename);
  }
  return names;
}

/** Files changed on both sides of the merge base — a superset of the real
 *  conflict set (git auto-merges many dual-side edits), but every real
 *  conflict is inside it, which is all the generated-only check needs.
 *  Returns null when GitHub can't tell us. */
async function conflictCandidates(
  ghGet: (path: string) => Promise<unknown>,
  repoFull: string,
  baseRef: string,
  headSha: string
): Promise<string[] | null> {
  try {
    // Resolve the base tip — `base.sha` on the PR object lags, and compare
    // against the stale sha would miss just-landed base changes.
    const branch = await ghGet(
      `/repos/${repoFull}/branches/${encodeURIComponent(baseRef)}`
    );
    const baseTip =
      isRecord(branch) &&
      isRecord(branch.commit) &&
      typeof branch.commit.sha === "string"
        ? branch.commit.sha
        : null;
    if (!baseTip) return null;
    // compare/A...B diffs merge-base(A,B)→B, so both calls share the merge
    // base of head↔base.
    const [headSide, baseSide] = await Promise.all([
      ghGet(`/repos/${repoFull}/compare/${baseTip}...${headSha}`),
      ghGet(`/repos/${repoFull}/compare/${headSha}...${baseTip}`),
    ]);
    const headFiles = compareFileNames(headSide);
    const baseFiles = compareFileNames(baseSide);
    if (!headFiles || !baseFiles) return null;
    const onHead = new Set(headFiles);
    return [...new Set(baseFiles)].filter((f) => onHead.has(f));
  } catch {
    return null;
  }
}

// Static bash driven entirely by env — every repo-specific input arrives via
// the sandbox environment, so the same script works for any repo that opts in
// through .pile/config.json.
const FIX_SCRIPT = `set -uo pipefail
RESULT=${FIXER_RESULT_PATH}
write_result() {
  FIX_OUTCOME="$1" FIX_DETAIL="\${2:-}" python3 - "$RESULT" <<'PYEOF'
import json, os, sys
json.dump(
    {"outcome": os.environ.get("FIX_OUTCOME", ""), "detail": os.environ.get("FIX_DETAIL", "")},
    open(sys.argv[1], "w"),
)
PYEOF
}
fail() { write_result failed "$1"; exit 0; }

cd /tmp
rm -rf pile-conflict-repo
git clone --quiet --branch "$BRANCH" "https://x-access-token:\${GITHUB_TOKEN}@github.com/\${REPO}.git" pile-conflict-repo || fail "clone failed"
cd pile-conflict-repo || fail "clone missing"
git config user.name "\${GIT_AUTHOR_NAME:-Pile}"
git config user.email "\${GIT_AUTHOR_EMAIL:-pile@pile.nyc}"
git fetch --quiet origin "$BASE_REF" || fail "base fetch failed"
# Shallow clones can lack the merge base — deepen rather than die.
git merge-base HEAD FETCH_HEAD >/dev/null 2>&1 || \\
  git fetch --quiet --unshallow origin "$BASE_REF" "$BRANCH" 2>/dev/null || true
git merge --no-commit --no-ff FETCH_HEAD >/dev/null 2>&1 || true

conflicted=$(git diff --name-only --diff-filter=U)
unexpected=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  printf '%s\\n' "$GENERATED_FILES" | grep -Fqx "$f" || unexpected="$unexpected $f"
done <<EOF2
$conflicted
EOF2

if [ -n "$unexpected" ]; then
  git merge --abort >/dev/null 2>&1 || true
  write_result source_conflict "$unexpected"
  exit 0
fi

# Clear conflict markers with either side — regen below produces the real
# content, so which side wins here doesn't matter.
while IFS= read -r f; do
  [ -z "$f" ] && continue
  git checkout --ours -- "$f" 2>/dev/null || git rm -qf "$f" 2>/dev/null || true
done <<EOF2
$conflicted
EOF2

[ -f .pile/setup.sh ] && bash .pile/setup.sh
bash -lc "$REGEN_COMMAND" || fail "regen failed"
git add -A
if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
  git commit --no-edit >/dev/null 2>&1 || \\
    git commit -m "merge \${BASE_REF} + regenerate artifacts" || fail "commit failed"
elif git diff --cached --quiet; then
  write_result noop "already up to date"
  exit 0
else
  git commit -m "regenerate artifacts" || fail "commit failed"
fi
git push origin "HEAD:\${BRANCH}" || fail "push failed"
write_result resolved
`;

function encodeBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(bin);
}

async function backendFor(
  env: WorkerEnv,
  stub: DurableObjectStub<WorkspaceDO>,
  session: AgentSession,
  deps: ConflictFixDeps | undefined
): Promise<ComputeBackend> {
  const providerConfig = await loadProviderConfig(env, stub, session.agentId);
  const effectiveEnv = resolveAgentEnv(env, providerConfig ?? undefined);
  return deps?.compute
    ? deps.compute(effectiveEnv, session.agentId)
    : computeBackend(effectiveEnv, session.agentId);
}

function parseFixResult(raw: string | null): {
  outcome: Exclude<FixerOutcome, "running">;
  detail: string;
} {
  if (!raw) return { outcome: "failed", detail: "no result file" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { outcome: "failed", detail: "bad result" };
    const outcome = parsed.outcome;
    return {
      outcome:
        outcome === "resolved" ||
        outcome === "noop" ||
        outcome === "source_conflict"
          ? outcome
          : "failed",
      detail: typeof parsed.detail === "string" ? parsed.detail : "",
    };
  } catch {
    return { outcome: "failed", detail: "unparseable result" };
  }
}

/** Read the in-flight fixer's progress. Terminal outcomes are recorded as
 *  `pr.conflict_fix` events and the sandbox is destroyed. */
async function pollConflictFixer(
  env: WorkerEnv,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  session: AgentSession,
  fix: FixerEvent,
  deps: ConflictFixDeps | undefined
): Promise<Exclude<FixerOutcome, "noop">> {
  const record = async (state: FixerEvent["state"], detail: string) => {
    await stub
      .addAgentSessionEvent({
        sessionId: session.id,
        type: "pr.conflict_fix",
        message: `conflict fixer ${state}${detail ? `: ${detail}` : ""}`,
        payload: { headSha: fix.headSha, state, detail },
      })
      .catch(() => {});
  };

  if (fix.createdAtMs > 0 && Date.now() - fix.createdAtMs > FIXER_MAX_AGE_MS) {
    await record("failed", "fixer timed out");
    return "failed";
  }
  let compute: ComputeBackend;
  try {
    compute = await backendFor(env, stub, session, deps);
  } catch (err) {
    console.error("conflict fixer backend unavailable", {
      session: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return "running"; // transient — retry next sweep, bounded by FIXER_MAX_AGE
  }
  const id = fixerId(session.id);
  const name = fixerName(session.id);
  try {
    const sandbox = await compute.findSandbox(id, name, FIXER_RESULT_PATH);
    if (!sandbox) {
      // Still within the provisioning window the sandbox may simply not be
      // listed yet — keep waiting rather than fail a run that's mid-boot.
      if (Date.now() - fix.createdAtMs < FIXER_PROVISION_GRACE_MS)
        return "running";
      await record("failed", "fixer sandbox never came up");
      return "failed";
    }
    const state = await compute.runnerState(sandbox, id);
    if (state === "pending" || state === "running") return "running";
    const result = parseFixResult(
      await compute.readFile(sandbox, FIXER_RESULT_PATH)
    );
    await compute.deleteSandbox(sandbox).catch(() => {});
    const terminal = result.outcome === "noop" ? "resolved" : result.outcome;
    await record(terminal, result.detail);
    return terminal === "resolved"
      ? "resolved"
      : terminal === "source_conflict"
        ? "source_conflict"
        : "failed";
  } catch (err) {
    console.error("conflict fixer poll failed", {
      session: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return "running";
  }
}

/** Provision the fixer sandbox and start the merge+regen script. The started
 *  event is written first — it's the dedupe anchor, so a provisioning failure
 *  flips straight to `failed` and the lane path takes over. */
async function launchConflictFixer(
  env: WorkerEnv,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  session: AgentSession,
  ctx: {
    repoFull: string;
    headRef: string;
    baseRef: string;
    headSha: string | null;
    prUrl: string;
    token: string;
    config: ConflictConfig;
    files: string[];
    deps?: ConflictFixDeps;
  }
): Promise<ConflictPath> {
  const id = fixerId(session.id);
  const name = fixerName(session.id);
  const markFailed = async (detail: string) => {
    await stub
      .addAgentSessionEvent({
        sessionId: session.id,
        type: "pr.conflict_fix",
        message: `conflict fixer failed: ${detail}`,
        payload: { headSha: ctx.headSha, state: "failed", detail },
      })
      .catch(() => {});
  };
  await stub
    .addAgentSessionEvent({
      sessionId: session.id,
      type: "pr.conflict_fix",
      message: `generated-only conflict on ${ctx.prUrl} — scripted fixer launched`,
      payload: {
        headSha: ctx.headSha,
        state: "started",
        files: ctx.files,
        sandbox: name,
      },
    })
    .catch(() => {});
  try {
    const gitIdentity =
      (await stub.getGitIdentityByRepo(ctx.repoFull).catch(() => undefined)) ??
      (await stub
        .getGitIdentityByRepo(DEFAULT_GIT_IDENTITY_REPO)
        .catch(() => undefined));
    const compute = await backendFor(env, stub, session, ctx.deps);
    const fixEnv = {
      REPO: ctx.repoFull,
      BRANCH: ctx.headRef,
      BASE_REF: ctx.baseRef,
      GITHUB_TOKEN: ctx.token,
      GIT_AUTHOR_NAME: gitIdentity?.name ?? "Pile",
      GIT_AUTHOR_EMAIL: gitIdentity?.email ?? "pile@pile.nyc",
      GENERATED_FILES: [...ctx.config.generated].join("\n"),
      REGEN_COMMAND: ctx.config.regen,
      FIX_B64: encodeBase64(FIX_SCRIPT),
    };
    const probeMs = ctx.deps?.probeTimeoutMs ?? DEFAULT_PROBE_MS;
    const sandbox = await withTimeout(
      compute.createSandbox({
        name,
        sessionId: id,
        organizationId,
        agentLabel: "conflict-fix",
        env: fixEnv,
      }),
      probeMs,
      "fixer provision"
    );
    await withTimeout(
      compute.startRunner(
        sandbox,
        id,
        "printf '%s' \"$FIX_B64\" | base64 -d > /tmp/fix.sh && bash /tmp/fix.sh",
        fixEnv
      ),
      probeMs,
      "fixer start"
    );
    console.log("pr.conflict path", {
      session: session.id,
      prUrl: ctx.prUrl,
      headSha: ctx.headSha,
      path: "deterministic",
      files: ctx.files,
    });
    return "in_flight";
  } catch (err) {
    await markFailed(err instanceof Error ? err.message : String(err));
    console.log("pr.conflict path", {
      session: session.id,
      prUrl: ctx.prUrl,
      headSha: ctx.headSha,
      path: "lane",
      reason: "fixer launch failed",
    });
    return "lane";
  }
}

/** The deterministic side of pr.conflict handling. Returns "resolved" /
 *  "in_flight" when the scripted fixer owns the conflict (suppress the lane
 *  nudge) and "lane" when the conflict needs an agent. */
export async function resolveGeneratedConflict(
  env: WorkerEnv,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  session: AgentSession,
  ctx: {
    repoFull: string;
    prUrl: string;
    headSha: string | null;
    pr: Record<string, unknown>;
    token: string;
    ghGet: (path: string) => Promise<unknown>;
    deps?: ConflictFixDeps;
  }
): Promise<ConflictPath> {
  const log = (path: ConflictPath, reason: string) =>
    console.log("pr.conflict path", {
      session: session.id,
      prUrl: ctx.prUrl,
      headSha: ctx.headSha,
      path,
      reason,
    });
  const events = await stub
    .listAgentSessionEvents(session.id, { limit: 100, order: "desc" })
    .catch(() => []);
  const fix = latestFixEvent(events);

  if (fix?.state === "started") {
    // One fixer at a time per lane — poll it regardless of which headSha it
    // covers; a stale run settles and the next sweep re-evaluates.
    const outcome = await pollConflictFixer(
      env,
      stub,
      organizationId,
      session,
      fix,
      ctx.deps
    );
    if (outcome === "running") {
      log("in_flight", "fixer running");
      return "in_flight";
    }
    if (outcome === "resolved" && fix.headSha === ctx.headSha) {
      log("resolved", "fixer pushed the merge");
      return "resolved";
    }
    if (fix.headSha === ctx.headSha) {
      log("lane", `fixer outcome ${outcome}`);
      return "lane";
    }
    // The fixer settled against a stale head — the branch moved. Fall
    // through and re-evaluate the conflict for the current sha.
  }
  if (fix && fix.headSha === ctx.headSha) {
    // Already settled for this head — a resolved fix needs no nudge; a failed
    // or source-conflict one goes to the lane exactly once per sha.
    const path = fix.state === "resolved" ? "resolved" : "lane";
    log(path, `fixer already ${fix.state} for this head`);
    return path;
  }

  const head = isRecord(ctx.pr.head) ? ctx.pr.head : undefined;
  const base = isRecord(ctx.pr.base) ? ctx.pr.base : undefined;
  const headRef = typeof head?.ref === "string" ? head.ref : null;
  const baseRef = typeof base?.ref === "string" ? base.ref : null;
  const headRepo =
    isRecord(head?.repo) && typeof head.repo.full_name === "string"
      ? head.repo.full_name
      : null;
  if (!headRef || !baseRef || headRepo !== ctx.repoFull || !ctx.headSha) {
    log("lane", "fork PR or missing refs");
    return "lane";
  }
  const config = await fetchConflictConfig(ctx.ghGet, ctx.repoFull, baseRef);
  if (!config) {
    log("lane", "no conflict.generated config");
    return "lane";
  }
  const candidates = await conflictCandidates(
    ctx.ghGet,
    ctx.repoFull,
    baseRef,
    ctx.headSha
  );
  if (candidates === null) {
    log("lane", "conflict set unknowable");
    return "lane";
  }
  if (!candidates.every((f) => config.generated.has(f))) {
    log("lane", "source files in conflict set");
    return "lane";
  }
  return launchConflictFixer(env, stub, organizationId, session, {
    repoFull: ctx.repoFull,
    headRef,
    baseRef,
    headSha: ctx.headSha,
    prUrl: ctx.prUrl,
    token: ctx.token,
    config,
    files: candidates,
    deps: ctx.deps,
  });
}
