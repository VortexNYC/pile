import { describe, expect, it } from "vitest";

import {
  CUSTOMER_TOUCH_OUTCOMES,
  OUTCOME_DEFAULTS,
} from "../../../../src/workspace/touch-outcomes.js";
import {
  dateInputToIso,
  LOG_TOUCH_OUTCOME_OPTIONS,
  nextStepPrefill,
} from "./log-touch-dialog";

describe("LOG_TOUCH_OUTCOME_OPTIONS (PILE-651)", () => {
  it("exposes every canonical outcome with its label", () => {
    expect(LOG_TOUCH_OUTCOME_OPTIONS.map((o) => o.value)).toEqual([
      ...CUSTOMER_TOUCH_OUTCOMES,
    ]);
    for (const opt of LOG_TOUCH_OUTCOME_OPTIONS) {
      expect(opt.label).toBe(OUTCOME_DEFAULTS[opt.value].label);
    }
  });
});

describe("nextStepPrefill", () => {
  it("seeds the outcome's default text and due date", () => {
    const prefill = nextStepPrefill("callback");
    expect(prefill.text).toBe("Call back");
    expect(Date.parse(`${prefill.date}T00:00:00`)).toBeGreaterThan(Date.now());
  });

  it("prefills nothing for terminal outcomes", () => {
    expect(nextStepPrefill("not_interested")).toEqual({ text: "", date: "" });
    expect(nextStepPrefill("spam")).toEqual({ text: "", date: "" });
  });
});

describe("dateInputToIso", () => {
  it("converts a date input value to ISO at local day start", () => {
    const iso = dateInputToIso("2026-10-30");
    expect(iso).not.toBeNull();
    expect(iso).toContain("2026-10-30");
  });

  it("returns null for empty or unparseable input", () => {
    expect(dateInputToIso("")).toBeNull();
    expect(dateInputToIso("not-a-date")).toBeNull();
  });
});
