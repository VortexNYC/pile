// PILE-457 — lane bearer tokens are sha256 hex injected into agent sandboxes;
// a worker that writes .devin/mcp_config.json into the checkout leaks one per
// run. These rules mirror .gitleaks.toml (which external scanners consume) so
// `pnpm run scan:secrets` — pre-commit, the lane stop hook, and any CI that
// runs `vp run check` — blocks on the incident pattern, not just the
// secretlint preset. Only git-tracked files are scanned: .devin/ is
// gitignored, so an untracked mcp_config.json is the devin CLI's own runtime
// config, not a committable leak.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEVIN_PATH = /(^|\/)\.devin\//;
const DEVIN_ALLOW = /(^|\/)\.devin\/(skills|rules)\//;
const LANE_BEARER = /authorization["']?\s*[:=]\s*["']?bearer\s+[a-f0-9]{64,}/i;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export type SecretFinding = {
  rule: "devin-agent-config-dir" | "lane-bearer-token";
  path: string;
  line?: number;
};

function trackedPaths(root: string): string[] {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((p) => p.length > 0);
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function scanRepo(root: string): SecretFinding[] {
  let paths: string[];
  try {
    paths = trackedPaths(root);
  } catch {
    // No .git (e.g. a source tarball) means no commit surface to protect.
    console.warn(
      "scan-secrets: not a git checkout — skipping tracked-file scan"
    );
    return [];
  }
  const findings: SecretFinding[] = [];
  for (const path of paths) {
    if (DEVIN_PATH.test(path) && !DEVIN_ALLOW.test(path)) {
      findings.push({ rule: "devin-agent-config-dir", path });
      continue; // a banned path needs no content finding on top
    }
    let buf: Buffer;
    try {
      buf = readFileSync(join(root, path));
    } catch {
      continue; // staged deletion, submodule gitlink, etc.
    }
    if (buf.length > MAX_FILE_BYTES || isBinary(buf)) continue;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (LANE_BEARER.test(lines[i] ?? "")) {
        findings.push({ rule: "lane-bearer-token", path, line: i + 1 });
        break; // one finding per file is enough to block
      }
    }
  }
  return findings;
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedAsScript) {
  const findings = scanRepo(process.cwd());
  if (findings.length > 0) {
    for (const f of findings) {
      const where = f.line !== undefined ? `${f.path}:${f.line}` : f.path;
      // Path + rule only — never echo the matched secret.
      console.error(`scan-secrets: ${f.rule} — ${where}`);
    }
    process.exit(1);
  }
}
