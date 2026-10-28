import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// PILE-460 — the `vortex-devin-runner` Daytona snapshot kept shipping with a
// devin CLI install that could silently fail (`|| true`), producing sandboxes
// that start but can never run the agent. These assertions pin the hardening:
// a pinned base image, a strict install, and a build-time version check.
const dockerfilePath = path.join(
  import.meta.dirname ?? ".",
  "..",
  "Dockerfile.sandbox-devin-daytona"
);
const dockerfile = readFileSync(dockerfilePath, "utf8");

describe("Dockerfile.sandbox-devin-daytona", () => {
  it("uses a pinned daytonaio/sandbox base tag, not latest/untagged", () => {
    const from = dockerfile.match(/^FROM\s+(\S+)/m);
    expect(from).not.toBeNull();
    const image = from?.[1] ?? "";
    expect(image).toMatch(/^daytonaio\/sandbox:/);
    expect(image).not.toMatch(/:latest$/);
  });

  it("has no soft-fail guard on the devin CLI install", () => {
    const installRun = dockerfile
      .split(/\n(?=RUN )/)
      .find((block) => block.includes("cli.devin.ai/install.sh"));
    expect(installRun).toBeDefined();
    expect(installRun).not.toMatch(/\|\|\s*(true|echo)/);
  });

  it("verifies the installed binary at build time", () => {
    expect(dockerfile).toMatch(/test -x\s+\S*devin/);
    expect(dockerfile).toMatch(/devin --version/);
  });
});
