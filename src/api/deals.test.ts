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
      id: "user-deals",
      name: "Deals User",
      email: "deals-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-deals");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Deals test",
    slug: `deals-${crypto.randomUUID()}`,
    key: `D${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-deals",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-deals",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

async function fetch(
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
    ...(token ? { Authorization: `Bearer ${token}` } : undefined),
  };
  return app.fetch(
    new Request(`https://example.com${path}`, { ...init, headers }),
    env
  );
}

describe("deals", () => {
  let organizationId = "";
  let token = "";
  let customerId = "";

  beforeAll(async () => {
    ({ organizationId, token } = await seedWorkspace());
    const res = await fetch(
      `/workspaces/${organizationId}/customers`,
      { method: "POST", body: JSON.stringify({ name: "Acme" }) },
      token
    );
    customerId = ((await res.json()) as { id: string }).id;
  });

  it("creates, lists, updates, and deletes deals", async () => {
    const create = await fetch(
      `/workspaces/${organizationId}/deals`,
      {
        method: "POST",
        body: JSON.stringify({
          customerId,
          name: "Acme renewal",
          stage: "qualified",
          amountCents: 120_000_00,
          currency: "USD",
        }),
      },
      token
    );
    expect(create.status).toBe(201);
    const { deal } = (await create.json()) as { deal: Record<string, unknown> };
    expect(deal.stage).toBe("qualified");
    expect(deal.amountCents).toBe(12_000_000);
    expect(deal.contactIds).toEqual([]);

    const list = await fetch(
      `/workspaces/${organizationId}/deals?customerId=${customerId}`,
      {},
      token
    );
    const { deals } = (await list.json()) as { deals: { id: string }[] };
    expect(deals.map((d: { id: string }) => d.id)).toContain(deal.id);

    const patch = await fetch(
      `/workspaces/${organizationId}/deals/${deal.id}`,
      { method: "PATCH", body: JSON.stringify({ stage: "won" }) },
      token
    );
    const updated = (
      (await patch.json()) as {
        deal: { stage: string; closedAt: string | null };
      }
    ).deal;
    expect(updated.stage).toBe("won");
    expect(updated.closedAt).toBeTruthy();

    const reopen = await fetch(
      `/workspaces/${organizationId}/deals/${deal.id}`,
      { method: "PATCH", body: JSON.stringify({ stage: "negotiation" }) },
      token
    );
    expect(
      ((await reopen.json()) as { deal: { closedAt: string | null } }).deal
        .closedAt
    ).toBeNull();

    const del = await fetch(
      `/workspaces/${organizationId}/deals/${deal.id}`,
      { method: "DELETE" },
      token
    );
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);
    const gone = await fetch(
      `/workspaces/${organizationId}/deals/${deal.id}`,
      {},
      token
    );
    expect(gone.status).toBe(404);
  });

  it("links deals to contacts", async () => {
    const create = await fetch(
      `/workspaces/${organizationId}/deals`,
      {
        method: "POST",
        body: JSON.stringify({
          customerId,
          name: "Contact deal",
          stage: "lead",
          contactIds: ["contact-a", "contact-b"],
        }),
      },
      token
    );
    const { deal } = (await create.json()) as {
      deal: { id: string; contactIds: string[] };
    };
    expect(deal.contactIds.toSorted()).toEqual(["contact-a", "contact-b"]);

    const patch = await fetch(
      `/workspaces/${organizationId}/deals/${deal.id}`,
      { method: "PATCH", body: JSON.stringify({ contactIds: ["contact-c"] }) },
      token
    );
    const patched = (await patch.json()) as { deal: { contactIds: string[] } };
    expect(patched.deal.contactIds).toEqual(["contact-c"]);
  });
});

describe("custom fields", () => {
  let organizationId = "";
  let token = "";

  beforeAll(async () => {
    ({ organizationId, token } = await seedWorkspace());
  });

  it("defines fields and sets values per entity", async () => {
    const create = await fetch(
      `/workspaces/${organizationId}/fields`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "issue",
          name: "Sprint",
          type: "select",
          options: ["S1", "S2"],
        }),
      },
      token
    );
    expect(create.status).toBe(201);
    const { field } = (await create.json()) as {
      field: { id: string; options: string[] | null };
    };
    expect(field.options).toEqual(["S1", "S2"]);

    const list = await fetch(
      `/workspaces/${organizationId}/fields?entityType=issue`,
      {},
      token
    );
    expect(((await list.json()) as { fields: unknown[] }).fields).toHaveLength(
      1
    );

    const set = await fetch(
      `/workspaces/${organizationId}/fields/${field.id}/value`,
      {
        method: "PUT",
        body: JSON.stringify({ entityId: "issue-1", value: "S2" }),
      },
      token
    );
    expect(set.status).toBe(200);

    const values = await fetch(
      `/workspaces/${organizationId}/fields/values/issue-1`,
      {},
      token
    );
    expect(
      ((await values.json()) as { values: { value: string | null }[] })
        .values[0]?.value
    ).toBe("S2");

    // clearing removes the row
    await fetch(
      `/workspaces/${organizationId}/fields/${field.id}/value`,
      {
        method: "PUT",
        body: JSON.stringify({ entityId: "issue-1", value: null }),
      },
      token
    );
    const cleared = await fetch(
      `/workspaces/${organizationId}/fields/values/issue-1`,
      {},
      token
    );
    expect(
      ((await cleared.json()) as { values: unknown[] }).values
    ).toHaveLength(0);
  });
});

describe("lead intake", () => {
  it("creates a contact + deal from a public form post", async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: "user-leads",
        name: "Leads User",
        email: "leads-user@example.com",
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const setupHeaders = await createAdminHeaders(env, "user-leads");
    const workspace = await createWorkspace(db, env, setupHeaders, {
      name: "Leads test",
      slug: `leads-${crypto.randomUUID()}`,
      key: `L${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      ownerId: "user-leads",
    });
    const org = workspace!.id;

    const res = await app.fetch(
      new Request(`https://example.com/public/leads/${org}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "lead@acme.io",
          fullName: "Lead Person",
          company: "Acme",
          dealName: "Acme inbound",
          amountCents: 50_000_00,
          currency: "USD",
          message: "Saw the demo, want to talk.",
        }),
      }),
      env
    );
    expect(res.status).toBe(201);
    const { customerId, dealId } = (await res.json()) as {
      customerId: string;
      dealId: string;
    };
    expect(customerId).toBeTruthy();
    expect(dealId).toBeTruthy();

    // the deal exists and lands at lead stage
    const dealsRes = await app.fetch(
      new Request(`https://example.com/workspaces/${org}/deals`, {
        headers: {
          Authorization: `Bearer ${await (async () => {
            const auth = await createAuth(env);
            const r = await auth.api.createApiKey({
              body: {
                userId: "user-leads",
                name: "t",
                rateLimitEnabled: false,
                metadata: { organizationId: org, permissions: "admin" },
              },
            });
            return z.object({ key: z.string() }).parse(r).key;
          })()}`,
        },
      }),
      env
    );
    const { deals } = (await dealsRes.json()) as {
      deals: { id: string; stage: string; name: string }[];
    };
    const created = deals.find((d) => d.id === dealId);
    expect(created?.stage).toBe("lead");
    expect(created?.name).toBe("Acme inbound");
  });
});

describe("deal hygiene fields + externalId dedupe", () => {
  let organizationId = "";
  let token = "";
  let customerId = "";

  const dealShape = z.object({
    id: z.string(),
    name: z.string(),
    externalId: z.string().nullable(),
    nextStepText: z.string().nullable(),
    nextStepDueAt: z.string().nullable(),
    needsHuman: z.boolean().nullable(),
    needsHumanReason: z.string().nullable(),
    priorityScore: z.number().nullable(),
    stage: z.string(),
  });

  async function postDeal(body: Record<string, unknown>, query = "") {
    return fetch(
      `/workspaces/${organizationId}/deals${query}`,
      { method: "POST", body: JSON.stringify(body) },
      token
    );
  }

  beforeAll(async () => {
    ({ organizationId, token } = await seedWorkspace());
    const res = await fetch(
      `/workspaces/${organizationId}/customers`,
      { method: "POST", body: JSON.stringify({ name: "Hygiene Co" }) },
      token
    );
    customerId = ((await res.json()) as { id: string }).id;
  });

  it("writes and patches hygiene fields", async () => {
    const create = await postDeal({
      customerId,
      name: "Scout import",
      externalId: "gplace:abc123",
      nextStepText: "Call owner re: terminal",
      nextStepDueAt: "2026-10-20T00:00:00.000Z",
      needsHuman: true,
      needsHumanReason: "owner asked for a person",
      priorityScore: 87.5,
    });
    expect(create.status).toBe(201);
    const { deal } = (await create.json()) as { deal: unknown };
    const parsed = dealShape.parse(deal);
    expect(parsed.externalId).toBe("gplace:abc123");
    expect(parsed.nextStepText).toBe("Call owner re: terminal");
    expect(parsed.nextStepDueAt).toBe("2026-10-20T00:00:00.000Z");
    expect(parsed.needsHuman).toBe(true);
    expect(parsed.needsHumanReason).toBe("owner asked for a person");
    expect(parsed.priorityScore).toBe(87.5);

    const patch = await fetch(
      `/workspaces/${organizationId}/deals/${parsed.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          nextStepText: null,
          nextStepDueAt: "2026-10-22T00:00:00.000Z",
          needsHuman: false,
          priorityScore: 40,
        }),
      },
      token
    );
    expect(patch.status).toBe(200);
    const patched = dealShape.parse(
      ((await patch.json()) as { deal: unknown }).deal
    );
    expect(patched.nextStepText).toBeNull();
    expect(patched.nextStepDueAt).toBe("2026-10-22T00:00:00.000Z");
    expect(patched.needsHuman).toBe(false);
    expect(patched.priorityScore).toBe(40);
  });

  it("dedupes create on externalId — replay returns the same record", async () => {
    const first = await postDeal(
      { customerId, name: "Dedupe me", externalId: "gplace:dedup-1" },
      ""
    );
    expect(first.status).toBe(201);
    const firstDeal = dealShape.parse(
      ((await first.json()) as { deal: unknown }).deal
    );

    // Same key, different name — import replay returns the existing record.
    const replay = await postDeal(
      { customerId, name: "Dedupe me AGAIN", externalId: "gplace:dedup-1" },
      ""
    );
    expect(replay.status).toBe(200);
    const replayDeal = dealShape.parse(
      ((await replay.json()) as { deal: unknown }).deal
    );
    expect(replayDeal.id).toBe(firstDeal.id);
    expect(replayDeal.name).toBe("Dedupe me");

    // dedupe=block turns the collision into a hard 409.
    const blocked = await postDeal(
      { customerId, name: "Third", externalId: "gplace:dedup-1" },
      "?dedupe=block"
    );
    expect(blocked.status).toBe(409);
    const err = (await blocked.json()) as {
      details?: { deal?: { id: string } };
    };
    expect(err.details?.deal?.id).toBe(firstDeal.id);

    // Different key still creates.
    const other = await postDeal(
      { customerId, name: "Other", externalId: "gplace:dedup-2" },
      "?dedupe=block"
    );
    expect(other.status).toBe(201);
  });

  it("filters lists by stage, dueBefore, cold, and needsHuman", async () => {
    const mk = async (body: Record<string, unknown>) => {
      const res = await postDeal(body);
      expect(res.status).toBe(201);
      return dealShape.parse(((await res.json()) as { deal: unknown }).deal);
    };
    const openNoStep = await mk({
      customerId,
      name: "Cold lead",
      stage: "lead",
    });
    const openWithStep = await mk({
      customerId,
      name: "Working",
      stage: "qualified",
      nextStepText: "Send proposal",
      nextStepDueAt: "2026-10-18T00:00:00.000Z",
    });
    const flagged = await mk({
      customerId,
      name: "Needs human",
      stage: "lead",
      needsHuman: true,
      needsHumanReason: "vip",
      nextStepText: "x",
      nextStepDueAt: "2026-11-30T00:00:00.000Z",
    });
    const closed = await mk({
      customerId,
      name: "Old won",
      stage: "won",
    });

    const list = async (query: string) => {
      const res = await fetch(
        `/workspaces/${organizationId}/deals?${query}`,
        {},
        token
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { deals: { id: string }[] }).deals.map(
        (d) => d.id
      );
    };

    const stageLead = await list("stage=lead");
    expect(stageLead).toContain(openNoStep.id);
    expect(stageLead).toContain(flagged.id);
    expect(stageLead).not.toContain(openWithStep.id);

    const dueSoon = await list("dueBefore=2026-10-25T00:00:00.000Z");
    expect(dueSoon).toContain(openWithStep.id);
    expect(dueSoon).not.toContain(openNoStep.id);
    expect(dueSoon).not.toContain(flagged.id);

    // Cold = open + no next step + no due date. Won/lost deals aren't leads.
    const cold = await list("cold=true");
    expect(cold).toContain(openNoStep.id);
    expect(cold).not.toContain(openWithStep.id);
    expect(cold).not.toContain(flagged.id);
    expect(cold).not.toContain(closed.id);

    const human = await list("needsHuman=true");
    expect(human).toContain(flagged.id);
    expect(human).not.toContain(openNoStep.id);
  });
});
