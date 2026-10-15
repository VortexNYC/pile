import { describe, expect, it } from "vitest";

import {
  guidanceRefs,
  parseGuidanceLinks,
  renderGuidancePacks,
  type ResolvedGuidancePack,
} from "./guidance.js";

function pack(overrides: Partial<ResolvedGuidancePack>): ResolvedGuidancePack {
  return {
    id: crypto.randomUUID(),
    name: "Pack",
    scope: "workspace",
    scopeKey: null,
    body: "Do the thing.",
    links: null,
    version: 1,
    ...overrides,
  };
}

describe("guidance packs (PILE-423)", () => {
  it("renders packs with scope-qualified headings, least specific first", () => {
    const packs = [
      pack({ name: "Org rules", scope: "workspace", body: "Be terse." }),
      pack({
        name: "Outreach",
        scope: "status",
        scopeKey: "in_progress",
        body: "No rate or savings numbers.",
        version: 3,
      }),
    ];
    const rendered = renderGuidancePacks(packs);
    expect(rendered).toContain("## Guidance");
    expect(rendered).toContain("### Org rules (workspace)");
    expect(rendered).toContain("### Outreach (stage:in_progress)");
    expect(rendered).toContain("No rate or savings numbers.");
    // Most specific lands last.
    expect(rendered.indexOf("Org rules")).toBeLessThan(
      rendered.indexOf("Outreach")
    );
  });

  it("renders links as markdown bullets under the pack body", () => {
    const rendered = renderGuidancePacks([
      pack({
        links: JSON.stringify([
          { label: "Playbook", url: "https://example.com/playbook" },
          { url: "https://example.com/raw" },
        ]),
      }),
    ]);
    expect(rendered).toContain("- [Playbook](https://example.com/playbook)");
    expect(rendered).toContain("- https://example.com/raw");
  });

  it("records id+scope+version refs the session stores", () => {
    const packs = [
      pack({ name: "A", scope: "team", scopeKey: "t1", version: 7 }),
    ];
    expect(guidanceRefs(packs)).toEqual([
      {
        id: packs[0]!.id,
        name: "A",
        scope: "team",
        scopeKey: "t1",
        version: 7,
      },
    ]);
  });

  it("drops malformed links instead of throwing", () => {
    expect(parseGuidanceLinks("not json")).toEqual([]);
    expect(parseGuidanceLinks(JSON.stringify({ url: "x" }))).toEqual([]);
    expect(
      parseGuidanceLinks(JSON.stringify([{ label: "no url" }, "str"]))
    ).toEqual([]);
    expect(parseGuidanceLinks(null)).toEqual([]);
  });
});
