import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../index.js";

describe("health API", () => {
  it("returns a structured health check", async () => {
    const request = new Request("https://example.com/health");
    const res = await app.fetch(request, env);
    const body = await res.json<{
      ok: boolean;
      status: string;
      version: string;
      checks: { name: string; healthy: boolean; message?: string }[];
    }>();
    expect(res.status).toBeOneOf([200, 503]);
    expect(typeof body.ok).toBe("boolean");
    expect(["healthy", "degraded", "unhealthy"]).toContain(body.status);
    expect(body.version).toBe("0.1.0");
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks.length).toBeGreaterThanOrEqual(2);
    expect(body.checks.some((c) => c.name === "d1")).toBe(true);
    expect(body.checks.some((c) => c.name === "workspace-do")).toBe(true);
  });
});
