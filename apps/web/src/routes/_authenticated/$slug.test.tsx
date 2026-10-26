import { describe, expect, it } from "vitest";

import { resolveWorkspace } from "./$slug";

const workspaces = [
  { id: "org-1", slug: "acme" },
  { id: "org-2", slug: "vortex" },
];

describe("resolveWorkspace", () => {
  it("matches by slug", () => {
    expect(resolveWorkspace(workspaces, "acme")?.id).toBe("org-1");
  });

  it("matches by organizationId — CLI links carry the id, not the slug", () => {
    expect(resolveWorkspace(workspaces, "org-2")?.slug).toBe("vortex");
  });

  it("returns null for unknown slugs and missing data", () => {
    expect(resolveWorkspace(workspaces, "nope")).toBeNull();
    expect(resolveWorkspace(undefined, "acme")).toBeNull();
  });
});
