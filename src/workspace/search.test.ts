import { insert } from "@orama/orama";
import { describe, expect, it } from "vitest";

import type { Issue } from "../types/workspace.js";
import {
  createWorkspaceSearchIndex,
  findDuplicateCandidates,
  issueToSearchDocument,
  titleOverlapScore,
} from "./search.js";

function issue(id: string, title: string, overrides: Partial<Issue> = {}) {
  return {
    id,
    organizationId: "org",
    externalRef: null,
    teamId: "team-a",
    title,
    description: null,
    status: "backlog",
    priority: "medium",
    resolution: null,
    parentId: null,
    subIssueSortOrder: null,
    estimate: null,
    isDraft: false,
    snoozedUntil: null,
    assigneeId: null,
    projectId: null,
    cycleId: null,
    labelIds: null,
    number: 1,
    identifier: `T-${id}`,
    repo: null,
    branch: null,
    prUrl: null,
    prState: null,
    prCheckState: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } satisfies Issue;
}

describe("titleOverlapScore", () => {
  it("is 1 for identical significant terms and ignores case/punctuation", () => {
    expect(
      titleOverlapScore(
        "Webhook retries: flood queue",
        "webhook RETRIES flood queue!"
      )
    ).toBe(1);
  });

  it("scores shared terms over the larger term set", () => {
    expect(
      titleOverlapScore(
        "Webhook retries flood the delivery queue",
        "Webhook delivery retries need backoff"
      )
    ).toBeCloseTo(0.6);
  });

  it("is 0 when either title has no significant terms", () => {
    expect(titleOverlapScore("Fix it", "Fix it")).toBe(0);
  });
});

describe("findDuplicateCandidates", () => {
  it("returns open, in-scope, close title matches best first", async () => {
    const index = createWorkspaceSearchIndex();
    await Promise.all(
      [
        issue("exact", "Webhook retries flood the delivery queue"),
        issue("close", "Webhook retries flooding the delivery queue"),
        issue("weak", "Webhook signing secret rotation"),
        issue("done", "Webhook retries flood the delivery queue", {
          status: "done",
        }),
        issue("other-team", "Webhook retries flood the delivery queue", {
          teamId: "team-b",
        }),
      ].map((row) => insert(index, issueToSearchDocument(row)))
    );

    const hits = await findDuplicateCandidates(
      index,
      "Webhook retries flood the delivery queue",
      ["team-a"]
    );
    expect(hits.map((hit) => hit.issueId)).toEqual(["exact", "close"]);
    expect(hits[0].score).toBe(1);
  });
});
