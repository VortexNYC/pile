import { describe, expect, it } from "vitest";

import { listIssuesQuerySchema, toListArgs } from "./list-args.js";

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
