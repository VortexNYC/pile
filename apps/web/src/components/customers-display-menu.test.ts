import { describe, expect, it } from "vitest";

import {
  CUSTOMER_COLUMN_DEFS,
  SHEET_COLOR_SWATCHES,
  densityClasses,
  isColumnVisible,
  normalizeSheetColor,
  sheetRowStyle,
} from "./customers-display-menu.js";

describe("CUSTOMER_COLUMN_DEFS", () => {
  it("covers every toggleable column exactly once", () => {
    const keys = CUSTOMER_COLUMN_DEFS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      "category",
      "owner",
      "phone",
      "location",
      "signal",
      "score",
      "added",
    ]);
  });
});

describe("SHEET_COLOR_SWATCHES", () => {
  it("only offers 6-digit hex colors so row tints stay deterministic", () => {
    expect(SHEET_COLOR_SWATCHES.length).toBe(8);
    for (const swatch of SHEET_COLOR_SWATCHES) {
      expect(swatch.value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("normalizeSheetColor", () => {
  it("accepts palette hexes and rejects anything else", () => {
    expect(normalizeSheetColor("#22c55e")).toBe("#22c55e");
    expect(normalizeSheetColor("#ABCDEF")).toBe("#ABCDEF");
    expect(normalizeSheetColor("red")).toBeUndefined();
    expect(normalizeSheetColor("#fff")).toBeUndefined();
    expect(normalizeSheetColor("#12345")).toBeUndefined();
    expect(normalizeSheetColor("")).toBeUndefined();
    expect(normalizeSheetColor(null)).toBeUndefined();
    expect(normalizeSheetColor(undefined)).toBeUndefined();
  });
});

describe("sheetRowStyle", () => {
  it("paints a left stripe plus a translucent tint for a colored sheet", () => {
    const style = sheetRowStyle("#3b82f6");
    expect(style?.backgroundImage).toContain("#3b82f6 0px");
    expect(style?.backgroundImage).toContain("#3b82f6 3px");
    expect(style?.backgroundImage).toContain("#3b82f614");
  });

  it("returns undefined for uncolored or invalid colors", () => {
    expect(sheetRowStyle(undefined)).toBeUndefined();
    expect(sheetRowStyle(null)).toBeUndefined();
    expect(sheetRowStyle("orange")).toBeUndefined();
  });
});

describe("densityClasses", () => {
  it("defaults to the comfortable text size and padding", () => {
    expect(densityClasses(undefined)).toEqual({
      table: "text-xs",
      cellY: "py-1.5",
    });
    expect(densityClasses("comfortable").table).toBe("text-xs");
  });

  it("tightens text and padding in compact mode", () => {
    const compact = densityClasses("compact");
    expect(compact.table).toBe("text-[11px]");
    expect(compact.cellY).toBe("py-1");
  });
});

describe("isColumnVisible", () => {
  it("shows every column when nothing is hidden", () => {
    for (const col of CUSTOMER_COLUMN_DEFS) {
      expect(isColumnVisible(undefined, col.key)).toBe(true);
      expect(isColumnVisible([], col.key)).toBe(true);
    }
  });

  it("hides only the listed columns", () => {
    expect(isColumnVisible(["phone"], "phone")).toBe(false);
    expect(isColumnVisible(["phone"], "owner")).toBe(true);
  });
});
