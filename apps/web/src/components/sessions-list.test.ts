import { describe, expect, it } from "vitest";

import {
  AGENT_SESSIONS_LIST_QUERY,
  SESSIONS_POLL_MS,
  groupSessionsByScope,
  scopeGroupTitle,
} from "./sessions-list";

const lane = (
  agentId: string,
  issueId: string,
  updatedAt: string,
  label?: string
) => ({ agentId, issueId, updatedAt, label });

describe("groupSessionsByScope", () => {
  it("buckets lanes under the agent that ran them", () => {
    const groups = groupSessionsByScope(
      [
        lane("scout", "iss-1", "2026-10-20T00:00:00Z"),
        lane("swe", "iss-2", "2026-10-21T00:00:00Z"),
        lane("scout", "iss-3", "2026-10-19T00:00:00Z"),
      ],
      "agent"
    );
    expect(groups.map(([key, rows]) => [key, rows.length])).toEqual([
      ["swe", 1],
      ["scout", 2],
    ]);
  });

  it("buckets lanes under their issue so the Issues index files each lane", () => {
    const groups = groupSessionsByScope(
      [
        lane("scout", "iss-1", "2026-10-20T00:00:00Z"),
        lane("swe", "iss-1", "2026-10-21T00:00:00Z"),
        lane("swe", "iss-2", "2026-10-19T00:00:00Z"),
      ],
      "issue"
    );
    expect(groups.map(([key, rows]) => [key, rows.length])).toEqual([
      ["iss-1", 2],
      ["iss-2", 1],
    ]);
  });

  it("orders groups freshest-lane-first, keeping input order inside a bucket", () => {
    const groups = groupSessionsByScope(
      [
        lane("old", "iss-1", "2026-10-10T00:00:00Z"),
        lane("new", "iss-2", "2026-10-21T00:00:00Z"),
        lane("mid", "iss-3", "2026-10-15T00:00:00Z"),
        lane("old", "iss-1", "2026-10-11T00:00:00Z"),
      ],
      "agent"
    );
    expect(groups.map(([key]) => key)).toEqual(["new", "mid", "old"]);
    const oldRows = groups.find(([key]) => key === "old")?.[1];
    expect(oldRows?.map((r) => r.updatedAt)).toEqual([
      "2026-10-10T00:00:00Z",
      "2026-10-11T00:00:00Z",
    ]);
  });

  it("ranks a group by its freshest lane, not its first row", () => {
    // `ordered` puts non-terminal lanes first — a stale live lane must not
    // pin its group above fresher work.
    const groups = groupSessionsByScope(
      [
        lane("live", "iss-1", "2026-10-10T00:00:00Z"),
        lane("done", "iss-2", "2026-10-20T00:00:00Z"),
        lane("live", "iss-3", "2026-10-21T00:00:00Z"),
      ],
      "agent"
    );
    expect(groups.map(([key]) => key)).toEqual(["live", "done"]);
  });

  it("returns no groups for an empty list", () => {
    expect(groupSessionsByScope([], "agent")).toEqual([]);
  });
});

describe("scopeGroupTitle", () => {
  it("prefers the workspace display name for the scope key", () => {
    expect(
      scopeGroupTitle("iss-1", [lane("a", "iss-1", "t", "Lane label")], {
        "iss-1": "ISS-1 — Fix thing",
      })
    ).toBe("ISS-1 — Fix thing");
  });

  it("falls back to the lane label for UUID scope keys", () => {
    expect(
      scopeGroupTitle("b4a98d95-c75e-4be9-802a-f2028e64f27d", [
        lane("a", "i", "t", "Refactor runner"),
      ])
    ).toBe("Refactor runner");
  });

  it("shows a readable scope key over the lane label", () => {
    // "scout" names the agent group; the first lane's label would misname
    // it after one issue.
    expect(
      scopeGroupTitle("scout", [lane("a", "i", "t", "scout/iss-3-fix")])
    ).toBe("scout");
  });

  it("falls back to the raw scope key last", () => {
    expect(scopeGroupTitle("agent-uuid", [lane("a", "i", "t")])).toBe(
      "agent-uuid"
    );
    expect(scopeGroupTitle("agent-uuid", [])).toBe("agent-uuid");
  });
});

describe("AGENT_SESSIONS_LIST_QUERY (PILE-645)", () => {
  it("locks the summary-row fetch contract (no result/activity blobs)", () => {
    expect(AGENT_SESSIONS_LIST_QUERY).toEqual({
      summary: "1",
      limit: "200",
    });
  });
});

describe("SESSIONS_POLL_MS (PILE-653)", () => {
  it("keeps the dedicated-surface cadence at 3s", () => {
    expect(SESSIONS_POLL_MS).toBe(3000);
  });
});
