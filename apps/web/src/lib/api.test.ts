import { describe, expect, it } from "vitest";

import { ApiError, errorMessage, unwrap, unwrapEmpty } from "./api";

describe("errorMessage", () => {
  it("reads Pile's nested error envelope", () => {
    expect(errorMessage({ error: { code: "x", message: "Nope" } }, "f")).toBe(
      "Nope"
    );
  });
  it("falls back through flat shapes", () => {
    expect(errorMessage({ error: "Flat" }, "f")).toBe("Flat");
    expect(errorMessage({ message: "Top" }, "f")).toBe("Top");
    expect(errorMessage("text", "f")).toBe("text");
    expect(errorMessage(null, "f")).toBe("f");
  });
});

describe("unwrap", () => {
  it("returns data on success", async () => {
    await expect(
      unwrap(
        Promise.resolve({
          data: { ok: 1 },
          response: new Response(null, { status: 200 }),
        })
      )
    ).resolves.toEqual({ ok: 1 });
  });
  it("throws an ApiError carrying the status", async () => {
    const failing = unwrap(
      Promise.resolve({
        error: { error: { message: "Forbidden" } },
        response: new Response(null, { status: 403 }),
      })
    );
    await expect(failing).rejects.toBeInstanceOf(ApiError);
    await expect(failing).rejects.toMatchObject({
      status: 403,
      message: "Forbidden",
    });
  });
  it("unwrapEmpty resolves on 204", async () => {
    await expect(
      unwrapEmpty(
        Promise.resolve({ response: new Response(null, { status: 204 }) })
      )
    ).resolves.toBeUndefined();
  });
});
