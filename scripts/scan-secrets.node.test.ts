import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanRepo } from "./scan-secrets";

// PILE-457 — the repo-side gate for the incident: tracked .devin/ paths and
// 64-hex bearer tokens in Authorization headers must never survive
// `pnpm run scan:secrets`.
const TOKEN = "a1b2c3d4".repeat(8);

let dir: string | null = null;

function repo(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "scan-secrets-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("scanRepo (PILE-457)", () => {
  it("flags a tracked .devin/mcp_config.json", () => {
    const findings = scanRepo(
      repo({ ".devin/mcp_config.json": `{"token":"${TOKEN}"}` })
    );
    expect(findings).toEqual([
      { rule: "devin-agent-config-dir", path: ".devin/mcp_config.json" },
    ]);
  });

  it("flags nested .devin/ dirs but allows committed skills and rules", () => {
    const findings = scanRepo(
      repo({
        "vendor/pkg/.devin/config.json": "{}",
        ".devin/skills/pile-cli/SKILL.md": "# skill",
        ".devin/rules/style.md": "# rule",
        "src/ok.ts": "export const x = 1;",
      })
    );
    expect(findings).toEqual([
      {
        rule: "devin-agent-config-dir",
        path: "vendor/pkg/.devin/config.json",
      },
    ]);
  });

  it("flags a 64-hex bearer token in an Authorization header", () => {
    const findings = scanRepo(
      repo({
        "notes.md": `curl -H "Authorization: Bearer ${TOKEN}" https://x`,
        "src/ok.ts": "export const x = 1;",
      })
    );
    expect(findings).toEqual([
      { rule: "lane-bearer-token", path: "notes.md", line: 1 },
    ]);
  });

  it("does not flag short/non-hex bearers or variable references", () => {
    const findings = scanRepo(
      repo({
        "a.ts": "fetch(u, { headers: { Authorization: `Bearer ${token}` } })",
        "b.md": "Authorization: Bearer abc123",
        "c.md": `Bearer ${"z".repeat(64)}`,
      })
    );
    expect(findings).toEqual([]);
  });

  it("ignores untracked .devin/ files — gitignored runtime config", () => {
    const root = repo({ "src/ok.ts": "export const x = 1;" });
    mkdirSync(join(root, ".devin"), { recursive: true });
    writeFileSync(join(root, ".devin/mcp_config.json"), `{"t":"${TOKEN}"}`);
    expect(scanRepo(root)).toEqual([]);
  });
});
