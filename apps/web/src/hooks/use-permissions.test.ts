import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

import { fetchPermissions, permissionAllowed } from "./use-permissions";

describe("fetchPermissions (PILE-652)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the permission payload on 200", async () => {
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ role: "member", permissions: ["issue:view"] }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", spy);
    await expect(fetchPermissions("org-1")).resolves.toEqual({
      role: "member",
      permissions: ["issue:view"],
    });
    expect(spy).toHaveBeenCalledWith("/workspaces/org-1/me/permissions");
  });

  it("throws on !ok — a failed read is a query error, not an empty grant set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("forbidden", { status: 403 }))
    );
    const failure = fetchPermissions("org-1").then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    );
    const result = await failure;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ApiError);
      expect((result.error as ApiError).status).toBe(403);
    }
  });
});

const member = (permissions: string[]) => ({ role: "member", permissions });

describe("permissionAllowed", () => {
  it("answers no for unloaded data — callers gate chrome on isLoaded", () => {
    expect(permissionAllowed(undefined, "issue", "view")).toBe(false);
    expect(permissionAllowed(undefined, "settings", "view")).toBe(false);
  });

  it("admits owners and admins unconditionally", () => {
    expect(
      permissionAllowed({ role: "owner", permissions: [] }, "issue", "delete")
    ).toBe(true);
    expect(
      permissionAllowed({ role: "admin", permissions: [] }, "settings", "view")
    ).toBe(true);
  });

  it("honors resource:action, resource:*, and admin statements", () => {
    expect(
      permissionAllowed(member(["document:view"]), "document", "view")
    ).toBe(true);
    expect(permissionAllowed(member(["issue:*"]), "issue", "delete")).toBe(
      true
    );
    expect(
      permissionAllowed(member(["workspace:admin"]), "settings", "delete")
    ).toBe(true);
    expect(permissionAllowed(member(["issue:view"]), "issue", "delete")).toBe(
      false
    );
  });

  it("maps legacy bare verbs — read covers view, write covers mutations", () => {
    expect(
      permissionAllowed(
        { role: "member", permissions: ["read"] },
        "ticket",
        "view"
      )
    ).toBe(true);
    expect(
      permissionAllowed(
        { role: "member", permissions: ["read"] },
        "ticket",
        "edit"
      )
    ).toBe(false);
    expect(
      permissionAllowed(
        { role: "member", permissions: ["write"] },
        "ticket",
        "edit"
      )
    ).toBe(true);
  });
});
