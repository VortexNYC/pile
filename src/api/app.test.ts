import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../index.js";

describe("app dashboard", () => {
  it("serves the dashboard shell", async () => {
    const res = await app.fetch(new Request("https://example.com/app"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Agent sessions");
    expect(body).toContain("/api/auth/sign-in/email");
    expect(body).toContain("/agent/sessions");
  });
});
