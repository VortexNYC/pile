import { describe, expect, it } from "vitest";

import { emojiToIssuePatch } from "./emoji.js";

describe("emojiToIssuePatch", () => {
  it("maps done emoji to done status", () => {
    expect(emojiToIssuePatch("white_check_mark")).toEqual({
      status: "done",
    });
    expect(emojiToIssuePatch("✅")).toEqual({
      status: "done",
    });
  });

  it("maps in-progress emoji to in_progress status", () => {
    expect(emojiToIssuePatch("eyes")).toEqual({
      status: "in_progress",
    });
  });

  it("maps canceled emoji to canceled status", () => {
    expect(emojiToIssuePatch("stop_sign")).toEqual({
      status: "canceled",
    });
  });

  it("maps urgent emoji to urgent priority", () => {
    expect(emojiToIssuePatch("fire")).toEqual({
      priority: "urgent",
    });
  });

  it("maps snooze emoji to a future snoozedUntil", () => {
    const before = Date.now();
    const patch = emojiToIssuePatch("sleeping");
    const after = Date.now();
    expect(patch).toBeDefined();
    const snoozed = Date.parse(patch!.snoozedUntil ?? "");
    expect(snoozed).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect(snoozed).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000);
  });

  it("returns undefined for unmapped emoji", () => {
    expect(emojiToIssuePatch("thumbs_up")).toBeUndefined();
  });
});
