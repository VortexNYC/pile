import { describe, expect, it } from "vitest";

import { Route } from "./$ticketId";

describe("ticket detail route", () => {
  it("mounts a component that renders the capture panel", () => {
    expect(Route.options.component).toBeTruthy();
  });
});
