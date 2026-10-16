import { describe, expect, it } from "vitest";

import {
  evaluateTriageConditions,
  parseTriageAction,
  parseTriageConditions,
  serializeTriageAction,
  serializeTriageConditions,
  type TriageRecordView,
} from "./triage-rules.js";

function view(overrides: Partial<TriageRecordView> = {}): TriageRecordView {
  return {
    recordType: "lead",
    recordId: "rec-1",
    text: "",
    ...overrides,
  };
}

describe("evaluateTriageConditions", () => {
  it("matches an empty conditions object against anything", () => {
    expect(evaluateTriageConditions({}, view())).toBe(true);
  });

  it("ANDs across condition keys, ORs within each array", () => {
    const conditions = {
      sources: ["form", "web"],
      keywords: ["pricing"],
      customerDomains: ["acme.com"],
    };
    expect(
      evaluateTriageConditions(
        conditions,
        view({
          text: "asking about pricing",
          source: "form",
          customerEmail: "owner@acme.com",
        })
      )
    ).toBe(true);
    // Source outside the OR list fails the whole match.
    expect(
      evaluateTriageConditions(
        conditions,
        view({
          text: "asking about pricing",
          source: "api",
          customerEmail: "owner@acme.com",
        })
      )
    ).toBe(false);
    // Keyword miss fails too.
    expect(
      evaluateTriageConditions(
        conditions,
        view({
          text: "hello",
          source: "form",
          customerEmail: "owner@acme.com",
        })
      )
    ).toBe(false);
  });

  it("matches keywords case-insensitively across the record text", () => {
    expect(
      evaluateTriageConditions(
        { keywords: ["URGENT"] },
        view({ text: "this is urgent help" })
      )
    ).toBe(true);
  });

  it("matches labelIds when any rule label is on the record", () => {
    expect(
      evaluateTriageConditions(
        { labelIds: ["l1", "l2"] },
        view({ labelIds: ["l2", "l9"] })
      )
    ).toBe(true);
    expect(
      evaluateTriageConditions({ labelIds: ["l1"] }, view({ labelIds: ["l9"] }))
    ).toBe(false);
    expect(evaluateTriageConditions({ labelIds: ["l1"] }, view())).toBe(false);
  });

  it("requires every field condition to pass, with normalized names", () => {
    const conditions = {
      fields: [{ field: "hardware-needed", equals: true }, { field: "region" }],
    };
    expect(
      evaluateTriageConditions(
        conditions,
        view({ fields: { hardwareNeeded: true, region: "nyc" } })
      )
    ).toBe(true);
    expect(
      evaluateTriageConditions(
        conditions,
        view({ fields: { hardwareNeeded: false, region: "nyc" } })
      )
    ).toBe(false);
    // Falsy field values fail truthy-only conditions.
    expect(
      evaluateTriageConditions(
        { fields: [{ field: "region" }] },
        view({ fields: { region: "" } })
      )
    ).toBe(false);
  });
});

describe("serialize/parse round trip", () => {
  it("round-trips conditions", () => {
    const conditions = { keywords: ["bug"], fields: [{ field: "plan" }] };
    expect(
      parseTriageConditions(serializeTriageConditions(conditions))
    ).toEqual(conditions);
  });

  it("round-trips a delegate action", () => {
    const action = {
      type: "delegate" as const,
      agentId: "scout",
      status: "triage" as const,
      dispatch: false,
    };
    expect(parseTriageAction(serializeTriageAction(action))).toEqual(action);
  });

  it("round-trips a set_status action", () => {
    const action = { type: "set_status" as const, status: "qualified" };
    expect(parseTriageAction(serializeTriageAction(action))).toEqual(action);
  });

  it("rejects unknown action types", () => {
    expect(() =>
      parseTriageAction(JSON.stringify({ type: "email_everyone" }))
    ).toThrow();
  });
});
