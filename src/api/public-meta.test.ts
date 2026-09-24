import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../index.js";

function fetch(path: string) {
  return app.fetch(
    new Request(`https://example.com${path}`, {
      headers: { "cf-connecting-ip": "10.0.0.1" },
    }),
    env
  );
}

describe("public meta routes", () => {
  it("/status redirects to /health", async () => {
    const res = await fetch("/status");
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/health");
  });

  it("/.well-known/security.txt serves contact info", async () => {
    const res = await fetch("/.well-known/security.txt");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Contact: mailto:security@vortexnyc.com");
    expect(body).toContain(
      "Canonical: https://pile.nyc/.well-known/security.txt"
    );
  });

  it("/ serves the landing page", async () => {
    const res = await fetch("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("@vortex-api/pile");
  });

  it("/llms.txt serves the agent index", async () => {
    const res = await fetch("/llms.txt");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("openapi.json");
  });
});
