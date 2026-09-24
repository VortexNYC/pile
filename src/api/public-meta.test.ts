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

  it("agent-docs eval gate: the public docs surface teaches the core loop", async () => {
    // The contract a fresh agent needs to succeed without help:
    // sign up → onboard → capture link → support ticket → issue.
    const openapi = await fetch("/openapi.json");
    expect(openapi.status).toBe(200);
    const spec = (await openapi.json()) as { paths: Record<string, unknown> };
    for (const path of [
      "/api/auth/sign-up/email",
      "/api/auth/sign-in/email",
      "/workspaces/onboard",
      "/support/incoming/{channelId}",
    ]) {
      expect(spec.paths[path], `missing path ${path}`).toBeDefined();
    }

    const llms = await fetch("/llms.txt");
    const llmsBody = await llms.text();
    expect(llmsBody).toContain("/openapi.json");
    expect(llmsBody).toContain("@vortex-api/pile");

    // Every doc linked from llms.txt must actually resolve — dangling links
    // are exactly what breaks a docs-driven agent.
    const docLinks = [...llmsBody.matchAll(/\((\/docs\/[^)]+)\)/g)].map(
      (m) => m[1]!
    );
    expect(docLinks.length).toBeGreaterThan(0);
    const results = await Promise.all(
      docLinks.map(async (link) => ({ link, res: await fetch(link) }))
    );
    for (const { link, res } of results) {
      expect(res.status, `dangling doc link ${link}`).toBe(200);
      const body = await res.text();
      expect(body.length, `empty doc ${link}`).toBeGreaterThan(100);
    }
  });
});
