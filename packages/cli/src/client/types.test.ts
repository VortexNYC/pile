import { describe, expect, it } from "vitest";

describe("cli client types (PILE-452 coverage)", () => {
  it("module loads without throwing", async () => {
    const mod = await import("./types.js");
    expect(mod).toBeTruthy();
  });
});
