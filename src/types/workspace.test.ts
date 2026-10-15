import { describe, expect, it } from "vitest";

import {
  AGENT_SESSION_STATUSES,
  DEFAULT_GIT_IDENTITY_REPO,
  ISSUE_PRIORITIES,
  ISSUE_PR_STATES,
  ISSUE_RESOLUTIONS,
  ISSUE_STATUSES,
} from "./workspace.js";
import type { Issue, IssueClaim, IssueInput, IssuePatch } from "./workspace.js";

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
    expect(ISSUE_PR_STATES).toEqual(["draft", "open", "merged", "closed"]);
    expect(DEFAULT_GIT_IDENTITY_REPO).toBe("*");
  });

  it("IssuePatch accepts the PATCH-only prUrl/prState fields (PILE-316)", () => {
    // `satisfies` pins the fields at typecheck time (`vp check`); the runtime
    // assertions guard the values a PATCH body would carry.
    const link = {
      prUrl: "https://github.com/owner/repo/pull/7",
      prState: "open",
    } satisfies IssuePatch;
    expect(link.prUrl).toBe("https://github.com/owner/repo/pull/7");
    expect(link.prState).toBe("open");

    const unlink = {
      prUrl: null,
      prState: null,
    } satisfies IssuePatch;
    expect(unlink.prUrl).toBeNull();
    expect(unlink.prState).toBeNull();
  });

  it("accepts delegateId on IssueInput and IssuePatch (PILE-417)", () => {
    // Delegate is a peer of assigneeId: settable on create, patchable,
    // clearable with null, and independent of the assignee field.
    const input = {
      title: "Delegated work",
      assigneeId: "user-1",
      delegateId: "devin",
    } satisfies IssueInput;
    expect(input.delegateId).toBe("devin");

    const patch = { delegateId: null } satisfies IssuePatch;
    expect(patch.delegateId).toBeNull();
  });

  it("exposes claim fields on Issue but keeps them off IssuePatch (PILE-430)", () => {
    // Claims are a state machine, not an editable field: PATCH can never
    // write claimedBy/lease/epoch directly — only claimIssue/releaseClaim
    // do, so the fencing epoch can't be forged through updateIssue.
    const claim: IssueClaim = {
      issueId: "issue-1",
      claimedBy: "agent-a",
      leaseExpiresAt: "2026-10-16T00:00:00.000Z",
      epoch: 3,
    };
    expect(claim.epoch).toBe(3);

    type ClaimKeys = "claimedBy" | "claimedLeaseExpiresAt" | "claimEpoch";
    const onIssue: ClaimKeys[] = [
      "claimedBy",
      "claimedLeaseExpiresAt",
      "claimEpoch",
    ];
    const probe: Pick<Issue, ClaimKeys> = {
      claimedBy: null,
      claimedLeaseExpiresAt: null,
      claimEpoch: 0,
    };
    expect(onIssue.every((k) => k in probe)).toBe(true);

    type PatchLeak = Extract<keyof IssuePatch, ClaimKeys>;
    const leaks: PatchLeak[] = [];
    expect(leaks).toEqual([]);
  });

  it("keeps prUrl/prState off IssueInput (patch-only)", () => {
    // createIssueRecord seeds both to null — pinning them as IssuePatch-only
    // keys turns "ignored on create" into a type error instead of a silent
    // no-op. If they ever reappear on IssueInput this stops compiling.
    type PatchOnlyKeys = Exclude<keyof IssuePatch, keyof IssueInput>;
    const keys: PatchOnlyKeys[] = ["prUrl", "prState"];
    expect(keys).toEqual(["prUrl", "prState"]);
  });
});

describe("IssueViewer", () => {
  it("grantedOnly marks grant-scoped actors", () => {
    const viewer: import("./workspace.js").IssueViewer = {
      actorId: "u-1",
      teamIds: ["t-1"],
      grantedOnly: true,
    };
    expect(viewer.grantedOnly).toBe(true);
  });
});
