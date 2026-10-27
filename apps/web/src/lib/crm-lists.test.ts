import { describe, expect, it } from "vitest";

import { collectPages, CRM_LIST_PAGE_LIMIT } from "./crm-lists";

describe("collectPages (PILE-653)", () => {
  it("follows nextCursor until the endpoint stops returning one", async () => {
    const seen: (string | undefined)[] = [];
    const rows = await collectPages<number>(async (cursor) => {
      seen.push(cursor);
      if (cursor === undefined) return { rows: [1, 2], nextCursor: "c1" };
      if (cursor === "c1") return { rows: [3], nextCursor: "c2" };
      return { rows: [4] };
    });
    expect(seen).toEqual([undefined, "c1", "c2"]);
    expect(rows).toEqual([1, 2, 3, 4]);
  });

  it("returns a single page when no nextCursor comes back", async () => {
    const rows = await collectPages<string>(async () => ({ rows: ["a"] }));
    expect(rows).toEqual(["a"]);
  });
});

describe("CRM_LIST_PAGE_LIMIT", () => {
  it("matches the server-side default page size", () => {
    expect(CRM_LIST_PAGE_LIMIT).toBe(500);
  });
});
