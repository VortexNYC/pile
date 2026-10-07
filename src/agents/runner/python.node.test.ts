import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePython } from "./python";

// PILE-317 — a dev machine's `python3` may not be CPython at all (version
// shims, the macOS CLT stub, or a JS binary that dies on the .py harness
// with a V8 SyntaxError). resolvePython must see through wrappers and must
// return null — not a broken path — when no real interpreter exists.

const REAL_PYTHON = resolvePython();
const itPy = it.skipIf(REAL_PYTHON === null);

describe("resolvePython (PILE-317)", () => {
  itPy("returns an interpreter that actually executes a script file", () => {
    if (!REAL_PYTHON) return; // unreachable — narrowed for TS
    const dir = mkdtempSync(join(tmpdir(), "pile-py-"));
    const script = join(dir, "probe.py");
    writeFileSync(script, "print('ok')\n");
    expect(
      execFileSync(REAL_PYTHON, [script], { encoding: "utf8" }).trim()
    ).toBe("ok");
  });

  itPy("bypasses a PATH python3 that is not CPython via $PYTHON", () => {
    if (!REAL_PYTHON) return; // unreachable — narrowed for TS
    const dir = mkdtempSync(join(tmpdir(), "pile-py-shim-"));
    const impostor = join(dir, "python3");
    writeFileSync(impostor, "#!/usr/bin/env node\nthrow 1\n");
    chmodSync(impostor, 0o755);
    const wrapper = join(dir, "forwarded-python");
    writeFileSync(wrapper, `#!/bin/sh\nexec ${REAL_PYTHON} "$@"\n`);
    chmodSync(wrapper, 0o755);

    const saved = { PATH: process.env.PATH, PYTHON: process.env.PYTHON };
    try {
      process.env.PATH = dir;
      delete process.env.PYTHON;
      expect(resolvePython()).toBeNull();
      process.env.PYTHON = wrapper;
      expect(resolvePython()).toBe(REAL_PYTHON);
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.PYTHON === undefined) delete process.env.PYTHON;
      else process.env.PYTHON = saved.PYTHON;
    }
  });

  itPy("parses past wrapper banner noise and CRLF endings", () => {
    if (!REAL_PYTHON) return; // unreachable — narrowed for TS
    // A forwarding wrapper that chatters on stdout before delegating, with
    // CRLF appended to every answer line — both must parse cleanly.
    const dir = mkdtempSync(join(tmpdir(), "pile-py-noise-"));
    const noisy = join(dir, "python3");
    writeFileSync(
      noisy,
      `#!/bin/sh\necho "shim banner noise"\n${JSON.stringify(REAL_PYTHON)} "$@" | sed 's/$/\\r/'\n`
    );
    chmodSync(noisy, 0o755);

    const saved = { PATH: process.env.PATH, PYTHON: process.env.PYTHON };
    try {
      process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
      delete process.env.PYTHON;
      expect(resolvePython()).toBe(REAL_PYTHON);
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.PYTHON === undefined) delete process.env.PYTHON;
      else process.env.PYTHON = saved.PYTHON;
    }
  });
});
