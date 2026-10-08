import { describe, expect, it } from "vitest";

import { safeRedirect } from "./search";

describe("safeRedirect", () => {
  it("accepts in-app paths", () => {
    expect(safeRedirect("/app/acme/issues")).toBe("/app/acme/issues");
  });
  it("rejects open redirects and junk", () => {
    expect(safeRedirect("https://evil.com")).toBeUndefined();
    expect(safeRedirect("//evil.com/app")).toBeUndefined();
    expect(safeRedirect("/admin")).toBeUndefined();
    expect(safeRedirect(42)).toBeUndefined();
  });
});
