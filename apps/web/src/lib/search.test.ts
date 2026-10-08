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
  it("rejects look-alike prefixes and paths that escape /app", () => {
    expect(safeRedirect("/apple")).toBeUndefined();
    expect(safeRedirect("/app/../admin")).toBeUndefined();
    expect(safeRedirect("/app/./x")).toBeUndefined();
    expect(safeRedirect("/app\\..\\x")).toBeUndefined();
  });
  it("keeps the query string", () => {
    expect(safeRedirect("/app")).toBe("/app");
    expect(safeRedirect("/app/acme/issues?status=todo")).toBe(
      "/app/acme/issues?status=todo"
    );
  });
});
