import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAdminHeaders } from "../platform/test-auth.js";

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

  it("POST /support/feedback files a ticket with no secret", async () => {
    const db = createD1(env.D1);
    const { supportChannels, user: userTable } =
      await import("../global/schema.js");
    const now = new Date().toISOString();
    await db
      .insert(userTable)
      .values({
        id: "user-fb",
        name: "Fb",
        email: "user-fb@example.com",
        emailVerified: false,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, "user-fb");
    const workspace = await createWorkspace(db, env, headers, {
      name: "Feedback test",
      slug: `fb-${crypto.randomUUID()}`,
      key: `F${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      ownerId: "user-fb",
    });
    await db.insert(supportChannels).values({
      id: "test-feedback-channel",
      organizationId: workspace!.id,
      type: "api",
      name: "pile-cli-feedback",
      isActive: true,
      config: "{}",
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.fetch(
      new Request("https://example.com/support/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "10.9.9.9",
        },
        body: JSON.stringify({
          subject: "feedback test",
          text: "love it — genuinely great product",
          fromEmail: "reporter@co.dev",
          fromName: "Reporter",
          context: { client: "pile-cli", version: "0.1.5", os: "darwin arm64" },
        }),
      }),
      env
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticketNumber: number };
    expect(body.ticketNumber).toBeGreaterThan(0);
  });

  it("POST /support/feedback rejects thin submissions", async () => {
    const res = await app.fetch(
      new Request("https://example.com/support/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "10.9.9.10",
        },
        body: JSON.stringify({ text: "spam" }),
      }),
      env
    );
    expect(res.status).toBe(400);
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
