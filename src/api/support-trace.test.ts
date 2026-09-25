import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

env.WEBHOOK_QUEUE = null as unknown as typeof env.WEBHOOK_QUEUE;

import { createD1 } from "../global/db.js";
import { supportWidgetSessions, user as userTable } from "../global/schema.js";
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
      id: "user-trace",
      name: "Trace User",
      email: "trace-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-trace");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Trace test",
    slug: `trace-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-trace",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-trace",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

function req(path: string, token: string, init: RequestInit = {}) {
  return app.fetch(
    new Request(`https://example.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    }),
    env
  ) as Promise<Response>;
}

async function seedWidgetTicket(organizationId: string, token: string) {
  const keyRes = await req(
    `/workspaces/${organizationId}/support/widget-keys`,
    token,
    { method: "POST", body: JSON.stringify({ name: "Trace widget" }) }
  );
  const { key } = z.object({ key: z.string() }).parse(await keyRes.json());

  const sessRes = await app.fetch(
    new Request(`https://example.com/support/widget/${key}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env
  );
  const { sessionToken } = z
    .object({ sessionToken: z.string() })
    .parse(await sessRes.json());

  const msgRes = await app.fetch(
    new Request(`https://example.com/support/widget/${key}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pile-widget-session": sessionToken,
      },
      body: JSON.stringify({ text: "trace me" }),
    }),
    env
  );
  const { ticketId } = z
    .object({ ticketId: z.string() })
    .parse(await msgRes.json());

  const db = createD1(env.D1);
  const widgetSession = await db
    .select()
    .from(supportWidgetSessions)
    .where(eq(supportWidgetSessions.ticketId, ticketId))
    .get();

  return { ticketId, widgetSessionId: widgetSession!.id };
}

const traceSchema = z.object({
  resolvedAs: z.enum(["ticket", "capture_session", "widget_session"]),
  ticket: z.object({ id: z.string() }).nullable(),
  events: z.array(z.unknown()),
  attachments: z.array(z.unknown()),
  widgetSession: z.object({ id: z.string() }).nullable(),
  captureSession: z.unknown().nullable(),
  issue: z.unknown().nullable(),
  agentSessions: z.array(z.unknown()),
});

describe("support trace", () => {
  it("resolves a ticket id into the full correlated bundle", async () => {
    const { organizationId, token } = await seedWorkspace();
    const { ticketId, widgetSessionId } = await seedWidgetTicket(
      organizationId,
      token
    );

    const res = await req(
      `/workspaces/${organizationId}/support/trace/${ticketId}`,
      token
    );
    expect(res.status).toBe(200);
    const trace = traceSchema.parse(await res.json());
    expect(trace.resolvedAs).toBe("ticket");
    expect(trace.ticket?.id).toBe(ticketId);
    expect(trace.events.length).toBeGreaterThan(0);
    expect(trace.widgetSession?.id).toBe(widgetSessionId);
  });

  it("resolves a widget session id to the same ticket", async () => {
    const { organizationId, token } = await seedWorkspace();
    const { ticketId, widgetSessionId } = await seedWidgetTicket(
      organizationId,
      token
    );

    const res = await req(
      `/workspaces/${organizationId}/support/trace/${widgetSessionId}`,
      token
    );
    expect(res.status).toBe(200);
    const trace = traceSchema.parse(await res.json());
    expect(trace.resolvedAs).toBe("widget_session");
    expect(trace.ticket?.id).toBe(ticketId);
  });

  it("404s on unknown ids and does not leak across orgs", async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    const { ticketId } = await seedWidgetTicket(a.organizationId, a.token);

    const missing = await req(
      `/workspaces/${a.organizationId}/support/trace/${crypto.randomUUID()}`,
      a.token
    );
    expect(missing.status).toBe(404);

    const crossTenant = await req(
      `/workspaces/${b.organizationId}/support/trace/${ticketId}`,
      b.token
    );
    expect(crossTenant.status).toBe(404);
  });
});
