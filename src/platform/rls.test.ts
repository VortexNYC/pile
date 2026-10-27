import { describe, expect, it } from "vitest";

import {
  collectRoutePermissions,
  RLS_ALLOWED_SPECS,
  routePermissionsFor,
  rls,
} from "./rls.js";

describe("route permission harvesting (VTX-753)", () => {
  it("tags rls middleware with its allowed specs", () => {
    const mw = rls("issue:view");
    expect((mw as Record<symbol, unknown>)[RLS_ALLOWED_SPECS]).toEqual([
      "issue:view",
    ]);
  });

  it("collects method+path → specs from route configs", () => {
    collectRoutePermissions({
      method: "get",
      path: "/workspaces/{organizationId}/rls-test-probe",
      middleware: [rls("settings:view")],
    });
    expect(
      routePermissionsFor("get", "/workspaces/{organizationId}/rls-test-probe")
    ).toEqual(["settings:view"]);
    // Method is matched case-insensitively.
    expect(
      routePermissionsFor("GET", "/workspaces/{organizationId}/rls-test-probe")
    ).toEqual(["settings:view"]);
  });

  it("ignores routes without rls middleware or with malformed config", () => {
    collectRoutePermissions({
      method: "get",
      path: "/workspaces/{organizationId}/rls-none",
      middleware: [async () => {}],
    });
    expect(
      routePermissionsFor("GET", "/workspaces/{organizationId}/rls-none")
    ).toBeUndefined();
    collectRoutePermissions({ method: 42, path: null, middleware: [] });
  });

  it("flattens specs across multiple rls middlewares on one route", () => {
    collectRoutePermissions({
      method: "post",
      path: "/workspaces/{organizationId}/rls-multi",
      middleware: [rls("a:one"), rls("b:two")],
    });
    expect(
      routePermissionsFor("POST", "/workspaces/{organizationId}/rls-multi")
    ).toEqual(["a:one", "b:two"]);
  });
});
