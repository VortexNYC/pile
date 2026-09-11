import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { supportCustomers, user as userTable } from "../global/schema.js";
import { getTicketById } from "../global/support-tickets.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-capture",
      name: "Capture User",
      email: "capture-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-capture");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Support capture test",
    slug: `support-capture-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-capture",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-capture",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

function captureFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`https://example.com${path}`, init);
  return app.fetch(request, env);
}

describe("support-capture API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  async function createPublicKey(): Promise<{ id: string; key: string }> {
    const res = await captureFetch(
      `/workspaces/${organizationId}/support/capture/public-keys`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: "Website widget",
          allowedOrigins: ["https://example.com"],
        }),
      }
    );
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; key: string };
  }

  async function issueCaptureToken(
    publicKey: { key: string },
    origin = "https://example.com"
  ): Promise<string> {
    const res = await captureFetch("/support/capture/token", {
      method: "POST",
      headers: {
        "x-vortex-capture-public-key": publicKey.key,
        origin,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    return body.token;
  }

  it("rejects public key creation without auth", async () => {
    const res = await captureFetch(
      `/workspaces/${organizationId}/support/capture/public-keys`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "No auth", allowedOrigins: [] }),
      }
    );
    expect(res.status).toBe(403);
  });

  it("rejects token for an unknown public key", async () => {
    const res = await captureFetch("/support/capture/token", {
      method: "POST",
      headers: {
        "x-vortex-capture-public-key": "vtx_00000000000000000000000000000000",
        origin: "https://example.com",
      },
    });
    expect(res.status).toBe(401);
  });

  it("rejects token for a revoked public key", async () => {
    const publicKey = await createPublicKey();

    const revokeRes = await captureFetch(
      `/workspaces/${organizationId}/support/capture/public-keys/${publicKey.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    expect(revokeRes.status).toBe(200);

    const tokenRes = await captureFetch("/support/capture/token", {
      method: "POST",
      headers: {
        "x-vortex-capture-public-key": publicKey.key,
        origin: "https://example.com",
      },
    });
    expect(tokenRes.status).toBe(401);
  });

  it("rejects upload-session without a token", async () => {
    const res = await captureFetch("/support/capture/upload-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No token" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects upload for an unknown session", async () => {
    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const res = await captureFetch(
      "/support/capture/upload/00000000-0000-0000-0000-000000000000",
      {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: image,
      }
    );
    expect(res.status).toBe(401);
  });

  it("rejects finalize when email is missing", async () => {
    const publicKey = await createPublicKey();
    const sessionToken = await issueCaptureToken(publicKey);

    const sessionRes = await captureFetch("/support/capture/upload-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vortex-capture-token": sessionToken,
      },
      body: JSON.stringify({
        title: "No email",
        metadata: {},
      }),
    });
    expect(sessionRes.status).toBe(200);

    const finalizeRes = await captureFetch("/support/capture/finalize", {
      method: "POST",
      headers: { "x-vortex-capture-token": sessionToken },
    });
    expect(finalizeRes.status).toBe(400);
  });

  it("creates a capture public key and captures through to a ticket", async () => {
    const publicKey = await createPublicKey();

    const listRes = await captureFetch(
      `/workspaces/${organizationId}/support/capture/public-keys`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { publicKeys: { key: string }[] };
    expect(list.publicKeys.some((k) => k.key === publicKey.key)).toBe(true);

    const badOriginRes = await captureFetch("/support/capture/token", {
      method: "POST",
      headers: {
        "x-vortex-capture-public-key": publicKey.key,
        origin: "https://evil.com",
      },
    });
    expect(badOriginRes.status).toBe(401);

    const sessionToken = await issueCaptureToken(publicKey);

    const sessionRes = await captureFetch("/support/capture/upload-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vortex-capture-token": sessionToken,
      },
      body: JSON.stringify({
        title: "Button is broken",
        description: "Clicking the submit button does nothing",
        priority: "high",
        metadata: {
          email: "reporter@example.com",
          contentType: "image/png",
        },
      }),
    });
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as {
      uploadUrl: string;
      sessionId: string;
    };

    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const uploadRes = await captureFetch(session.uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: image,
    });
    expect(uploadRes.status).toBe(200);
    const { r2Key } = (await uploadRes.json()) as { r2Key: string };

    const stored = await env.ATTACHMENTS_BUCKET.get(r2Key);
    expect(stored).not.toBeNull();

    const finalizeRes = await captureFetch("/support/capture/finalize", {
      method: "POST",
      headers: { "x-vortex-capture-token": sessionToken },
    });
    expect(finalizeRes.status).toBe(200);
    const final = (await finalizeRes.json()) as { ticketId: string };
    expect(final.ticketId).toBeTruthy();

    const db = createD1(env.D1);
    const ticket = await getTicketById(db, organizationId, final.ticketId);
    expect(ticket).not.toBeNull();
    expect(ticket!.sourceChannel).toBe("capture");

    const customer = await db
      .select()
      .from(supportCustomers)
      .where(eq(supportCustomers.email, "reporter@example.com"))
      .get();
    expect(customer).not.toBeNull();
    expect(customer!.organizationId).toBe(organizationId);
  });
});
