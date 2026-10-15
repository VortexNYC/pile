import { describe, expect, it } from "vitest";

import {
  parseHandoffEvidence,
  parseHandoffOutputs,
  renderHandoffs,
  type HandoffView,
} from "./handoff.js";

// PILE-421 — the prompt-side view of agent_handoffs rows: parsing stored JSON
// and rendering the "Prior step handoffs" section dispatch injects into a
// step-scoped lane's context.

function row(overrides: Partial<HandoffView>): HandoffView {
  return {
    id: crypto.randomUUID(),
    stepKey: "sourced",
    nextAgent: null,
    outputs: "{}",
    evidence: null,
    createdAt: "2026-10-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("parseHandoffOutputs", () => {
  it("parses objects and rejects non-object JSON", () => {
    expect(parseHandoffOutputs('{"score":0.8}')).toEqual({ score: 0.8 });
    expect(parseHandoffOutputs("[1,2]")).toBeNull();
    expect(parseHandoffOutputs('"text"')).toBeNull();
    expect(parseHandoffOutputs("not json")).toBeNull();
  });
});

describe("parseHandoffEvidence", () => {
  it("keeps entries with a string ref and drops the rest", () => {
    const items = parseHandoffEvidence(
      JSON.stringify([
        { type: "document", ref: "doc-1", label: "Profile" },
        { ref: "https://example.com" },
        { type: "document" },
        "bogus",
        42,
      ])
    );
    expect(items).toEqual([
      { type: "document", ref: "doc-1", label: "Profile" },
      { ref: "https://example.com" },
    ]);
    expect(parseHandoffEvidence(null)).toEqual([]);
    expect(parseHandoffEvidence("{}")).toEqual([]);
    expect(parseHandoffEvidence("broken")).toEqual([]);
  });
});

describe("renderHandoffs", () => {
  it("renders each handoff under its step key with outputs, next agent, and evidence", () => {
    const text = renderHandoffs([
      row({
        stepKey: "sourced",
        nextAgent: "profiler",
        outputs: JSON.stringify({ score: 0.8, domain: "example.com" }),
        evidence: JSON.stringify([
          { type: "document", ref: "doc-1", label: "Source notes" },
          { ref: "https://example.com/profile" },
        ]),
      }),
      row({
        stepKey: "profiled",
        outputs: JSON.stringify({ icp: true }),
        createdAt: "2026-10-15T13:00:00.000Z",
      }),
    ]);

    expect(text).toContain("## Prior step handoffs");
    expect(text).toContain("### sourced (2026-10-15T12:00:00.000Z)");
    expect(text).toContain('"score": 0.8');
    expect(text).toContain("Next agent: profiler");
    expect(text).toContain("- [Source notes](doc-1) (document)");
    expect(text).toContain("- https://example.com/profile");
    expect(text).toContain("### profiled (2026-10-15T13:00:00.000Z)");
    // Chronological order is preserved — the caller sorts, not the renderer.
    expect(text.indexOf("### sourced")).toBeLessThan(
      text.indexOf("### profiled")
    );
  });

  it("degrades gracefully on unparsable stored output", () => {
    const text = renderHandoffs([row({ outputs: "not json" })]);
    expect(text).toContain("### sourced");
    expect(text).toContain("{}");
  });
});
