import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
elif mode == "browser":
    out = {"env": mod.__dict__["with_browser_env"]({}), "prompt": mod.__dict__["lane_prompt"]()}
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
  env?: Record<string, string>;
  prompt?: string;
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

const PYTHON = execFileSync(
  "python3",
  ["-c", "import sys; print(sys.executable)"],
  { encoding: "utf8" }
).trim();

function runHarness(
  pulls: Array<Record<string, unknown>>,
  mode: "find" | "finalize" | "browser" | "push",
  extraEnv: Record<string, string> = {}
): HarnessResult {
  const out = execFileSync(
    PYTHON,
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

describe("runner headless browser (PILE-292)", () => {
  const PROMPT = "# Fix the settings page";
  const promptB64 = Buffer.from(PROMPT, "utf8").toString("base64");

  it("wires the baked chromium into the agent env and prompt", () => {
    const binDir = join(harnessDir, "browser-bin");
    mkdirSync(binDir, { recursive: true });
    const chromium = join(binDir, "chromium");
    writeFileSync(chromium, "#!/bin/sh\nexit 0\n");
    chmodSync(chromium, 0o755);
    const res = runHarness([], "browser", {
      PATH: binDir,
      PROMPT_B64: promptB64,
    });
    expect(res.env).toEqual({
      PILE_BROWSER: chromium,
      CHROME_PATH: chromium,
      PUPPETEER_EXECUTABLE_PATH: chromium,
      AGENT_BROWSER_EXECUTABLE_PATH: chromium,
      AGENT_BROWSER_ARGS: "--no-sandbox,--disable-dev-shm-usage",
    });
    expect(res.prompt?.startsWith(PROMPT)).toBe(true);
    expect(res.prompt).toContain("## Headless browser");
    expect(res.prompt).toContain(chromium);
    expect(res.prompt).not.toContain("agent-browser open");
  });

  it("mentions agent-browser only when it is installed", () => {
    const binDir = join(harnessDir, "browser-bin-ab");
    mkdirSync(binDir, { recursive: true });
    for (const name of ["chromium", "agent-browser"]) {
      const p = join(binDir, name);
      writeFileSync(p, "#!/bin/sh\nexit 0\n");
      chmodSync(p, 0o755);
    }
    const res = runHarness([], "browser", {
      PATH: binDir,
      PROMPT_B64: promptB64,
    });
    expect(res.prompt).toContain("agent-browser open");
  });

  it("leaves the prompt alone when the lane has no shell", () => {
    const binDir = join(harnessDir, "browser-bin-noshell");
    mkdirSync(binDir, { recursive: true });
    const chromium = join(binDir, "chromium");
    writeFileSync(chromium, "#!/bin/sh\nexit 0\n");
    chmodSync(chromium, 0o755);
    const res = runHarness([], "browser", {
      PATH: binDir,
      PROMPT_B64: promptB64,
      PILE_SHELL_POLICY: "disabled",
    });
    expect(res.prompt).toBe(PROMPT);
  });

  it("is a no-op on images without a browser", () => {
    const emptyDir = join(harnessDir, "no-browser-bin");
    mkdirSync(emptyDir, { recursive: true });
    const res = runHarness([], "browser", {
      PATH: emptyDir,
      PROMPT_B64: promptB64,
    });
    expect(res.env).toEqual({});
    expect(res.prompt).toBe(PROMPT);
  });
});

describe("runner plan mode (PILE-283)", () => {
  it("never commits or pushes a plan lane", () => {
    // A real push would need git + a remote; the guard returns first.
    const res = runHarness([], "push", { PILE_LANE_MODE: "plan" });
    expect(res.pushed).toBe(false);
  });
});

// PILE-279 — lane lifecycle hooks. Each case gets a fresh HOME so REPO_DIR
// is a throwaway git checkout carrying the case's .pile/config.json.
const HOOKS_HARNESS = `
import json
import os
import subprocess
import sys
import types

core_path, config_json, mode = sys.argv[1], sys.argv[2], sys.argv[3]

mod = types.ModuleType("pile_runner_core")
mod.__dict__["__file__"] = core_path
with open(core_path) as f:
    exec(compile(f.read(), core_path, "exec"), mod.__dict__)
ns = mod.__dict__
repo = ns["REPO_DIR"]
branch = ns["BRANCH"]

def git(*args):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout.strip()

os.makedirs(os.path.join(repo, ".pile"), exist_ok=True)
with open(os.path.join(repo, ".pile", "config.json"), "w") as f:
    f.write(config_json)
git("init", "-q", "-b", branch)
git("config", "user.name", "t")
git("config", "user.email", "t@example.com")
git("remote", "add", "origin", "https://example.invalid/acme/widgets.git")
git("add", "-A")
git("commit", "-q", "-m", "base")
base = git("rev-parse", "HEAD")
git("update-ref", "refs/remotes/origin/" + branch, base)
with open("/tmp/base_sha", "w") as f:
    f.write(base)
with open(os.path.join(repo, "changed.txt"), "w") as f:
    f.write("x")

env = os.environ.copy()
prompts = []

def resume(prompt):
    prompts.append(prompt)
    with open(os.path.join(repo, "fixed"), "w") as f:
        f.write("1")
    return "resumed-%d" % len(prompts)

posts = []

def fake_github_api(method, path, body=None):
    if method == "GET" and path == "":
        return {"default_branch": "main"}
    if method == "GET" and path.startswith("/pulls"):
        return []
    if method == "POST" and path == "/pulls":
        posts.append(body)
        return {"html_url": "https://github.com/acme/widgets/pull/1"}
    raise AssertionError("unexpected github_api call: %s %s" % (method, path))

ns["github_api"] = fake_github_api

if mode == "parse":
    out = {"hooks": ns["lane_hooks"]()}
elif mode == "run":
    res = ns["run_hook"]("postCheckout", env)
    missing = ns["run_hook"]("prePush", env)
    out = {"exit": res[0], "output": res[1], "missing": missing, "runs": ns["HOOK_RUNS"]}
elif mode == "heal":
    healed = ns["self_heal"](env, resume, "the original task")
    out = {"healed": healed, "prompts": prompts, "stop": ns["STOP_HOOK"]}
elif mode == "heal_finalize":
    healed = ns["self_heal"](env, resume, "the original task")
    for stale in ("/tmp/agent-result.json",):
        try:
            os.remove(stale)
        except OSError:
            pass
    ns["finalize"]("tail", True)
    with open("/tmp/agent-result.json") as f:
        result = json.load(f)
    digest = json.loads(result["result"])["digest"]
    out = {"healed": healed, "prompts": prompts, "digest": digest, "posts": posts}
elif mode == "prepush":
    try:
        ns["commit_and_push"](env)
        out = {"raised": None}
    except ns["HookFailure"] as e:
        out = {"raised": str(e)}
    out["log"] = git("log", "--format=%s")
else:
    raise AssertionError("unknown mode " + mode)

print("RESULT:" + json.dumps(out), flush=True)
`;

const HOOKS_HARNESS_PATH = join(harnessDir, "hooks-harness.py");
writeFileSync(HOOKS_HARNESS_PATH, HOOKS_HARNESS);

function runHooksHarness(
  config: Record<string, unknown>,
  mode: "parse" | "run" | "heal" | "heal_finalize" | "prepush"
): Record<string, unknown> {
  const home = mkdtempSync(join(tmpdir(), "pile-runner-hooks-"));
  const out = execFileSync(
    "python3",
    [HOOKS_HARNESS_PATH, CORE_PATH, JSON.stringify(config), mode],
    { encoding: "utf8", env: { ...runnerEnv(), HOME: home }, timeout: 30_000 }
  );
  const line = out
    .trim()
    .split("\n")
    .find((l) => l.startsWith("RESULT:"));
  if (!line) {
    throw new Error(`hooks harness emitted no RESULT line:\n${out}`);
  }
  return JSON.parse(line.slice("RESULT:".length)) as Record<string, unknown>;
}

describe("runner lane hooks (PILE-279)", () => {
  it("reads only well-formed hooks from .pile/config.json", () => {
    const res = runHooksHarness(
      {
        hooks: {
          setup: "pnpm install",
          postCheckout: "",
          prePush: 42,
          stop: "pnpm run check",
          stopMaxAttempts: 9,
        },
      },
      "parse"
    );
    expect(res.hooks).toEqual({
      setup: "pnpm install",
      stop: "pnpm run check",
    });
  });

  it("runs a hook from the repo root with lane context in its env", () => {
    const res = runHooksHarness(
      {
        hooks: {
          postCheckout:
            'echo "$PILE_HOOK $PILE_BRANCH $(basename "$PWD")"; cat "$PILE_CHANGED_FILES"; test -n "$PILE_BASE_SHA"; exit 3',
        },
      },
      "run"
    );
    expect(res.exit).toBe(3);
    expect(res.output).toContain(`postCheckout ${LANE_BRANCH} repo`);
    expect(res.output).toContain("changed.txt");
    expect(res.missing).toBeNull();
    expect(res.runs).toEqual([
      { hook: "postCheckout", exit: 3, durationSec: expect.any(Number) },
    ]);
  });

  it("resumes the agent with the stop hook failure until it passes", () => {
    const res = runHooksHarness(
      {
        hooks: { stop: "test -f fixed || { echo 'lint: 2 errors'; exit 1; }" },
      },
      "heal"
    );
    expect(res.healed).toBe("resumed-1");
    expect(res.stop).toEqual({ status: "passed", attempts: 1 });
    const prompts = res.prompts as string[];
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("lint: 2 errors");
    expect(prompts[0]).toContain("Exit code: 1");
    expect(prompts[0]).toContain("the original task");
  });

  it("does not resume when the stop hook passes first time", () => {
    const res = runHooksHarness({ hooks: { stop: "true" } }, "heal");
    expect(res.healed).toBeNull();
    expect(res.prompts).toEqual([]);
    expect(res.stop).toEqual({ status: "passed", attempts: 0 });
  });

  it("flags a stop hook that stays red after stopMaxAttempts", () => {
    const res = runHooksHarness(
      { hooks: { stop: "echo still broken; exit 2", stopMaxAttempts: 1 } },
      "heal_finalize"
    );
    expect(res.healed).toBe("resumed-1");
    expect(res.prompts).toHaveLength(1);
    const digest = res.digest as Record<string, unknown>;
    expect(digest.stopHook).toEqual({ status: "failed", attempts: 1, exit: 2 });
    const posts = res.posts as Array<{ body: string }>;
    expect(posts[0]?.body).toContain("Stop hook still failing");
  });

  it("blocks the push when prePush exits nonzero", () => {
    const res = runHooksHarness(
      { hooks: { prePush: "echo 'tests failed'; exit 1" } },
      "prepush"
    );
    expect(res.raised).toContain("prePush hook failed (exit 1)");
    expect(res.raised).toContain("tests failed");
    expect(res.log).toBe(`Devin changes for ${LANE_BRANCH}\nbase`);
  });
});
