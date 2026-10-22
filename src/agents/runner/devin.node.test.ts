import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePython } from "./python";

// devin.py driver internals — credentials.toml, the lane MCP config, tool
// policy, permission mode, and the follow-up drain — exercised against the
// real script the same way other *.node.test.ts files drive core.py.

const CORE = join(import.meta.dirname, "core.py");
const DEVIN = join(import.meta.dirname, "devin.py");
const REAL_PYTHON = resolvePython();
const itPy = it.skipIf(REAL_PYTHON === null);

const HARNESS = `
import json, os, stat, sys, types

core_path, devin_path, scenario, out_path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
mod = types.ModuleType("pile_runner_devin")
mod.__dict__["__file__"] = core_path
for p in (core_path, devin_path):
    with open(p) as f:
        exec(compile(f.read(), p, "exec"), mod.__dict__)
d = mod.__dict__
home = os.environ["HOME"]
result = {}

if scenario == "creds":
    d["write_devin_home"](os.environ["DEVIN_CREDENTIALS_B64"])
    path = os.path.join(home, ".local", "share", "devin", "credentials.toml")
    result["exists"] = os.path.exists(path)
    result["mode"] = oct(stat.S_IMODE(os.stat(path).st_mode))
    with open(path, "rb") as f:
        result["content"] = f.read().decode()
elif scenario == "mcp":
    cfg_dir = os.path.join(home, ".config", "devin")
    os.makedirs(cfg_dir, exist_ok=True)
    with open(os.path.join(cfg_dir, "mcp_config.json"), "w") as f:
        json.dump({"mcpServers": {"other": {"serverUrl": "https://x"}}}, f)
    d["write_lane_mcp_config"]()
    path = os.path.join(cfg_dir, "mcp_config.json")
    cfg = json.load(open(path))
    result["servers"] = sorted(cfg["mcpServers"].keys())
    result["lane"] = cfg["mcpServers"].get("pile-lane")
    result["mode"] = oct(stat.S_IMODE(os.stat(path).st_mode))
elif scenario == "mcp_absent":
    d["write_lane_mcp_config"]()
    path = os.path.join(home, ".config", "devin", "mcp_config.json")
    result["exists"] = os.path.exists(path)
elif scenario == "perm":
    result["mode"] = d["permission_mode"]()
elif scenario == "policy":
    d["apply_tool_policy"]()
    path = os.path.join(home, ".config", "devin", "config.json")
    result["exists"] = os.path.exists(path)
    if result["exists"]:
        cfg = json.load(open(path))
        result["deny"] = cfg.get("permissions", {}).get("deny")
elif scenario == "drain_norepo":
    # Follow-up drain on a repo-less lane: commit_and_push must not run
    # (empty BRANCH fails validate_branch) — the bug this test pins.
    os.makedirs(d["REPO_DIR"], exist_ok=True)
    os.makedirs("/tmp/pile", exist_ok=True)
    os.makedirs(d["FOLLOWUP_DIR"], exist_ok=True)
    for i in (1, 2):
        open(os.path.join(d["FOLLOWUP_DIR"], "f%d.prompt" % i), "w").write("follow up %d" % i)
    out = d["drain_followups"](os.environ["DEVIN_STUB_BIN"])
    names = os.listdir(d["FOLLOWUP_DIR"])
    result["leftover"] = [n for n in names if n.endswith(".prompt")]
    result["consumed"] = len([n for n in names if n.endswith((".drained", ".injected"))])
    result["ok"] = True
    result["output_tail"] = (out or "")[-120:]

with open(out_path, "w") as f:
    f.write(json.dumps(result))
`;

function runDevin(
  scenario: string,
  env: Record<string, string>
): Record<string, unknown> {
  if (!REAL_PYTHON) return {};
  const home = mkdtempSync(join(tmpdir(), "pile-devin-"));
  const out = join(home, "out.json");
  const script = join(home, "harness.py");
  writeFileSync(script, HARNESS);
  execFileSync(REAL_PYTHON, [script, CORE, DEVIN, scenario, out], {
    env: { ...process.env, HOME: home, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return JSON.parse(
    execFileSync(
      REAL_PYTHON,
      ["-c", `import json;print(open(${JSON.stringify(out)}).read())`],
      {
        encoding: "utf8",
      }
    ).trim()
  );
}

describe("devin.py driver", () => {
  itPy("write_devin_home lands credentials.toml decoded and 0600", () => {
    const r = runDevin("creds", {
      DEVIN_CREDENTIALS_B64: Buffer.from('token = "abc123"').toString("base64"),
    });
    expect(r.exists).toBe(true);
    expect(r.mode).toBe("0o600");
    expect(r.content).toBe('token = "abc123"');
  });

  itPy(
    "write_lane_mcp_config merges pile-lane into existing servers with a bearer header",
    () => {
      const r = runDevin("mcp", {
        PILE_LANE_MCP_URL: "https://pile.test/mcp/lane",
        LANE_TOKEN: "lane-tok-1",
      });
      expect(r.servers).toEqual(["other", "pile-lane"]);
      expect(r.lane).toEqual({
        serverUrl: "https://pile.test/mcp/lane",
        headers: { Authorization: "Bearer lane-tok-1" },
      });
      expect(r.mode).toBe("0o600");
    }
  );

  itPy("write_lane_mcp_config is a no-op without the lane MCP env", () => {
    const r = runDevin("mcp_absent", {});
    expect(r.exists).toBe(false);
  });

  itPy(
    "permission_mode is accept-edits only when the lane shell is disabled",
    () => {
      expect(runDevin("perm", { PILE_SHELL_POLICY: "disabled" }).mode).toBe(
        "accept-edits"
      );
      expect(runDevin("perm", { PILE_SHELL_POLICY: "enabled" }).mode).toBe(
        "dangerous"
      );
      expect(runDevin("perm", { PILE_SHELL_POLICY: "restricted" }).mode).toBe(
        "dangerous"
      );
    }
  );

  itPy("apply_tool_policy denies exec only under shell=disabled", () => {
    const off = runDevin("policy", { PILE_SHELL_POLICY: "disabled" });
    expect(off.exists).toBe(true);
    expect(off.deny).toContain("exec");
    const on = runDevin("policy", { PILE_SHELL_POLICY: "enabled" });
    expect(on.exists).toBe(false);
  });

  itPy(
    "drain_followups on a repo-less lane drains queued prompts without crashing",
    () => {
      if (!REAL_PYTHON) return;
      const home = mkdtempSync(join(tmpdir(), "pile-devin-drain-"));
      // Stub devin binary: devin's argv is -p --prompt-file PATH ... — echo
      // the prompt to prove the turn ran, exit clean.
      const bin = join(home, "devin-stub");
      writeFileSync(bin, '#!/bin/sh\ncat "$3"\necho stub-done\n');
      chmodSync(bin, 0o755);
      const r = runDevin("drain_norepo", {
        DEVIN_STUB_BIN: bin,
        DEVIN_CREDENTIALS_B64: Buffer.from('token = "x"').toString("base64"),
        REPO: "",
        BRANCH: "",
        PILE_PUSH_POLICY: "enabled",
      });
      expect(r.ok).toBe(true);
      expect(r.leftover).toEqual([]);
      expect(r.consumed).toBeGreaterThanOrEqual(2);
    }
  );
});
