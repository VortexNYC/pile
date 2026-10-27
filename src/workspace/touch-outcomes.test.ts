import { describe, expect, it } from "vitest";

import {
  CUSTOMER_TOUCH_OUTCOMES,
  isCustomerTouchOutcome,
  OUTCOME_DEFAULTS,
  outcomeDefaultDueAt,
  outcomeStatusKeys,
  outcomeToStatusKey,
  resolveNextStep,
  resolveOutcomeStatusId,
} from "./touch-outcomes.js";

describe("CUSTOMER_TOUCH_OUTCOMES", () => {
  it("covers the canonical knock vocabulary", () => {
    expect(CUSTOMER_TOUCH_OUTCOMES).toEqual([
      "talked",
      "sent_info",
      "needs_email",
      "quoted",
      "callback",
      "no_answer",
      "not_interested",
      "spam",
    ]);
    for (const outcome of CUSTOMER_TOUCH_OUTCOMES) {
      expect(OUTCOME_DEFAULTS[outcome].label.length).toBeGreaterThan(0);
    }
  });
});

describe("isCustomerTouchOutcome", () => {
  it("accepts only known outcomes", () => {
    expect(isCustomerTouchOutcome("talked")).toBe(true);
    expect(isCustomerTouchOutcome("left_card")).toBe(false);
    expect(isCustomerTouchOutcome(42)).toBe(false);
    expect(isCustomerTouchOutcome(null)).toBe(false);
  });
});

describe("outcomeToStatusKey / outcomeStatusKeys", () => {
  it("maps progress outcomes onto stage keys", () => {
    expect(outcomeToStatusKey("talked")).toBe("discovery");
    expect(outcomeToStatusKey("quoted")).toBe("proposal");
    expect(outcomeToStatusKey("not_interested")).toBe("lost");
    expect(outcomeToStatusKey("spam")).toBe("lost");
  });

  it("never advances stage for callback or no_answer", () => {
    expect(outcomeToStatusKey("callback")).toBeUndefined();
    expect(outcomeToStatusKey("no_answer")).toBeUndefined();
    expect(outcomeStatusKeys("callback")).toEqual([]);
  });
});

describe("resolveOutcomeStatusId", () => {
  const statuses = [
    { id: "s-prospect", key: "prospect", name: "Prospect" },
    { id: "s-outreach", key: "outreach", name: "Outreach" },
    { id: "s-discovery", key: "discovery", name: "Discovery" },
    { id: "s-lost", key: "lost", name: "Lost" },
  ];

  it("resolves the primary key to the workspace status id", () => {
    expect(resolveOutcomeStatusId("talked", statuses)).toBe("s-discovery");
    expect(resolveOutcomeStatusId("not_interested", statuses)).toBe("s-lost");
  });

  it("falls back through the key chain when a stage is missing", () => {
    const noDiscovery = statuses.filter((s) => s.key !== "discovery");
    expect(resolveOutcomeStatusId("talked", noDiscovery)).toBe("s-outreach");
  });

  it("matches statuses that only carry a slugged name, no key", () => {
    const keyless = [{ id: "s-x", key: null, name: "Proposal Sent" }];
    expect(resolveOutcomeStatusId("quoted", keyless)).toBeUndefined();
    const genericLost = [{ id: "s-dead", key: null, name: "Dead" }];
    expect(resolveOutcomeStatusId("spam", genericLost)).toBe("s-dead");
  });

  it("returns undefined when no stage in the chain exists", () => {
    expect(resolveOutcomeStatusId("quoted", [])).toBeUndefined();
    expect(resolveOutcomeStatusId("no_answer", statuses)).toBeUndefined();
  });
});

describe("outcomeDefaultDueAt", () => {
  const now = new Date("2026-10-26T12:00:00.000Z");

  it("offsets by the outcome's dueInDays", () => {
    expect(outcomeDefaultDueAt("callback", now)).toBe(
      "2026-10-28T12:00:00.000Z"
    );
    expect(outcomeDefaultDueAt("needs_email", now)).toBe(
      "2026-10-27T12:00:00.000Z"
    );
  });

  it("returns undefined for outcomes without a default due", () => {
    expect(outcomeDefaultDueAt("not_interested", now)).toBeUndefined();
    expect(outcomeDefaultDueAt("spam", now)).toBeUndefined();
  });
});

describe("resolveNextStep", () => {
  const now = new Date("2026-10-26T12:00:00.000Z");

  it("applies outcome defaults when the caller passes nothing", () => {
    expect(resolveNextStep("callback", {}, now)).toEqual({
      nextStepText: "Call back",
      nextStepDueAt: "2026-10-28T12:00:00.000Z",
    });
  });

  it("clears the pending step on terminal outcomes", () => {
    expect(resolveNextStep("not_interested", {}, now)).toEqual({
      nextStepText: null,
      nextStepDueAt: null,
    });
  });

  it("explicit body values win, including null clears", () => {
    expect(
      resolveNextStep(
        "callback",
        {
          nextStepText: "Call back Tuesday",
          nextStepDueAt: "2026-10-27T00:00:00.000Z",
        },
        now
      )
    ).toEqual({
      nextStepText: "Call back Tuesday",
      nextStepDueAt: "2026-10-27T00:00:00.000Z",
    });
    expect(resolveNextStep("talked", { nextStepText: null }, now)).toEqual({
      nextStepText: null,
      nextStepDueAt: "2026-10-28T12:00:00.000Z",
    });
  });
});
