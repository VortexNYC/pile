import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Lane permission tiers (PILE-276) as enforced by the real core.py: env
// scrubbing, git-hook kill under shell=disabled, and the push tiers. Runs a
// real git checkout under a temp HOME; network transport is stubbed.

const CORE_PATH = join(import.meta.dirname, "core.py");
const LANE_BRANCH = "issue-276-lane";

const HARNESS = `
import json
import os
import subprocess
import sys
import types

core_path, mode = sys.argv[1], sys.argv[2]
mod = types.ModuleType("pile_runner_core")
mod.__dict__["__file__"] = core_path
with open(core_path) as f:
    exec(compile(f.read(), core_path, "exec"), mod.__dict__)
g = mod.__dict__

transport = []
def fake_transport(cmd, **kwargs):
    env = kwargs.get("env") or {}
    keys = {env[k]: env.get("GIT_CONFIG_VALUE_" + k[len("GIT_CONFIG_KEY_"):])
            for k in env if k.startswith("GIT_CONFIG_KEY_")}
    transport.append({"cmd": cmd, "config": keys})
g["run_transport"] = fake_transport
g["refresh_github_token"] = lambda: None
g["github_api"] = lambda method, path, body=None: {"default_branch": "main"}

def git(*args):
    subprocess.run(["git", "-C", g["REPO_DIR"], *args], check=True, capture_output=True)

def setup_repo():
    repo = g["REPO_DIR"]
    os.makedirs(repo, exist_ok=True)
    subprocess.run(["git", "init", "-q", "-b", g["BRANCH"], repo], check=True)
    git("config", "user.name", "t")
    git("config", "user.email", "t@example.com")
    git("remote", "add", "origin", g["origin_url"]())
    with open(os.path.join(repo, "a.txt"), "w") as f:
        f.write("base\\n")
    git("add", "-A")
    git("commit", "-q", "-m", "base")
    git("update-ref", "refs/remotes/origin/" + g["BRANCH"], "HEAD")
    sha = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    with open("/tmp/base_sha", "w") as f:
        f.write(sha)
    if g["SHELL_POLICY"] == "disabled":
        for k, v in g["NO_HOOKS_GIT_CONFIG"]:
            git("config", k, v)
    g["snapshot_git_config"]()
    # Agent-planted hook in both the default dir and a config-redirected one.
    marker = os.path.join(os.environ["HOME"], "hook-ran")
    for d in (os.path.join(repo, ".git", "hooks"), os.path.join(repo, "evil-hooks")):
        os.makedirs(d, exist_ok=True)
        hook = os.path.join(d, "pre-commit")
        with open(hook, "w") as f:
            f.write("#!/bin/sh\\ntouch " + marker + "\\n")
        os.chmod(hook, 0o755)
    git("config", "core.hooksPath", os.path.join(repo, "evil-hooks"))
    with open(os.path.join(repo, "a.txt"), "a") as f:
        f.write("agent change\\n")
    return marker

out = {}
if mode == "scrub":
    out["env"] = sorted(g["scrub_env"](dict(os.environ)).keys())
elif mode == "push":
    marker = setup_repo()
    try:
        out["pushed"] = g["commit_and_push"](dict(os.environ))
    except RuntimeError as e:
        out["error"] = str(e)
    out["hookRan"] = os.path.exists(marker)
    out["transport"] = transport
    with open(os.path.join(g["REPO_DIR"], ".git", "config")) as f:
        out["gitConfig"] = f.read()
    log = subprocess.run(["git", "-C", g["REPO_DIR"], "log", "--format=%s"], capture_output=True, text=True).stdout
    out["commits"] = [l for l in log.splitlines() if l]
else:
    raise AssertionError("unknown mode " + mode)
# Bypass the runner's redacting stdout tee: assertions need raw values.
sys.__stdout__.write("RESULT:" + json.dumps(out) + "\\n")
sys.__stdout__.flush()
`;

const harnessDir = mkdtempSync(join(tmpdir(), "pile-policy-test-"));
const HARNESS_PATH = join(harnessDir, "harness.py");
writeFileSync(HARNESS_PATH, HARNESS);

interface PolicyResult {
  env?: string[];
  pushed?: boolean;
  error?: string;
  hookRan?: boolean;
  transport?: Array<{ cmd: string[]; config: Record<string, string> }>;
  gitConfig?: string;
  commits?: string[];
}

function runPolicy(
  mode: "scrub" | "push",
  policy: { push: string; shell: string },
  extra: Record<string, string> = {}
): PolicyResult {
  const home = mkdtempSync(join(tmpdir(), "pile-policy-home-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: process.env.PATH,
    HOME: home,
    REPO: "acme/widgets",
    BRANCH: LANE_BRANCH,
    GITHUB_TOKEN: "ghs_secret",
    AGENT_LABEL: "Devin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    PILE_PUSH_POLICY: policy.push,
    PILE_SHELL_POLICY: policy.shell,
    ...extra,
  };
  const out = execFileSync("python3", [HARNESS_PATH, CORE_PATH, mode], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  const line = out
    .trim()
    .split("\n")
    .find((l) => l.startsWith("RESULT:"));
  if (!line) throw new Error(`policy harness emitted no RESULT line:\n${out}`);
  return JSON.parse(line.slice("RESULT:".length)) as PolicyResult;
}

const SECRETS = {
  LANE_TOKEN: "lane",
  PILE_TOKEN_URL: "https://pile/token",
  PILE_API_KEY: "pil_x",
  DATABASE_URL: "postgres://x",
  STRIPE_SECRET: "sk",
  REPO_INJECTED: "x",
  CURSOR_API_KEY: "cursor",
  PILE_AGENT_CREDENTIAL_ENV: "CURSOR_API_KEY",
  PILE_EXTRA_ENV_KEYS: "REPO_INJECTED",
};

describe("runner lane permission tiers (PILE-276)", () => {
  it("leaves the agent env untouched when every tier is enabled", () => {
    const res = runPolicy(
      "scrub",
      { push: "enabled", shell: "enabled" },
      SECRETS
    );
    expect(res.env).toEqual(
      expect.arrayContaining(["GITHUB_TOKEN", "LANE_TOKEN", "DATABASE_URL"])
    );
  });

  it("strips push credentials below push=enabled", () => {
    const res = runPolicy(
      "scrub",
      { push: "restricted", shell: "enabled" },
      SECRETS
    );
    expect(res.env).not.toContain("GITHUB_TOKEN");
    expect(res.env).not.toContain("LANE_TOKEN");
    expect(res.env).not.toContain("PILE_TOKEN_URL");
    expect(res.env).toContain("DATABASE_URL");
  });

  it("strips env-var secrets under shell=restricted but keeps the agent credential", () => {
    const res = runPolicy(
      "scrub",
      { push: "enabled", shell: "restricted" },
      SECRETS
    );
    for (const key of [
      "GITHUB_TOKEN",
      "LANE_TOKEN",
      "PILE_API_KEY",
      "DATABASE_URL",
      "STRIPE_SECRET",
      "REPO_INJECTED",
    ]) {
      expect(res.env).not.toContain(key);
    }
    expect(res.env).toContain("CURSOR_API_KEY");
    expect(res.env).toContain("GIT_CONFIG_GLOBAL");
    expect(res.env).toContain("REPO");
  });

  it("push=enabled, shell=enabled keeps today's behavior", () => {
    const res = runPolicy("push", { push: "enabled", shell: "enabled" });
    expect(res.pushed).toBe(true);
    expect(res.hookRan).toBe(true);
    expect(res.transport?.[0]?.cmd.slice(-3)).toEqual([
      "push",
      "origin",
      LANE_BRANCH,
    ]);
  });

  it("shell=disabled kills git hooks, even ones re-pointed via .git/config", () => {
    const res = runPolicy("push", { push: "enabled", shell: "disabled" });
    expect(res.pushed).toBe(true);
    expect(res.hookRan).toBe(false);
    expect(res.gitConfig).not.toContain("evil-hooks");
    expect(res.transport?.[0]?.config["core.hooksPath"]).toBe("/dev/null");
  });

  it("push=restricted pushes only the lane branch with a non-persisted token", () => {
    const res = runPolicy("push", { push: "restricted", shell: "enabled" });
    expect(res.pushed).toBe(true);
    const push = res.transport?.[0];
    expect(push?.cmd).toEqual(
      expect.arrayContaining([
        "--no-follow-tags",
        "https://github.com/acme/widgets.git",
        `HEAD:refs/heads/${LANE_BRANCH}`,
      ])
    );
    expect(push?.cmd.join(" ")).not.toContain("ghs_secret");
    expect(push?.config["http.https://github.com/.extraheader"]).toMatch(
      /^AUTHORIZATION: basic /
    );
    expect(push?.config["core.hooksPath"]).toBe("/dev/null");
    expect(res.gitConfig).not.toContain("ghs_secret");
  });

  it("push=restricted refuses to push the default branch", () => {
    const res = runPolicy(
      "push",
      { push: "restricted", shell: "enabled" },
      { BRANCH: "main" }
    );
    expect(res.error).toContain("push restricted by lane policy");
    expect(res.transport).toEqual([]);
  });

  it("push=disabled commits locally and never pushes", () => {
    const res = runPolicy("push", { push: "disabled", shell: "disabled" });
    expect(res.pushed).toBe(false);
    expect(res.transport).toEqual([]);
    expect(res.commits?.[0]).toBe(`Devin changes for ${LANE_BRANCH}`);
    expect(res.hookRan).toBe(false);
  });

  it("treats an unknown tier as disabled", () => {
    const res = runPolicy("push", { push: "yolo", shell: "enabled" });
    expect(res.pushed).toBe(false);
    expect(res.transport).toEqual([]);
  });
});
