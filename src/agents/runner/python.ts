import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

// Resolve a real CPython for the runner *.node.test.ts harnesses. Bare
// "python3" is not trustworthy on a dev machine's PATH — it can be a version
// shim (pyenv/asdf/mise), a venv wrapper, the macOS CLT stub, or even a JS
// binary that chokes on the .py harness with a V8 SyntaxError instead of a
// Python one (PILE-317). Probing sys.executable yields the interpreter behind
// any forwarding shim, and spawning that absolute path skips PATH lookup
// entirely. $PYTHON wins over both candidates so a broken default can be
// overridden.
// The probe prints one marker-prefixed JSON line so version noise, banner
// output from shims, and CRLF endings can't shift or corrupt the fields.
const PROBE_MARKER = "PILE_PY=";
const PROBE_SCRIPT =
  'import json,sys;print("' +
  PROBE_MARKER +
  '"+json.dumps([sys.version_info[0],sys.executable]))';

export function resolvePython(): string | null {
  const candidates = [process.env.PYTHON, "python3", "python"];
  for (const bin of candidates) {
    if (!bin) continue;
    try {
      const out = execFileSync(bin, ["-c", PROBE_SCRIPT], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      });
      const line = out.split(/\r?\n/).find((l) => l.startsWith(PROBE_MARKER));
      const parsed = line
        ? (JSON.parse(line.slice(PROBE_MARKER.length)) as unknown)
        : null;
      if (
        Array.isArray(parsed) &&
        typeof parsed[0] === "number" &&
        parsed[0] >= 3 &&
        typeof parsed[1] === "string" &&
        isAbsolute(parsed[1]) &&
        existsSync(parsed[1])
      ) {
        return parsed[1];
      }
    } catch {
      // Not a usable CPython — try the next candidate.
    }
  }
  return null;
}
