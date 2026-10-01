import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// PILE-294 — core.py clones secondary repos under ~/xrepo/<owner>/<name>
// and, for `write` entries, pushes the lane branch and opens a PR there.
// GitHub remotes are redirected to local bare repos via url.insteadOf.

const CORE_PATH = join(import.meta.dirname, "core.py");
const LANE_BRANCH = "issue-294-lane";
const TOKEN = "ghs_primarytoken00000000";
const SECONDARY_TOKEN = "ghs_secondarytoken000000";

const HARNESS = `
import json
import os
import sys
import types

core_path = sys.argv[1]
mod = types.ModuleType("pile_runner_core")
mod.__dict__["__file__"] = core_path
with open(core_path) as f:
    exec(compile(f.read(), core_path, "exec"), mod.__dict__)

calls = []
# stdout is credential-masked, so report token identity rather than values.
secondary_token = json.loads(os.environ["SECONDARY_REPOS_JSON"])[0]["token"]

def fake_github_api(method, path, body=None, repo=None, token=None):
    calls.append({"method": method, "path": path, "repo": repo, "secondaryToken": token == secondary_token, "body": body})
    if method == "GET" and path == "":
        return {"default_branch": "main"}
    if method == "GET" and path.startswith("/pulls"):
        return []
    if method == "POST" and path == "/pulls":
        return {"html_url": "https://github.com/%s/pull/7" % repo}
    raise AssertionError("unexpected github_api call: %s %s" % (method, path))

revoked = []
mod.__dict__["github_api"] = fake_github_api
mod.__dict__["_revoke_installation_token"] = lambda token, label: revoked.append(token == secondary_token)
mod.__dict__["clone_secondary_repos"]()
home = os.environ["HOME"]
with open(os.path.join(home, "xrepo", "acme", "vortex", "CHANGED.md"), "w") as f:
    f.write("cross-repo patch\\n")
mod.__dict__["push_secondary_repos"](dict(os.environ))
digest = mod.__dict__["collect_digest"]()
agent_env_keys = sorted(mod.__dict__["agent_env_base"]().keys())
mod.__dict__["revoke_secondary_tokens"]()
import subprocess
remote = subprocess.run(["git", "-C", os.path.join(home, "xrepo", "acme", "vortex"), "remote", "get-url", "origin"], capture_output=True, text=True).stdout.strip()
print("RESULT:" + json.dumps({"calls": calls, "digest": digest, "errors": mod.__dict__["PR_ERRORS"], "agentEnvKeys": agent_env_keys, "revoked": revoked, "remote": remote}), flush=True)
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRemote(remotes: string, repo: string): string {
  const bare = join(remotes, `${repo}.git`);
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "--bare", "-q", "-b", "main");
  const seed = mkdtempSync(join(tmpdir(), "pile-xrepo-seed-"));
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), `${repo}\n`);
  git(seed, "add", "-A");
  git(
    seed,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-qm",
    "seed"
  );
  git(seed, "push", "-q", bare, "main");
  return bare;
}

describe("runner secondary repos (PILE-294)", () => {
  it("clones under ~/xrepo and pushes + opens a PR for write entries", () => {
    const root = mkdtempSync(join(tmpdir(), "pile-xrepo-"));
    const remotes = join(root, "remotes");
    const home = join(root, "home");
    mkdirSync(home);
    const vortex = makeRemote(remotes, "acme/vortex");
    makeRemote(remotes, "acme/docs");
    const harness = join(root, "harness.py");
    writeFileSync(harness, HARNESS);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      REPO: "acme/pile",
      BRANCH: LANE_BRANCH,
      GITHUB_TOKEN: TOKEN,
      ISSUE_TITLE: "Cross-repo fix",
      ISSUE_IDENTIFIER: "PILE-294",
      AGENT_LABEL: "Devin",
      GIT_AUTHOR_NAME: "Agent",
      GIT_AUTHOR_EMAIL: "agent@example.com",
      GIT_COMMITTER_NAME: "Agent",
      GIT_COMMITTER_EMAIL: "agent@example.com",
      SECONDARY_REPOS_JSON: JSON.stringify([
        { repo: "acme/vortex", access: "write", token: SECONDARY_TOKEN },
        { repo: "acme/docs", access: "read", token: SECONDARY_TOKEN },
      ]),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
      GIT_CONFIG_VALUE_0: `https://x-access-token:${SECONDARY_TOKEN}@github.com/`,
    };
    for (const key of [
      "PILE_LOG_URL",
      "PILE_LOG_TOKEN",
      "PILE_CACHE_URL",
      "PILE_TOKEN_URL",
      "LANE_TOKEN",
    ]) {
      delete env[key];
    }

    const out = execFileSync("python3", [harness, CORE_PATH], {
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    const line = out.split("\n").find((l) => l.startsWith("RESULT:"));
    if (!line) throw new Error(`harness emitted no RESULT line:\n${out}`);
    const res = JSON.parse(line.slice("RESULT:".length)) as {
      calls: Array<{
        method: string;
        path: string;
        repo: string | null;
        secondaryToken: boolean;
      }>;
      digest: { secondaryPrs?: Array<{ repo: string; prUrl: string }> };
      errors: string[];
      agentEnvKeys: string[];
      revoked: boolean[];
      remote: string;
    };

    expect(res.errors).toEqual([]);
    expect(existsSync(join(home, "xrepo", "acme", "docs", "README.md"))).toBe(
      true
    );
    expect(git(vortex, "log", "--format=%s", LANE_BRANCH)).toContain(
      `Devin changes for ${LANE_BRANCH}`
    );
    const posts = res.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.repo).toBe("acme/vortex");
    expect(res.digest.secondaryPrs).toEqual([
      { repo: "acme/vortex", prUrl: "https://github.com/acme/vortex/pull/7" },
    ]);
    // Secondary GitHub calls authenticate with that repo's own token.
    expect(res.calls.every((c) => c.secondaryToken)).toBe(true);
    expect(res.agentEnvKeys).not.toContain("SECONDARY_REPOS_JSON");
    expect(res.revoked).toEqual([true, true]);
    expect(res.remote).toBe("https://github.com/acme/vortex.git");
  });
});
