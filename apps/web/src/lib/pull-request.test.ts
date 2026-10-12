import { describe, expect, it } from "vitest";

import { isPrHistoryField, prChip, prRef } from "./pull-request";

const none = { prUrl: null, prState: null, prCheckState: null };
const withState = (prState: string) =>
  prChip({ ...none, prUrl: "https://github.com/a/b/pull/1", prState });
const withCheck = (prCheckState: string) =>
  prChip({ prUrl: null, prState: "open", prCheckState });

describe("prRef", () => {
  it("reads GitHub pull and GitLab merge request numbers", () => {
    expect(prRef("https://github.com/acme/app/pull/42")).toBe("#42");
    expect(prRef("https://github.com/acme/app/pull/42/files")).toBe("#42");
    expect(prRef("https://gitlab.com/acme/app/-/merge_requests/7")).toBe("!7");
  });
  it("returns null for unknown or unsafe URLs", () => {
    expect(prRef("https://example.com/review/9")).toBeNull();
    expect(prRef("javascript:alert(1)//pull/1")).toBeNull();
    expect(prRef(null)).toBeNull();
  });
});

describe("prChip", () => {
  it("is absent when no PR is linked", () => {
    expect(prChip(none)).toBeNull();
    expect(prChip({ ...none, prCheckState: "success" })).toBeNull();
  });
  it("maps each PR state to a label and color", () => {
    expect(withState("open")).toMatchObject({
      label: "Open",
      variant: "green",
    });
    expect(withState("draft")).toMatchObject({
      label: "Draft",
      variant: "neutral",
    });
    expect(withState("merged")).toMatchObject({
      label: "Merged",
      variant: "purple",
    });
    expect(withState("closed")).toMatchObject({
      label: "Closed",
      variant: "red",
    });
  });
  it("falls back to a linked chip when the state is unknown", () => {
    expect(
      prChip({ ...none, prUrl: "https://github.com/a/b/pull/3", prState: "x" })
    ).toMatchObject({ state: null, label: "Linked", ref: "#3", check: null });
  });
  it("carries the CI dot", () => {
    expect(withCheck("success")).toMatchObject({
      check: "success",
      checkLabel: "CI passing",
    });
    expect(withCheck("failure")?.checkLabel).toBe("CI failing");
    expect(withCheck("pending")?.checkLabel).toBe("CI running");
    expect(withCheck("neutral")?.check).toBe("unknown");
  });
  it("never links a non-http URL", () => {
    expect(
      prChip({ ...none, prUrl: "javascript:alert(1)", prState: "open" })?.href
    ).toBeNull();
    expect(prChip({ ...none, prUrl: "javascript:alert(1)" })).toBeNull();
  });
});

describe("isPrHistoryField", () => {
  it("flags only PR linkage fields", () => {
    expect(isPrHistoryField("pr_url")).toBe(true);
    expect(isPrHistoryField("pr_state")).toBe(true);
    expect(isPrHistoryField("pr_check_state")).toBe(true);
    expect(isPrHistoryField("status")).toBe(false);
  });
});
