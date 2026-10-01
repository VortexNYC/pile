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
}

function runnerEnv(): NodeJS.ProcessEnv {
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
  return env;
}

const PYTHON = execFileSync(
  "python3",
  ["-c", "import sys; print(sys.executable)"],
  { encoding: "utf8" }
).trim();

function runHarness(
  pulls: Array<Record<string, unknown>>,
  mode: "find" | "finalize" | "browser",
  envOverrides: NodeJS.ProcessEnv = {}
): HarnessResult {
  const out = execFileSync(
    PYTHON,
    [HARNESS_PATH, CORE_PATH, JSON.stringify(pulls), mode],
    {
      encoding: "utf8",
      env: { ...runnerEnv(), ...envOverrides },
      timeout: 30_000,
    }
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
