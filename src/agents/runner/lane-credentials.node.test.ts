import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Lane credential posture in the real runner core: the agent subprocess
// gets an allowlisted env, secrets are masked in everything printed, and
// the GitHub token is refreshed ahead of expiry and revoked at run end.

const CORE_PATH = join(import.meta.dirname, "core.py");
const GITHUB_TOKEN = "ghs_lanetoken0123456789abcdef";
const LANE_TOKEN = "lane-hmac-0123456789abcdef";

const HARNESS = `
import io
import json
import sys
import time
import types

core_path = sys.argv[1]
mod = types.ModuleType("pile_runner_core")
mod.__dict__["__file__"] = core_path
with open(core_path) as f:
    exec(compile(f.read(), core_path, "exec"), mod.__dict__)
g = mod.__dict__

captured = io.StringIO()
tee = g["_Tee"](captured)
tee.write("push https://x-access-token:" + g["GITHUB_TOKEN"] + "@github.com/acme/w.git\\n")
tee.write("lane " + g["os"].environ["LANE_TOKEN"] + "\\n")
tee.write("Authorization: Bearer abcdefghijklmnop\\n")
tee.write("github token refreshed\\n")

g["mask_credential_blob"](b'{"tokens": {"access_token": "codex-secret-value-1234567890"}}')
blob = g["_redact"]("auth codex-secret-value-1234567890")

env = g["agent_env_base"]({"CURSOR_API_KEY": "k"})

refreshes = []
g["refresh_github_token"] = lambda: refreshes.append(1)
g["GITHUB_TOKEN_EXPIRES_AT"] = time.time() + 3600
g["ensure_fresh_github_token"]()
fresh_calls = len(refreshes)
g["GITHUB_TOKEN_EXPIRES_AT"] = time.time() + 60
g["ensure_fresh_github_token"]()
stale_calls = len(refreshes)

revokes = []
def fake_urlopen(req, timeout=None):
    revokes.append({"url": req.full_url, "method": req.get_method(), "auth": req.get_header("Authorization")})
    return None
g["urllib"].request.urlopen = fake_urlopen
g["REPO"] = ""
g["revoke_github_token"]()
g["revoke_github_token"]()

out = {
    "captured": captured.getvalue(),
    "blob": blob,
    "envKeys": sorted(env.keys()),
    "freshCalls": fresh_calls,
    "staleCalls": stale_calls,
    "revokes": revokes,
    "tokenAfter": g["GITHUB_TOKEN"],
}
sys.__stdout__.write("RESULT:" + json.dumps(out) + "\\n")
`;

const harnessDir = mkdtempSync(join(tmpdir(), "pile-lane-cred-test-"));
const HARNESS_PATH = join(harnessDir, "harness.py");
writeFileSync(HARNESS_PATH, HARNESS);

interface HarnessResult {
  captured: string;
  blob: string;
  envKeys: string[];
  freshCalls: number;
  staleCalls: number;
  revokes: Array<{ url: string; method: string; auth: string }>;
  tokenAfter: string;
}

function runHarness(): HarnessResult {
  const out = execFileSync("python3", [HARNESS_PATH, CORE_PATH], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: tmpdir(),
      REPO: "acme/widgets",
      BRANCH: "issue-280",
      GITHUB_TOKEN,
      GITHUB_TOKEN_EXPIRES_AT: "2099-01-01T00:00:00Z",
      LANE_TOKEN,
      PILE_TOKEN_URL: "https://pile.test/token",
      DEVIN_CREDENTIALS_B64: "c2VjcmV0",
      RUNNER_PY_B64: "cnVubmVy",
      DATABASE_URL: "postgres://lane",
      UNLISTED_VAR: "nope",
      PILE_API_KEY: "pil_apikey",
      PILE_AGENT_ENV_KEYS: "DATABASE_URL,GITHUB_TOKEN",
    },
    timeout: 30_000,
  });
  const line = out.split("\n").find((l) => l.startsWith("RESULT:"));
  if (!line) throw new Error(`harness emitted no RESULT line:\n${out}`);
  return JSON.parse(line.slice("RESULT:".length)) as HarnessResult;
}

describe("runner lane credentials (PILE-280)", () => {
  const res = runHarness();

  it("masks tokens in everything the runner prints", () => {
    expect(res.captured).not.toContain(GITHUB_TOKEN);
    expect(res.captured).not.toContain(LANE_TOKEN);
    expect(res.captured).not.toContain("abcdefghijklmnop");
    expect(res.captured).toContain("@github.com/acme/w.git");
    expect(res.captured).toContain("github token refreshed");
  });

  it("masks values decoded from credential blobs", () => {
    expect(res.blob).toBe("auth ***");
  });

  it("passes only allowlisted env to the agent subprocess", () => {
    expect(res.envKeys).toEqual(
      expect.arrayContaining([
        "BRANCH",
        "CURSOR_API_KEY",
        "DATABASE_URL",
        "HOME",
        "PATH",
        "PILE_API_KEY",
        "REPO",
      ])
    );
    for (const key of [
      "GITHUB_TOKEN",
      "GITHUB_TOKEN_EXPIRES_AT",
      "LANE_TOKEN",
      "PILE_TOKEN_URL",
      "DEVIN_CREDENTIALS_B64",
      "RUNNER_PY_B64",
      "PILE_AGENT_ENV_KEYS",
      "UNLISTED_VAR",
    ]) {
      expect(res.envKeys).not.toContain(key);
    }
  });

  it("refreshes the GitHub token only when it nears expiry", () => {
    expect(res.freshCalls).toBe(0);
    expect(res.staleCalls).toBe(1);
  });

  it("revokes the GitHub token once at run end and drops it", () => {
    expect(res.revokes).toEqual([
      {
        url: "https://api.github.com/installation/token",
        method: "DELETE",
        auth: `Bearer ${GITHUB_TOKEN}`,
      },
    ]);
    expect(res.tokenAfter).toBe("");
  });
});
