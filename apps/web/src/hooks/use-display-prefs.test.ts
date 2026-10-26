import { describe, expect, it } from "vitest";

import { mergeDisplayPreferences } from "./use-display-prefs.js";

describe("mergeDisplayPreferences", () => {
  it("creates the surface entry when none exists", () => {
    expect(
      mergeDisplayPreferences(null, "customers", { density: "compact" })
    ).toEqual({ customers: { density: "compact" } });
  });

  it("merges into the target surface without dropping existing keys", () => {
    const existing = {
      customers: { sheetColors: { trades: "#22c55e" } },
    };
    expect(
      mergeDisplayPreferences(existing, "customers", { density: "compact" })
    ).toEqual({
      customers: {
        sheetColors: { trades: "#22c55e" },
        density: "compact",
      },
    });
  });

  it("leaves other surfaces untouched", () => {
    const existing = {
      customers: { density: "compact" as const },
      issues: { hiddenColumns: ["assignee"] },
    };
    const merged = mergeDisplayPreferences(existing, "customers", {
      hiddenColumns: ["phone"],
    });
    expect(merged.issues).toEqual({ hiddenColumns: ["assignee"] });
    expect(merged.customers).toEqual({
      density: "compact",
      hiddenColumns: ["phone"],
    });
  });

  it("overwrites a key when the patch sets it again", () => {
    const existing = { customers: { density: "compact" as const } };
    expect(
      mergeDisplayPreferences(existing, "customers", {
        density: "comfortable",
      })
    ).toEqual({ customers: { density: "comfortable" } });
  });
});
