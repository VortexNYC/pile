import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../index.js";

const signIn = () =>
  app.fetch(
    new Request("https://example.com/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://example.com",
      },
      body: JSON.stringify({ email: "nope@example.com", password: "x" }),
    }),
    env
  );

describe("auth rate limiting", () => {
  it("returns 429 after exceeding the sign-in limit", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await signIn()).status);
    }
    expect(statuses).toContain(429);
  });
});
