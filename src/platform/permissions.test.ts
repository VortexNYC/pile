import { describe, expect, it } from "vitest";

import { canAccess, parsePermissionSet } from "./permissions.js";

// Role names are grant shorthand — the console's Create key sends "member",
// and pre-fix that parsed as an opaque string that satisfied nothing.
describe("parsePermissionSet role expansion", () => {
  it("expands `member` to the member role's statements", () => {
    const set = parsePermissionSet("member");
    expect(set.has("issue:view")).toBe(true);
    expect(set.has("issue:create")).toBe(true);
    expect(set.has("document:create")).toBe(true);
    expect(set.has("agent:read")).toBe(true);
    expect(set.has("agent:write")).toBe(true);
    // Guests stay narrow.
    expect(parsePermissionSet("guest").has("issue:create")).toBe(false);
  });

  it("a member-scoped key passes resource checks", () => {
    expect(canAccess("member", "view", "issue")).toBe(true);
    expect(canAccess("member", "create", "document")).toBe(true);
    expect(canAccess("member", "read")).toBe(true);
    // …but not admin.
    expect(canAccess("member", "admin")).toBe(false);
  });

  it("keeps literal grants alongside expanded roles", () => {
    const set = parsePermissionSet("member,contact:delete");
    expect(set.has("issue:view")).toBe(true);
    expect(set.has("contact:delete")).toBe(true);
  });
});

describe("canAccess wildcard grants", () => {
  it("`agent:*` satisfies agent:read and agent:write", () => {
    expect(canAccess("agent:*", "read", "agent")).toBe(true);
    expect(canAccess("agent:*", "write", "agent")).toBe(true);
    // Resource-scoped wildcard does not leak to other resources.
    expect(canAccess("agent:*", "create", "issue")).toBe(false);
  });
});
