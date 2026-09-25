import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { changelogNotifyRecipients } from "../global/changelog.js";
import { createD1 } from "../global/db.js";
import { apikey as apikeyTable, user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

const ORIGIN = "https://your-domain.com";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-1",
      name: "Test User",
      email: "user-1@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const headers = await createAdminHeaders(env, "user-1");
  const workspace = await createWorkspace(db, env, headers, {
    name: "Test workspace",
    slug: `test-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-1",
  });

  return workspace!.id;
}

async function createAdminTokenRecord(organizationId: string) {
  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-1",
      name: "test-admin",
      metadata: { organizationId, permissions: "admin" },
    },
  });
  const parsed = z.object({ id: z.string(), key: z.string() }).parse(result);
  const db = createD1(env.D1);
  await db
    .update(apikeyTable)
    .set({ rateLimitEnabled: false })
    .where(eq(apikeyTable.id, parsed.id));
  return { id: parsed.id, token: parsed.key };
}

describe("changelog API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    organizationId = await seedWorkspace();
    const record = await createAdminTokenRecord(organizationId);
    token = record.token;
  });

  function fetch(path: string, init: RequestInit = {}) {
    const request = new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    return app.fetch(request, env);
  }

  it("creates, publishes, lists publicly, and serves RSS", async () => {
    // A public ticket with voters, one opted out.
    const customerRes = await fetch(
      `/workspaces/${organizationId}/support/customers`,
      {
        method: "POST",
        body: JSON.stringify({ email: "opted-out@example.com" }),
      }
    );
    const { customer } = (await customerRes.json()) as {
      customer: { id: string };
    };
    await fetch(
      `/workspaces/${organizationId}/support/customers/${customer.id}`,
      { method: "PATCH", body: JSON.stringify({ emailOptOut: true }) }
    );

    const ticketRes = await fetch(
      `/workspaces/${organizationId}/support/tickets`,
      {
        method: "POST",
        body: JSON.stringify({
          customerId: customer.id,
          title: "Dark mode please",
          sourceChannel: "api",
        }),
      }
    );
    const { ticket } = (await ticketRes.json()) as { ticket: { id: string } };
    for (const email of ["opted-out@example.com", "fan@example.com"]) {
      await fetch(
        `/workspaces/${organizationId}/support/tickets/${ticket.id}/votes`,
        { method: "POST", body: JSON.stringify({ email }) }
      );
    }

    // Draft entry — hidden from the public list.
    const createRes = await fetch(`/workspaces/${organizationId}/changelog`, {
      method: "POST",
      body: JSON.stringify({
        title: "Dark mode shipped",
        body: "The app now supports dark mode.",
        labels: ["feature"],
        links: [{ ticketId: ticket.id }],
      }),
    });
    expect(createRes.status).toBe(201);
    const { entry } = (await createRes.json()) as {
      entry: {
        id: string;
        publishedAt: string | null;
        links: { ticketId: string | null }[];
      };
    };
    expect(entry.publishedAt).toBeNull();
    expect(entry.links[0].ticketId).toBe(ticket.id);

    const publicList = await app.fetch(
      new Request(`${ORIGIN}/workspaces/${organizationId}/changelog`),
      env
    );
    expect(publicList.status).toBe(200);
    const publicBody = (await publicList.json()) as { entries: unknown[] };
    expect(
      publicBody.entries.every((e) => (e as { id: string }).id !== entry.id)
    ).toBe(true);

    // Staff sees drafts via includeDrafts.
    const staffList = await fetch(
      `/workspaces/${organizationId}/changelog?includeDrafts=true`
    );
    const staffBody = (await staffList.json()) as { entries: { id: string }[] };
    expect(staffBody.entries.some((e) => e.id === entry.id)).toBe(true);

    // Opt-out filtering — only the non-opted-out voter is a recipient.
    const db = createD1(env.D1);
    const recipients = await changelogNotifyRecipients(db, organizationId, {
      ...(entry as never),
      links: [
        {
          id: "l1",
          entryId: entry.id,
          ticketId: ticket.id,
          issueId: null,
        },
      ],
    });
    expect(recipients).toEqual(["fan@example.com"]);

    // Publish → public list + RSS include it.
    const pubRes = await fetch(
      `/workspaces/${organizationId}/changelog/${entry.id}/publish`,
      { method: "POST" }
    );
    expect(pubRes.status).toBe(200);
    const pub = (await pubRes.json()) as {
      entry: { publishedAt: string | null };
      notified: string[];
    };
    expect(pub.entry.publishedAt).toBeTruthy();
    // Close-the-loop honored the opt-out: only the non-opted-out voter mailed.
    expect(pub.notified).toEqual(["fan@example.com"]);

    const publicList2 = await app.fetch(
      new Request(`${ORIGIN}/workspaces/${organizationId}/changelog`),
      env
    );
    const publicBody2 = (await publicList2.json()) as {
      entries: { id: string }[];
    };
    expect(publicBody2.entries.some((e) => e.id === entry.id)).toBe(true);

    const rssRes = await app.fetch(
      new Request(`${ORIGIN}/workspaces/${organizationId}/changelog.rss`),
      env
    );
    expect(rssRes.status).toBe(200);
    expect(rssRes.headers.get("content-type")).toContain("rss+xml");
    const rss = await rssRes.text();
    expect(rss).toContain("Dark mode shipped");

    // Unpublish removes it from the public surface.
    await fetch(
      `/workspaces/${organizationId}/changelog/${entry.id}/unpublish`,
      {
        method: "POST",
      }
    );
    const publicList3 = await app.fetch(
      new Request(`${ORIGIN}/workspaces/${organizationId}/changelog`),
      env
    );
    const publicBody3 = (await publicList3.json()) as {
      entries: { id: string }[];
    };
    expect(publicBody3.entries.some((e) => e.id === entry.id)).toBe(false);
  });
});
