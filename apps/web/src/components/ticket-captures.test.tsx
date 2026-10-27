import { describe, expect, it } from "vitest";

import { TicketCaptures } from "./ticket-captures";

describe("TicketCaptures", () => {
  it("is a mountable component", () => {
    expect(typeof TicketCaptures).toBe("function");
  });
});
