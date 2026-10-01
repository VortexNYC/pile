import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// PILE-281: the runner keeps substrate secrets to itself. lane_env() is the
// env every agent/setup-hook subprocess runs under; restricted mode puts a
// git/network policy shim ahead of the real binaries on that env's PATH.

const CORE_PATH = join(import.meta.dirname, "core.py");

// Execs core.py into a namespace, then either dumps lane_env() as JSON or
// runs a command under it and reports {code, out}.
const HARNESS = `
import json
import subprocess
import sys
import types

core_path, mode = sys.argv[1], sys.argv[2]
mod = types.ModuleType("pile_runner_core")
with open(core_path) as f:
    exec(compile(f.read(), core_path, "exec"), mod.__dict__)
ns = mod.__dict__
keep = tuple(k for k in sys.argv[3].split(",") if k) if len(sys.argv) > 3 else ()

if mode == "env":
    out = ns["lane_env"](keep=keep)
elif mode == "git-auth":
    out = ns["git_auth_env"]({})
elif mode == "check":
    tool, args = sys.argv[4], json.loads(sys.argv[5])
    out = {"reason": ns["guard_check"](tool, args, ["github.com"], {})}
else:
    cmd = json.loads(sys.argv[4])
    r = subprocess.run(cmd, env=ns["lane_env"](keep=keep), capture_output=True, text=True)
    out = {"code": r.returncode, "out": r.stdout + r.stderr}
sys.__stdout__.write("RESULT:" + json.dumps(out) + "\\n")
`;

const harnessDir = mkdtempSync(join(tmpdir(), "pile-lane-env-test-"));
const HARNESS_PATH = join(harnessDir, "harness.py");
writeFileSync(HARNESS_PATH, HARNESS);

const SECRETS = {
  GITHUB_TOKEN: "ghs_dispatch",
  LANE_TOKEN: "lane-token",
  PILE_LOG_TOKEN: "log-token",
  PILE_TOKEN_URL: "https://pile.test/token",
  CURSOR_API_KEY: "cursor-key",
  DEVIN_CREDENTIALS_B64: "ZGV2aW4=",
  CODEX_AUTH_JSON_B64: "Y29kZXg=",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  DAYTONA_API_KEY: "daytona-key",
  NPM_TOKEN: "npm-allowlisted",
};

function harnessEnv(
  guardDir: string,
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const controlled: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: guardDir,
    PILE_GUARD_DIR: join(guardDir, "guard"),
    REPO: "acme/widgets",
    BRANCH: "issue-281",
    GIT_AUTHOR_NAME: "Lane Bot",
    PILE_API_URL: "https://pile.test",
    PILE_API_KEY: "pil_readonly",
    PILE_AGENT_ENV_PASSTHROUGH: "PILE_API_URL,PILE_API_KEY,NPM_TOKEN",
    ...SECRETS,
    ...extra,
  };
  // Only the controlled keys — nothing ambient from the test host.
  const env: NodeJS.ProcessEnv = { ...process.env, ...controlled };
  for (const key of Object.keys(env)) {
    if (!(key in controlled)) delete env[key];
  }
  return env;
}

function harness(
  mode: "env" | "git-auth" | "run" | "check",
  args: string[],
  extra: Record<string, string> = {}
): { guardDir: string; result: Record<string, unknown> } {
  const guardDir = mkdtempSync(join(tmpdir(), "pile-lane-"));
  const out = execFileSync(
    "python3",
    [HARNESS_PATH, CORE_PATH, mode, ...args],
    { encoding: "utf8", env: harnessEnv(guardDir, extra), timeout: 30_000 }
  );
  const line = out.split("\n").find((l) => l.startsWith("RESULT:"));
  if (!line) throw new Error(`harness emitted no RESULT line:\n${out}`);
  return {
    guardDir,
    result: JSON.parse(line.slice("RESULT:".length)) as Record<string, unknown>,
  };
}

function runUnder(
  cmd: string[],
  options: { restricted?: boolean; keep?: string } = {}
): { code: number; out: string } {
  const { result } = harness(
    "run",
    [options.keep ?? "", JSON.stringify(cmd)],
    options.restricted ? { PILE_LANE_RESTRICTED: "1" } : {}
  );
  return result as { code: number; out: string };
}

function guardReason(tool: string, args: string[]): string | null {
  const { result } = harness("check", ["", tool, JSON.stringify(args)]);
  return result.reason as string | null;
}

describe("lane_env secret scrubbing (PILE-281)", () => {
  it("strips runner secrets and secret-shaped vars, keeps passthrough", () => {
    const { result: env } = harness("env", []);
    for (const key of [
      "GITHUB_TOKEN",
      "LANE_TOKEN",
      "PILE_LOG_TOKEN",
      "PILE_TOKEN_URL",
      "CURSOR_API_KEY",
      "DEVIN_CREDENTIALS_B64",
      "CODEX_AUTH_JSON_B64",
      "AWS_SECRET_ACCESS_KEY",
      "DAYTONA_API_KEY",
      "PILE_AGENT_ENV_PASSTHROUGH",
    ]) {
      expect(env, key).not.toHaveProperty(key);
    }
    expect(env.PILE_API_KEY).toBe("pil_readonly");
    expect(env.PILE_API_URL).toBe("https://pile.test");
    expect(env.NPM_TOKEN).toBe("npm-allowlisted");
    expect(env.GIT_AUTHOR_NAME).toBe("Lane Bot");
    expect(env).not.toHaveProperty("PILE_LANE_RESTRICTED");
  });

  it("a kept credential reaches the agent but not the shells it spawns", () => {
    const { result: env } = harness("env", ["CURSOR_API_KEY"]);
    expect(env.CURSOR_API_KEY).toBe("cursor-key");
    const res = runUnder(
      [
        "bash",
        "-c",
        'echo "key=${CURSOR_API_KEY:-unset} gh=${GITHUB_TOKEN:-unset}"',
      ],
      { keep: "CURSOR_API_KEY" }
    );
    expect(res.out.trim()).toBe("key=unset gh=unset");
  });

  it("authenticates runner git via GIT_CONFIG_* instead of the remote URL", () => {
    const { result: env } = harness("git-auth", []);
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${btoa("x-access-token:ghs_dispatch")}`
    );
  });

  it("leaves git/curl unguarded outside restricted mode", () => {
    const res = runUnder(["git", "push", "--dry-run", "nowhere"]);
    expect(res.out).not.toContain("pile restricted mode");
  });
});

describe("restricted-mode command guard (PILE-281)", () => {
  it("blocks git push through the PATH shim and allows local git", () => {
    const push = runUnder(["git", "push", "origin", "issue-281"], {
      restricted: true,
    });
    expect(push.code).toBe(126);
    expect(push.out).toContain("pile restricted mode: blocked — git push");
    const version = runUnder(["git", "--version"], { restricted: true });
    expect(version.code).toBe(0);
    expect(version.out).toMatch(/^git version/);
  });

  it("blocks egress to hosts off the allowlist and records the allowlist", () => {
    const res = runUnder(
      ["curl", "-fsSLo", "/dev/null", "https://evil.example.com/x"],
      { restricted: true }
    );
    expect(res.code).toBe(126);
    expect(res.out).toContain("evil.example.com");
    const { guardDir } = harness("env", [], { PILE_LANE_RESTRICTED: "1" });
    const hosts = readFileSync(
      join(guardDir, "guard", "allowed-hosts"),
      "utf8"
    ).split(",");
    expect(hosts).toContain("github.com");
    expect(hosts).toContain("pile.test");
  });

  it("refuses gh and ssh-family tools outright", () => {
    expect(runUnder(["gh", "pr", "list"], { restricted: true }).code).toBe(126);
    expect(guardReason("ssh", ["git@github.com"])).toContain("not allowed");
  });

  it.each([
    [["push", "origin", "main"], "git push"],
    [["remote", "set-url", "origin", "https://evil"], "git remote set-url"],
    [["config", "remote.origin.url", "https://evil"], "git config"],
    [["config", "credential.helper", "store"], "git config"],
    [["-c", "credential.helper=!cat", "fetch"], "-c credential.helper"],
    [["-c", "alias.p=push", "p"], "-c alias.p"],
    [["clone", "git@evil.com:x/y.git"], "evil.com"],
    [["fetch", "https://evil.com/x.git"], "evil.com"],
  ])("blocks git %j", (args, reason) => {
    expect(guardReason("git", args)).toContain(reason);
  });

  it.each([
    [["status"]],
    [["remote", "-v"]],
    [["fetch", "origin", "main:main"]],
    [["-C", "/repo", "commit", "-m", "x"]],
    [["clone", "https://github.com/acme/widgets.git"]],
  ])("allows git %j", (args) => {
    expect(guardReason("git", args)).toBeNull();
  });

  it.each([
    [["https://evil.com/x"], "evil.com"],
    [["evil.com"], "evil.com"],
    [["-x", "http://proxy", "https://github.com"], "-x"],
    [
      ["--resolve", "github.com:443:1.2.3.4", "https://github.com"],
      "--resolve",
    ],
    [["-K", "cfg"], "-K"],
  ])("blocks curl %j", (args, reason) => {
    expect(guardReason("curl", args)).toContain(reason);
  });

  it.each([
    [["-H", "Authorization: Bearer x", "https://github.com/a"]],
    [["-fsSLo", "out.json", "https://github.com/a"]],
    [["http://localhost:3000/health"]],
    [["--url", "https://api.github.com/repos"]],
  ])("allows curl %j", (args) => {
    expect(guardReason("curl", args)).toBeNull();
  });
});
