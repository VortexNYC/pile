import { describe, expect, it } from "vitest";

import { unreadBadgeLabel } from "./notifications-bell";

describe("unreadBadgeLabel", () => {
  it("renders the count verbatim under 100", () => {
    expect(unreadBadgeLabel(1)).toBe("1");
    expect(unreadBadgeLabel(99)).toBe("99");
  });

  it("caps triple-digit counts so the pill stays narrow", () => {
    expect(unreadBadgeLabel(100)).toBe("99+");
    expect(unreadBadgeLabel(1200)).toBe("99+");
  });
});
