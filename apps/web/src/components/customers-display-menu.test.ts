import { describe, expect, it } from "vitest";

import {
  CUSTOMER_COLUMN_DEFS,
  densityClasses,
  isColumnVisible,
} from "./customers-display-menu.js";

describe("CUSTOMER_COLUMN_DEFS", () => {
  it("covers every toggleable column exactly once", () => {
    const keys = CUSTOMER_COLUMN_DEFS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      "category",
      "stage",
      "owner",
      "phone",
      "location",
      "signal",
      "score",
      "added",
    ]);
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
    expect(isColumnVisible(["stage"], "stage")).toBe(false);
    expect(isColumnVisible(["phone"], "owner")).toBe(true);
  });
});
