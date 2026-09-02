import { describe, expect, it } from "vitest";

import { hmacSha256Hex, timingSafeEqualHex } from "./crypto.js";

describe("crypto", () => {
  it("hmacSha256Hex produces a 64-char hex string", async () => {
    const result = await hmacSha256Hex("secret", "message");
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[a-f0-9]+$/);
  });

  it("timingSafeEqualHex compares equal strings", () => {
    expect(timingSafeEqualHex("abc", "abc")).toBe(true);
    expect(timingSafeEqualHex("abc", "abC")).toBe(false);
    expect(timingSafeEqualHex("abc", "ab")).toBe(false);
  });
});
