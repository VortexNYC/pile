import { describe, expect, it } from "vitest";

import type { AppEnv } from "../types/env.js";
import {
  DEFAULT_LANE_PERMISSIONS,
  fetchLanePermissions,
  laneTokenPermissions,
  LOCKED_LANE_PERMISSIONS,
  parsePileRepoConfig,
  resolveLanePermissions,
} from "./pile-repo-config.js";

describe("lane permission policy (PILE-276)", () => {
  it("parses push/shell tiers with per-provider overrides", () => {
    const config = parsePileRepoConfig({
      permissions: {
        push: "restricted",
        shell: "restricted",
        providers: { "devin-cli": { shell: "disabled" } },
      },
    });
    expect(config).not.toBeNull();
    expect(resolveLanePermissions(config, "cursor-cli")).toEqual({
      push: "restricted",
      shell: "restricted",
    });
    expect(resolveLanePermissions(config, "devin-cli")).toEqual({
      push: "restricted",
      shell: "disabled",
    });
  });

  it("rejects unknown tier values", () => {
    expect(parsePileRepoConfig({ permissions: { push: "sometimes" } })).toBe(
      null
    );
  });

  it("defaults every tier to enabled when unset", () => {
    expect(resolveLanePermissions(null, "cursor-cli")).toEqual(
      DEFAULT_LANE_PERMISSIONS
    );
    expect(
      resolveLanePermissions(parsePileRepoConfig({ agents: ["x"] }), "x")
    ).toEqual(DEFAULT_LANE_PERMISSIONS);
  });

  it("downscopes the lane token by push tier", () => {
    expect(laneTokenPermissions("disabled")).toEqual({
      contents: "read",
      metadata: "read",
    });
    expect(laneTokenPermissions("restricted")).toEqual({
      contents: "write",
      pull_requests: "write",
      metadata: "read",
    });
    expect(laneTokenPermissions("enabled")).toBeUndefined();
  });

  it("fails closed when the repo policy can't be read", async () => {
    const res = await fetchLanePermissions(
      {} as AppEnv,
      "acme/widgets",
      "cursor-cli"
    );
    expect(res.permissions).toEqual(LOCKED_LANE_PERMISSIONS);
    expect(res.lockedReason).toContain("unreadable");
  });
});

describe("preview config (PILE-310)", () => {
  it("parses preview.port and rejects a non-port value", () => {
    const cfg = parsePileRepoConfig({ preview: { port: 3000 } });
    expect(cfg?.preview?.port).toBe(3000);
    expect(parsePileRepoConfig({ preview: { port: "3000" } })).toBeNull();
    expect(parsePileRepoConfig({ preview: { port: -1 } })).toBeNull();
    expect(parsePileRepoConfig({})).not.toBeNull();
  });
});

describe("repo triggers (PILE-272)", () => {
  it("accepts review and conflict trigger events", () => {
    const triggers = parsePileRepoConfig({
      triggers: [
        { on: "pr.review", agent: "devin", prompt: "Answer the review." },
        { on: "pr.changes_requested", agent: "devin", prompt: "Address it." },
        { on: "pr.conflict", agent: "devin", prompt: "Resolve conflicts." },
      ],
    })?.triggers;
    expect(triggers?.map((t) => t.on)).toEqual([
      "pr.review",
      "pr.changes_requested",
      "pr.conflict",
    ]);
  });
});
