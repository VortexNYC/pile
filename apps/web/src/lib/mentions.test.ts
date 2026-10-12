import { describe, expect, it } from "vitest";

import { filterMentionTargets, mentionQuery, mentionTargets } from "./mentions";

describe("mentionTargets", () => {
  it("maps member rows to mention targets via user", () => {
    const out = mentionTargets([
      {
        id: "member-1",
        user: { id: "u-1", name: "Ronny Vortex", email: "ronny@vortex.nyc" },
      },
    ]);
    expect(out).toEqual([
      { id: "u-1", name: "Ronny Vortex", email: "ronny@vortex.nyc" },
    ]);
  });

  it("drops rows without a user payload", () => {
    expect(mentionTargets([{ id: "member-x", userId: "u-x" }])).toEqual([]);
    expect(mentionTargets(undefined)).toEqual([]);
  });
});

describe("mentionQuery", () => {
  it("reads the handle being typed at the tail", () => {
    expect(mentionQuery("cc @ronn")).toBe("ronn");
    expect(mentionQuery("hello")).toBeNull();
    expect(mentionQuery("a @b and c")).toBeNull();
  });
});

describe("filterMentionTargets", () => {
  const targets = [
    { id: "u-1", name: "Ronny Vortex", email: "ronny@vortex.nyc" },
    { id: "u-2", name: "Shlomo Kab", email: "shlomo@vortex.nyc" },
  ];

  it("matches name-dash and email local handles", () => {
    expect(filterMentionTargets(targets, "ronny")).toEqual([targets[0]]);
    expect(filterMentionTargets(targets, "ronny-v")).toEqual([targets[0]]);
    expect(filterMentionTargets(targets, "shl")).toEqual([targets[1]]);
    expect(filterMentionTargets(targets, "")).toEqual(targets);
    expect(filterMentionTargets(targets, "zzz")).toEqual([]);
  });
});
