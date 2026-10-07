import { describe, expect, it } from "vitest";

import {
  AGENT_SESSION_STATUSES,
  DEFAULT_GIT_IDENTITY_REPO,
  ISSUE_PRIORITIES,
  ISSUE_RESOLUTIONS,
  ISSUE_STATUSES,
} from "./workspace.js";
import type { IssueInput } from "./workspace.js";

describe("workspace shared types", () => {
  it("keeps the issue picklist constants stable", () => {
    // Status order drives kanban column ordering; priorities feed sort keys.
    expect(ISSUE_STATUSES).toEqual([
      "triage",
      "backlog",
      "todo",
      "in_progress",
      "done",
      "canceled",
    ]);
    expect(ISSUE_PRIORITIES).toEqual(["low", "medium", "high", "urgent"]);
    expect(ISSUE_RESOLUTIONS).toEqual([
      "duplicate",
      "not_planned",
      "intended_behavior",
      "not_reproducible",
      "obsolete",
      "resolved",
    ]);
    expect(AGENT_SESSION_STATUSES).toEqual([
      "created",
      "running",
      "waiting",
      "completed",
      "failed",
      "canceled",
    ]);
    expect(DEFAULT_GIT_IDENTITY_REPO).toBe("*");
  });

  it("IssueInput accepts the PATCH-only prUrl/prState fields (PILE-316)", () => {
    // `satisfies` pins the fields at typecheck time (`vp check`); the runtime
    // assertions guard the values a PATCH body would carry.
    const link = {
      title: "Link a pull request",
      prUrl: "https://github.com/owner/repo/pull/7",
      prState: "open",
    } satisfies IssueInput;
    expect(link.prUrl).toBe("https://github.com/owner/repo/pull/7");
    expect(link.prState).toBe("open");

    const unlink = {
      title: "Unlink a pull request",
      prUrl: null,
      prState: null,
    } satisfies IssueInput;
    expect(unlink.prUrl).toBeNull();
    expect(unlink.prState).toBeNull();
  });
});
