import { describe, expect, it } from "vitest";

import { identifyPosthog, initPosthog, resetPosthog } from "./observability";

describe("observability", () => {
  it("no-ops cleanly without a key or window", () => {
    expect(() => {
      initPosthog();
      identifyPosthog({ id: "u-1", email: "u@example.com" });
      resetPosthog();
    }).not.toThrow();
  });
});
