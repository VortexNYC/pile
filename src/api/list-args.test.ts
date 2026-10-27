import { describe, expect, it } from "vitest";

import {
  limitQueryParam,
  listIssuesQuerySchema,
  matchesSearchQuery,
  pageByCreatedCursor,
  toListArgs,
} from "./list-args.js";

describe("toListArgs", () => {
  it("maps the delegateId query param onto ListIssuesArgs (PILE-417)", () => {
    const query = listIssuesQuerySchema.parse({ delegateId: "devin" });
    expect(toListArgs(query).delegateId).toBe("devin");
  });

  it("leaves delegateId unset when the param is absent", () => {
    const query = listIssuesQuerySchema.parse({});
    expect(toListArgs(query).delegateId).toBeUndefined();
  });
});

describe("limitQueryParam (PILE-653)", () => {
  const schema = limitQueryParam(500, 1000);

  it("defaults when absent or invalid and caps at the max", () => {
    expect(schema.parse(undefined)).toBe(500);
    expect(schema.parse("nope")).toBe(500);
    expect(schema.parse("0")).toBe(500);
    expect(schema.parse("20")).toBe(20);
    expect(schema.parse("5000")).toBe(1000);
  });
});

describe("matchesSearchQuery (PILE-653)", () => {
  it("is case-insensitive and matches any haystack", () => {
    expect(matchesSearchQuery(["Acme Corp", "acme.io"], "ACME")).toBe(true);
    expect(matchesSearchQuery(["Acme Corp", null], "acme.io")).toBe(false);
    expect(matchesSearchQuery([null], "x")).toBe(false);
  });

  it("treats empty or absent q as a match-all", () => {
    expect(matchesSearchQuery(["x"], undefined)).toBe(true);
    expect(matchesSearchQuery(["x"], "  ")).toBe(true);
  });
});

describe("pageByCreatedCursor (PILE-653)", () => {
  const rows = [
    { id: "b", createdAt: "2026-01-02T00:00:00Z" },
    { id: "a", createdAt: "2026-01-02T00:00:00Z" },
    { id: "c", createdAt: "2026-01-03T00:00:00Z" },
  ];

  it("orders createdAt desc then id desc and pages by keyset cursor", () => {
    const first = pageByCreatedCursor(rows, { limit: 2 });
    expect(first.page.map((r) => r.id)).toEqual(["c", "b"]);
    expect(first.nextCursor).toBeDefined();

    const second = pageByCreatedCursor(rows, {
      limit: 2,
      cursor: JSON.parse(decodeURIComponent(first.nextCursor!)),
    });
    expect(second.page.map((r) => r.id)).toEqual(["a"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("emits nextCursor only when the page fills", () => {
    expect(pageByCreatedCursor(rows, { limit: 5 }).nextCursor).toBeUndefined();
    expect(pageByCreatedCursor(rows, { limit: 3 }).nextCursor).toBeDefined();
  });
});
