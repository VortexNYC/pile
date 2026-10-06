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
export function resolvePython(): string | null {
  const candidates = [process.env.PYTHON, "python3", "python"];
  for (const bin of candidates) {
    if (!bin) continue;
    try {
      const [major, exe] = execFileSync(
        bin,
        ["-c", "import sys; print(sys.version_info[0]); print(sys.executable)"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 10_000,
        }
      ).split("\n");
      if (Number(major) >= 3 && exe && isAbsolute(exe) && existsSync(exe)) {
        return exe;
      }
    } catch {
      // Not a usable CPython — try the next candidate.
    }
  }
  return null;
}
