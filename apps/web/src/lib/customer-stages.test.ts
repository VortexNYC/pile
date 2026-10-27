import { describe, expect, it } from "vitest";

import {
  CUSTOMER_STAGES,
  normalizeHexColor,
  orderedStages,
  stageColor,
  stageKeyOf,
  stageRowTint,
} from "./customer-stages.js";

describe("CUSTOMER_STAGES", () => {
  it("is ordered, unique, and every stage has a palette hex color", () => {
    const keys = CUSTOMER_STAGES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const stage of CUSTOMER_STAGES) {
      expect(stage.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(stage.label.length).toBeGreaterThan(0);
    }
  });

  it("progresses from sky (prospect) through emerald (passed) to rose (lost)", () => {
    expect(CUSTOMER_STAGES[0]).toMatchObject({
      key: "prospect",
      color: "#38bdf8",
    });
    expect(CUSTOMER_STAGES.at(-2)).toMatchObject({
      key: "passed",
      color: "#10b981",
    });
    expect(CUSTOMER_STAGES.at(-1)).toMatchObject({
      key: "lost",
      color: "#f43f5e",
    });
  });
});

describe("stageKeyOf", () => {
  it("prefers the immutable key and falls back to slugging the name", () => {
    expect(stageKeyOf({ name: "Prospecting", key: "outreach" })).toBe(
      "outreach"
    );
    expect(stageKeyOf({ name: "Onboarding go-live", key: null })).toBe(
      "onboarding_go_live"
    );
    expect(stageKeyOf({ name: "  Drip — Nurture  ", key: null })).toBe(
      "drip_nurture"
    );
    expect(stageKeyOf(null)).toBe("");
    expect(stageKeyOf(undefined)).toBe("");
  });
});

describe("stageColor", () => {
  it("uses the status's own color override when it is a valid hex", () => {
    expect(
      stageColor({ name: "Prospect", key: "prospect", color: "#123456" })
    ).toBe("#123456");
  });

  it("maps canonical stage keys to their semantic colors", () => {
    expect(stageColor({ name: "Prospect", key: "prospect", color: null })).toBe(
      "#38bdf8"
    );
    expect(stageColor({ name: "Passed", key: "passed", color: null })).toBe(
      "#10b981"
    );
    expect(stageColor({ name: "Lost", key: "lost", color: null })).toBe(
      "#f43f5e"
    );
  });

  it("maps generic sheet vocabulary to the same color story", () => {
    expect(stageColor({ name: "Won", key: "won", color: null })).toBe(
      "#10b981"
    );
    expect(stageColor({ name: "Nurture", key: "nurture", color: null })).toBe(
      "#a1a1aa"
    );
    expect(
      stageColor({ name: "Negotiating", key: "negotiating", color: null })
    ).toBe("#f97316");
  });

  it("slugs unknown display names when no key exists", () => {
    // "Onboarding go-live" with no stored key still lands on its canonical
    // color because the name slugs to the canonical key.
    expect(
      stageColor({ name: "Onboarding go-live", key: null, color: null })
    ).toBe("#14b8a6");
  });

  it("falls back to a deterministic palette for custom stages", () => {
    const first = stageColor({ name: "Legal review", key: null, color: null });
    const again = stageColor({ name: "Legal review", key: null, color: null });
    expect(first).toBe(again);
    expect(first).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("returns undefined when the row has no stage", () => {
    expect(stageColor(null)).toBeUndefined();
    expect(stageColor(undefined)).toBeUndefined();
  });
});

describe("stageRowTint", () => {
  it("paints a left stripe plus a translucent tint for a staged row", () => {
    const style = stageRowTint({
      name: "Prospect",
      key: "prospect",
      color: null,
    });
    expect(style?.backgroundImage).toContain("#38bdf8 0px");
    expect(style?.backgroundImage).toContain("#38bdf8 3px");
    expect(style?.backgroundImage).toContain("#38bdf814");
  });

  it("returns undefined for unstaged rows", () => {
    expect(stageRowTint(null)).toBeUndefined();
    expect(stageRowTint(undefined)).toBeUndefined();
  });
});

describe("orderedStages", () => {
  it("sorts by pipeline position without mutating the input", () => {
    const input = [
      { id: "b", position: 4 },
      { id: "a", position: 0 },
      { id: "c", position: 2 },
    ];
    expect(orderedStages(input).map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(input[0]?.id).toBe("b");
  });
});

describe("normalizeHexColor", () => {
  it("accepts 6-digit hexes and rejects anything else", () => {
    expect(normalizeHexColor("#22c55e")).toBe("#22c55e");
    expect(normalizeHexColor("#ABCDEF")).toBe("#ABCDEF");
    expect(normalizeHexColor("red")).toBeUndefined();
    expect(normalizeHexColor("#fff")).toBeUndefined();
    expect(normalizeHexColor("")).toBeUndefined();
    expect(normalizeHexColor(null)).toBeUndefined();
    expect(normalizeHexColor(undefined)).toBeUndefined();
  });
});
