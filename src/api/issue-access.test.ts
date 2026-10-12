import { describe, expect, it } from "vitest";

import { canAccess } from "../platform/permissions.js";

// issueViewer() derives grantedOnly from workspace:read — the flag that
// flips issue lists + direct access to grant-only for scoped roles.
describe("contractor grantedOnly derivation", () => {
  it("no workspace:read → grantedOnly", () => {
    const contractor = [
      "issue:view",
      "issue:create",
      "issue:edit",
      "document:view",
      "document:create",
      "document:edit",
      "comment:view",
      "comment:create",
      "comment:edit",
      "ticket:view",
      "ticket:create",
    ];
    expect(canAccess(contractor, "read")).toBe(false);
    expect(canAccess(contractor, "view", "issue")).toBe(true);
    expect(canAccess(contractor, "create", "issue")).toBe(true);
    expect(canAccess(contractor, "view", "deal")).toBe(false);
  });

  it("member keeps workspace:read → sees unrestricted issues", () => {
    const member = ["workspace:read", "workspace:write", "issue:view"];
    expect(canAccess(member, "read")).toBe(true);
    expect(canAccess(member, "view", "issue")).toBe(true);
  });

  it("legacy bare read key keeps broad issue visibility", () => {
    expect(canAccess(["read"], "read")).toBe(true);
    expect(canAccess(["read"], "view", "issue")).toBe(true);
  });
});
