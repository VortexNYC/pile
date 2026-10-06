import { describe, expect, it } from "vitest";

import { rolePermissionsFor, toApiKeyWorkspaceIdentity } from "./identity.js";

describe("rolePermissionsFor", () => {
  it("maps each role to its permission set", () => {
    expect(rolePermissionsFor("owner")).toEqual(["read", "write", "admin"]);
    expect(rolePermissionsFor("admin")).toEqual(["read", "write", "admin"]);
    expect(rolePermissionsFor("member")).toEqual(["read", "write"]);
  });

  it("degrades unknown roles to member, never wider", () => {
    expect(rolePermissionsFor("viewer")).toEqual(["read", "write"]);
    expect(rolePermissionsFor("")).toEqual(["read", "write"]);
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

  it("reads permissions and actor type from key metadata", () => {
    const identity = toApiKeyWorkspaceIdentity({
      id: "k1",
      referenceId: "u1",
      metadata: JSON.stringify({
        organizationId: "org1",
        permissions: "read,write",
        actorType: "agent",
      }),
    });
    expect(identity).toMatchObject({
      id: "u1",
      organizationId: "org1",
      type: "agent",
      permissions: ["read", "write"],
    });
  });
});
