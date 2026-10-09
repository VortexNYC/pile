import { describe, expect, it } from "vitest";
import { remark } from "remark";

import { remarkIssueLinks } from "./remark-issues";

async function run(markdown: string) {
  const tree = await remark()
    .use(remarkIssueLinks, { workspaceSlug: "vortex" })
    .run(remark().parse(markdown));
  return JSON.stringify(tree);
}

describe("remarkIssueLinks", () => {
  it("linkifies issue identifiers", async () => {
    const out = await run("See ISS-123 for the fix");
    expect(out).toContain('"url":"/app/vortex/issues/ISS-123"');
  });

  it("does not linkify inside existing links", async () => {
    const out = await run("[ISS-123](https://x.example)");
    expect(out).toContain('"url":"https://x.example"');
    expect(out).not.toContain("/app/vortex/issues/ISS-123");
  });

  it("leaves lowercase words and code alone", async () => {
    const out = await run("`ISS-123` stays code, foo-9 is not");
    expect(out).not.toContain("/app/vortex/issues/");
  });
});
