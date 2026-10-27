import { describe, expect, it } from "vitest";

import { adminRole, guestRole, memberRole, ownerRole } from "./access.js";
import { flattenStatements } from "./identity.js";

// The api-key minting clamp (middleware) strips any grant that is not in the
// member's role statements — `agent` must be a declared resource on the human
// roles or scoped agent tokens lose agent:read/agent:write on every request.
describe("agent resource grants", () => {
  it("member/admin/owner roles carry agent:read + agent:write", () => {
    for (const role of [memberRole, adminRole, ownerRole]) {
      const flat = flattenStatements(role.statements);
      expect(flat).toContain("agent:read");
      expect(flat).toContain("agent:write");
    }
  });

  it("guests get no agent grant", () => {
    const flat = flattenStatements(guestRole.statements);
    expect(flat).not.toContain("agent:read");
    expect(flat).not.toContain("agent:write");
  });

  it("member/admin/owner roles carry memory grants while guests do not (VTX-636)", () => {
    for (const role of [memberRole, adminRole, ownerRole]) {
      const flat = flattenStatements(role.statements);
      expect(flat).toContain("memory:view");
      expect(flat).toContain("memory:create");
      expect(flat).toContain("memory:edit");
    }
    const guestFlat = flattenStatements(guestRole.statements);
    expect(guestFlat).not.toContain("memory:view");
    expect(guestFlat).not.toContain("memory:create");
  });
});
