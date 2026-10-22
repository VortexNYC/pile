import { describe, expect, it } from "vitest";

import {
  identifyPosthog,
  initPosthog,
  PRODUCTION_HOSTS,
  resetPosthog,
} from "./observability";

describe("observability", () => {
  it("no-ops cleanly without a key or window and restricts default key to production hosts", () => {
    expect(() => {
      initPosthog();
      identifyPosthog({ id: "u-1", email: "u@example.com" });
      resetPosthog();
    }).not.toThrow();
    expect(PRODUCTION_HOSTS.has("pile.nyc")).toBe(true);
    expect(PRODUCTION_HOSTS.has("app.pile.nyc")).toBe(true);
    expect(PRODUCTION_HOSTS.has("localhost")).toBe(false);
  });
});
