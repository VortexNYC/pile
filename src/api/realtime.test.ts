import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
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
      id: "user-realtime",
      name: "Realtime User",
      email: "realtime-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-realtime");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Realtime test",
    slug: `realtime-${crypto.randomUUID()}`,
    key: `R${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-realtime",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-realtime",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

function upgradeRequest(url: string, token?: string): Request {
  return new Request(url, {
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      ...(token ? { Authorization: `Bearer ${token}` } : undefined),
    },
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for websocket message")),
      timeoutMs
    );
    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(event.data)));
    });
  });
}

describe("GET /workspaces/{org}/realtime", () => {
  it("upgrades, emits a connected event, and answers ping with pong", async () => {
    const { organizationId, token } = await seedWorkspace();
    const res = await app.fetch(
      upgradeRequest(
        `https://example.com/workspaces/${organizationId}/realtime`,
        token
      ),
      env
    );
    expect(res.status).toBe(101);

    const ws = res.webSocket;
    expect(ws).toBeDefined();
    ws!.accept();

    const connected = (await nextMessage(ws!)) as {
      type: string;
      organizationId: string;
    };
    expect(connected.type).toBe("connected");
    expect(connected.organizationId).toBe(organizationId);

    ws!.send(JSON.stringify({ type: "ping" }));
    expect(await nextMessage(ws!)).toEqual({ type: "pong" });
    ws!.close();
  });

  it("accepts the workspace key via ?token= for browser clients", async () => {
    const { organizationId, token } = await seedWorkspace();
    const res = await app.fetch(
      upgradeRequest(
        `https://example.com/workspaces/${organizationId}/realtime?token=${encodeURIComponent(token)}`
      ),
      env
    );
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const connected = (await nextMessage(ws)) as { type: string };
    expect(connected.type).toBe("connected");
    ws.close();
  });

  it("rejects upgrade requests without a token", async () => {
    const { organizationId } = await seedWorkspace();
    const res = await app.fetch(
      upgradeRequest(
        `https://example.com/workspaces/${organizationId}/realtime`
      ),
      env
    );
    expect(res.status).toBe(401);
  });

  it("returns 426 for non-upgrade requests", async () => {
    const { organizationId, token } = await seedWorkspace();
    const res = await app.fetch(
      new Request(`https://example.com/workspaces/${organizationId}/realtime`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env
    );
    expect(res.status).toBe(426);
    expect(res.headers.get("X-Pile-Error-Code")).toBe("UPGRADE_REQUIRED");
  });

  it("does not accept ?token= on non-realtime routes", async () => {
    const { organizationId, token } = await seedWorkspace();
    const res = await app.fetch(
      new Request(
        `https://example.com/workspaces/${organizationId}/issues?token=${encodeURIComponent(token)}`
      ),
      env
    );
    expect(res.status).toBe(401);
  });
});
