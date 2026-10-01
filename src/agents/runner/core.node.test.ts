import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// The lane runner (core.py) ships to sandboxes as embedded Python — the
// workerd pool can't spawn processes, so this suite runs under the "node"
// project in vitest.config.ts and exercises the real script with a stubbed
// GitHub API. PILE-257: a merged/closed PR on the lane branch is history,
// not coverage — a new push must open a fresh PR.

const CORE_PATH = join(import.meta.dirname, "core.py");
const LANE_BRANCH = "issue-243-lane";
const NEW_PR_URL = "https://github.com/acme/widgets/pull/240";

const MERGED_PR = {
  number: 235,
  state: "closed",
  merged_at: "2026-09-29T00:00:00Z",
  html_url: "https://github.com/acme/widgets/pull/235",
};

const OPEN_PR = {
  number: 236,
  state: "open",
  merged_at: null,
  html_url: "https://github.com/acme/widgets/pull/236",
};

// Executes core.py into a module namespace, installs a github_api stub that
// emulates GitHub's ?state= filter (merged PRs report state=closed), then
// runs find_pr or finalize and prints RESULT:<json> for the Node side.
const HARNESS = `
import json
import os
import sys
import types

core_path, pulls_json, mode = sys.argv[1], sys.argv[2], sys.argv[3]
pulls = json.loads(pulls_json)
next_pr_number = [240]

mod = types.ModuleType("pile_runner_core")
mod.__dict__["__file__"] = core_path
with open(core_path) as f:
    exec(compile(f.read(), core_path, "exec"), mod.__dict__)

posts = []

def fake_github_api(method, path, body=None):
    if method == "GET" and path == "":
        return {"default_branch": "main"}
    if method == "GET" and path.startswith("/pulls"):
        qs = path.split("?", 1)[1] if "?" in path else ""
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        if params.get("head") != "acme:" + ${JSON.stringify(LANE_BRANCH)}:
            raise AssertionError("bad head filter: " + path)
        state = params.get("state", "open")
        if state == "all":
            return list(pulls)
        return [p for p in pulls if p.get("state") == state]
    if method == "POST" and path == "/pulls":
        number = next_pr_number[0]
        next_pr_number[0] += 1
        pr = {
            "state": "open",
            "number": number,
            "html_url": "https://github.com/acme/widgets/pull/%d" % number,
        }
        pulls.append(pr)
        posts.append(body)
        return pr
    raise AssertionError("unexpected github_api call: %s %s" % (method, path))

mod.__dict__["github_api"] = fake_github_api

for stale in ("/tmp/agent-result.json", "/tmp/base_sha"):
    try:
        os.remove(stale)
    except OSError:
        pass

if mode == "find":
    out = {"found": mod.__dict__["find_pr"]()}
elif mode == "finalize":
    rc = mod.__dict__["finalize"]("agent output tail", True)
    with open("/tmp/agent-result.json") as f:
        result = json.load(f)
    out = {"rc": rc, "prUrl": result["prUrl"], "posts": posts}
elif mode == "push":
    out = {"pushed": mod.__dict__["commit_and_push"](dict(os.environ))}
else:
    raise AssertionError("unknown mode " + mode)

print("RESULT:" + json.dumps(out), flush=True)
`;

const harnessDir = mkdtempSync(join(tmpdir(), "pile-runner-test-"));
const HARNESS_PATH = join(harnessDir, "harness.py");
writeFileSync(HARNESS_PATH, HARNESS);

interface HarnessResult {
  found?: string;
  rc?: number;
  prUrl?: string;
  posts?: Array<{ head?: string; base?: string }>;
  pushed?: boolean;
}

function runnerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REPO: "acme/widgets",
    BRANCH: LANE_BRANCH,
    GITHUB_TOKEN: "test-token",
    ISSUE_TITLE: "Second dispatch on ISS-1",
    ISSUE_IDENTIFIER: "ISS-1",
    AGENT_LABEL: "Devin",
  };
  // No lane/log/cache wiring — core.py must not try to reach Pile.
  delete env.PILE_LOG_URL;
  delete env.PILE_LOG_TOKEN;
  delete env.PILE_CACHE_URL;
  delete env.PILE_TOKEN_URL;
  delete env.LANE_TOKEN;
  delete env.npm_config_store_dir;
  delete env.PILE_LANE_MODE;
  return { ...env, ...extra };
}

function runHarness(
  pulls: Array<Record<string, unknown>>,
  mode: "find" | "finalize" | "push",
  extraEnv: Record<string, string> = {}
): HarnessResult {
  const out = execFileSync(
    "python3",
    [HARNESS_PATH, CORE_PATH, JSON.stringify(pulls), mode],
    { encoding: "utf8", env: runnerEnv(extraEnv), timeout: 30_000 }
  );
  const line = out
    .trim()
    .split("\n")
    .find((l) => l.startsWith("RESULT:"));
  if (!line) {
    throw new Error(`runner harness emitted no RESULT line:\n${out}`);
  }
  return JSON.parse(line.slice("RESULT:".length)) as HarnessResult;
}

describe("runner PR resolution (PILE-257)", () => {
  it("does not count a merged PR on the lane branch as coverage", () => {
    const res = runHarness([MERGED_PR], "find");
    expect(res.found).toBe("");
  });

  it("does not count a closed (unmerged) PR as coverage", () => {
    const closed = { ...MERGED_PR, merged_at: null };
    const res = runHarness([closed], "find");
    expect(res.found).toBe("");
  });

  it("returns an open PR on the lane branch", () => {
    const res = runHarness([OPEN_PR], "find");
    expect(res.found).toBe(OPEN_PR.html_url);
  });

  it("opens a fresh PR when a push lands after the first PR merged", () => {
    const res = runHarness([MERGED_PR], "finalize");
    expect(res.rc).toBe(0);
    expect(res.posts ?? []).toHaveLength(1);
    expect(res.prUrl).toBe(NEW_PR_URL);
    expect(res.posts?.[0]?.head).toBe(LANE_BRANCH);
    expect(res.posts?.[0]?.base).toBe("main");
  });

  it("reuses an existing open PR instead of creating a duplicate", () => {
    const res = runHarness([MERGED_PR, OPEN_PR], "finalize");
    expect(res.rc).toBe(0);
    expect(res.posts ?? []).toHaveLength(0);
    expect(res.prUrl).toBe(OPEN_PR.html_url);
  });

  it("opens a PR when the branch has no PR at all", () => {
    const res = runHarness([], "finalize");
    expect(res.rc).toBe(0);
    expect(res.prUrl).toBe(NEW_PR_URL);
  });
});

describe("runner plan mode (PILE-283)", () => {
  it("never commits or pushes a plan lane", () => {
    // A real push would need git + a remote; the guard returns first.
    const res = runHarness([], "push", { PILE_LANE_MODE: "plan" });
    expect(res.pushed).toBe(false);
  });
});
