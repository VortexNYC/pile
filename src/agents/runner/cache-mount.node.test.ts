import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePython } from "./python";

// PILE-306: with the repo's shared cache bucket mounted at PILE_CACHE_DIR,
// the runner warms/saves the lockfile-keyed pnpm-store tarball through the
// mount instead of the HTTP cache.

const CORE_PATH = join(import.meta.dirname, "core.py");
const PYTHON = resolvePython();
const describePy = describe.skipIf(PYTHON === null);

const HARNESS = `
import sys, types
core_path, fn = sys.argv[1], sys.argv[2]
mod = types.ModuleType("pile_runner_core")
mod.__dict__["__file__"] = core_path
with open(core_path) as f:
    exec(compile(f.read(), core_path, "exec"), mod.__dict__)
mod.__dict__[fn]()
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pile-cache-mount-"));
  const home = join(root, "home");
  const store = join(root, "store");
  const mount = join(root, "mount");
  const lock = "lockfileVersion: '9.0'\n";
  mkdirSync(join(home, "repo"), { recursive: true });
  mkdirSync(store);
  mkdirSync(mount);
  writeFileSync(join(home, "repo", "pnpm-lock.yaml"), lock);
  writeFileSync(join(store, "pkg.txt"), "cached-package");
  writeFileSync(join(root, "harness.py"), HARNESS);
  const hash = createHash("sha256").update(lock).digest("hex");
  const run = (fn: "warm_pnpm_store" | "save_pnpm_store") => {
    if (!PYTHON) throw new Error("unreachable: suite skipped without CPython");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      REPO: "",
      PILE_CACHE_DIR: mount,
      npm_config_store_dir: store,
    };
    delete env.PILE_CACHE_URL;
    delete env.PILE_LOG_URL;
    delete env.PILE_LOG_TOKEN;
    return execFileSync(PYTHON, [join(root, "harness.py"), CORE_PATH, fn], {
      encoding: "utf8",
      env,
      timeout: 30_000,
    });
  };
  return { root, store, mount, hash, run };
}

describePy("runner pnpm-store cache via mounted bucket (PILE-306)", () => {
  it("saves the store to the mount and warms a cold store from it", () => {
    const { store, mount, hash, run } = setup();
    expect(run("save_pnpm_store")).toContain("saved to mount");
    const tarball = join(mount, "pnpm-store", `${hash}.tar.gz`);
    expect(existsSync(tarball)).toBe(true);
    expect(readdirSync(join(mount, "pnpm-store"))).toEqual([`${hash}.tar.gz`]);

    rmSync(store, { recursive: true });
    expect(run("warm_pnpm_store")).toContain("warm hit");
    expect(readFileSync(join(store, "pkg.txt"), "utf8")).toBe("cached-package");
  });

  it("does not re-upload a store a sibling lane already shared", () => {
    const { mount, hash, run } = setup();
    mkdirSync(join(mount, "pnpm-store"));
    const tarball = join(mount, "pnpm-store", `${hash}.tar.gz`);
    writeFileSync(tarball, "sibling");
    expect(run("save_pnpm_store")).toContain("already on mount");
    expect(readFileSync(tarball, "utf8")).toBe("sibling");
  });

  it("treats a zero-byte tarball (a sibling mid-upload) as a miss", () => {
    const { store, mount, hash, run } = setup();
    mkdirSync(join(mount, "pnpm-store"));
    const tarball = join(mount, "pnpm-store", `${hash}.tar.gz`);
    writeFileSync(tarball, "");
    expect(run("warm_pnpm_store")).not.toContain("warm hit");
    expect(run("save_pnpm_store")).toContain("saved to mount");
    expect(readdirSync(join(mount, "pnpm-store"))).toEqual([`${hash}.tar.gz`]);
    rmSync(store, { recursive: true });
    expect(run("warm_pnpm_store")).toContain("warm hit");
  });

  it("survives a read-only mount without leaving partial files", () => {
    const { mount, run } = setup();
    chmodSync(mount, 0o555);
    try {
      const out = run("save_pnpm_store");
      if (process.getuid?.() !== 0) {
        expect(out).toContain("mount save failed");
      }
      expect(existsSync(join(mount, "pnpm-store"))).toBe(
        process.getuid?.() === 0
      );
    } finally {
      chmodSync(mount, 0o755);
    }
  });
});
