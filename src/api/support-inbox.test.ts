import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
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
      id: "user-inbox",
      name: "Inbox User",
      email: "inbox-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-inbox");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Support inbox test",
    slug: `support-inbox-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-inbox",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-inbox",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

describe("support-inbox API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  function fetch(path: string, init: RequestInit = {}) {
    const request = new Request(`https://example.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    return app.fetch(request, env);
  }

  it("lists inbox tickets and counts", async () => {
    const customerRes = await fetch(
      `/workspaces/${organizationId}/support/customers`,
      {
        method: "POST",
        body: JSON.stringify({
          email: `inbox-customer-${crypto.randomUUID()}@example.com`,
        }),
      }
    );
    expect(customerRes.status).toBe(201);
    const customer = (await customerRes.json()) as { customer: { id: string } };

    const ticketRes = await fetch(
      `/workspaces/${organizationId}/support/tickets`,
      {
        method: "POST",
        body: JSON.stringify({
          customerId: customer.customer.id,
          title: "Inbox test",
          sourceChannel: "api",
          priority: "high",
        }),
      }
    );
    expect(ticketRes.status).toBe(201);

    const inbox = await fetch(`/workspaces/${organizationId}/support/inbox`);
    expect(inbox.status).toBe(200);
    const inboxBody = (await inbox.json()) as {
      tickets: { title: string }[];
      nextCursor: string | null;
    };
    expect(inboxBody.tickets.some((t) => t.title === "Inbox test")).toBe(true);

    const counts = await fetch(
      `/workspaces/${organizationId}/support/inbox/counts`
    );
    expect(counts.status).toBe(200);
    const countsBody = (await counts.json()) as {
      counts: { todo: number; unassigned: number };
    };
    expect(countsBody.counts.todo).toBeGreaterThanOrEqual(1);
    expect(countsBody.counts.unassigned).toBeGreaterThanOrEqual(1);
  });

  it("manages saved views", async () => {
    const create = await fetch(
      `/workspaces/${organizationId}/support/inbox/views`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "My todo",
          filter: { status: "todo", limit: 10 },
          sort: { by: "updated_at" },
        }),
      }
    );
    expect(create.status).toBe(201);
    const view = (await create.json()) as { view: { id: string } };

    const list = await fetch(
      `/workspaces/${organizationId}/support/inbox/views`
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { views: { id: string }[] };
    expect(listBody.views.some((v) => v.id === view.view.id)).toBe(true);

    const run = await fetch(
      `/workspaces/${organizationId}/support/inbox/views/${view.view.id}/run`
    );
    expect(run.status).toBe(200);
  });
});
