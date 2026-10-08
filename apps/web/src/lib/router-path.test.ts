import { describe, expect, it } from "vitest";

import { appHref, toRouterPath } from "./router-path";

describe("toRouterPath", () => {
  it("strips the /app mount prefix", () => {
    expect(toRouterPath("/app")).toBe("/");
    expect(toRouterPath("/app/acme/issues")).toBe("/acme/issues");
    expect(toRouterPath("/app?x=1")).toBe("/?x=1");
  });
  it("leaves external URLs alone", () => {
    expect(toRouterPath("https://example.com")).toBeNull();
    expect(toRouterPath("mailto:a@b.co")).toBeNull();
    expect(toRouterPath("//evil.com")).toBeNull();
  });
  it("leaves same-page anchors and query-only hrefs alone", () => {
    expect(toRouterPath("#members")).toBeNull();
    expect(toRouterPath("?tab=2")).toBeNull();
    expect(toRouterPath("")).toBeNull();
  });
  it("keeps already-relative router paths", () => {
    expect(toRouterPath("/sign-in")).toBe("/sign-in");
    expect(toRouterPath("sign-up")).toBe("/sign-up");
  });
});

describe("appHref", () => {
  it("prefixes router paths", () => {
    expect(appHref("/")).toBe("/app");
    expect(appHref("/acme/issues")).toBe("/app/acme/issues");
    expect(appHref("acme")).toBe("/app/acme");
  });
});
