import { describe, expect, it } from "vitest";

// Importing the app registers every route — the wrap in index.ts
// harvests rls grants into the registry this test reads.
import "./index.js";
import { routePermissionsFor } from "../platform/rls.js";

describe("hardening routes", () => {
  it("readiness and export are admin-gated (VTX-753)", () => {
    expect(
      routePermissionsFor("GET", "/workspaces/{organizationId}/readiness")
    ).toEqual(["admin"]);
    expect(
      routePermissionsFor("GET", "/workspaces/{organizationId}/export")
    ).toEqual(["admin"]);
  });
});
