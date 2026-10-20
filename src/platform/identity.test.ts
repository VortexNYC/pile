import { describe, expect, it } from "vitest";

import { rolePermissionsFor, toApiKeyWorkspaceIdentity } from "./identity.js";

describe("rolePermissionsFor", () => {
  it("flattens role statements to resource:action permissions", () => {
    expect(rolePermissionsFor("owner")).toContain("workspace:admin");
    expect(rolePermissionsFor("owner")).toContain("issue:delete");
    expect(rolePermissionsFor("member")).toContain("workspace:write");
    expect(rolePermissionsFor("member")).toContain("issue:edit");
    expect(rolePermissionsFor("member")).not.toContain("issue:delete");
    expect(rolePermissionsFor("guest")).toContain("document:view");
    expect(rolePermissionsFor("guest")).not.toContain("issue:view");
  });

  it("returns empty for dynamic roles — resolved via organizationRole", () => {
    expect(rolePermissionsFor("viewer")).toEqual([]);
    expect(rolePermissionsFor("")).toEqual([]);
  });
});

describe("toApiKeyWorkspaceIdentity", () => {
  it("rejects keys missing workspace metadata", () => {
    expect(() =>
      toApiKeyWorkspaceIdentity({
        id: "k1",
        referenceId: "u1",
        metadata: null,
      })
    ).toThrow();
  });

  it("ignores metadata permissions and actor type without a server grant", () => {
    // metadata is client-controlled — without a workspace grant in the
    // plugin's permissions column the key resolves as a read-only user.
    const identity = toApiKeyWorkspaceIdentity({
      id: "k1",
      referenceId: "u1",
      metadata: JSON.stringify({
        organizationId: "org1",
        permissions: "read,write,admin",
        actorType: "agent",
      }),
    });
    expect(identity).toMatchObject({
      id: "u1",
      organizationId: "org1",
      type: "user",
      permissions: ["read"],
    });
  });

  it("honors the server-set workspace grant and actor type", () => {
    const identity = toApiKeyWorkspaceIdentity({
      id: "k1",
      referenceId: "u1",
      metadata: JSON.stringify({
        organizationId: "org1",
        permissions: "read",
        actorType: "agent",
      }),
      permissions: { workspace: ["read", "write"] },
    });
    expect(identity).toMatchObject({
      id: "u1",
      organizationId: "org1",
      type: "agent",
      permissions: ["read", "write"],
    });
  });
});
