import { describe, expect, it } from "vitest";

import { issueTemplateDataSchema } from "./templates.js";

describe("issueTemplateDataSchema", () => {
  it("accepts the stampable issue fields", () => {
    const data = issueTemplateDataSchema.parse({
      title: "Templated",
      status: "triage",
      priority: "high",
      estimate: 3,
      delegateId: "agent-1",
      labelIds: "l1,l2",
    });
    expect(data.status).toBe("triage");
    expect(data.labelIds).toBe("l1,l2");
  });

  it("rejects a status outside the issue status domain", () => {
    expect(
      issueTemplateDataSchema.safeParse({ status: "not-a-status" }).success
    ).toBe(false);
  });
});
