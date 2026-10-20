import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { hmacSha256Hex } from "../global/crypto.js";
import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

const SECRET = "whsec_api_test";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-external-events",
      name: "External Events User",
      email: "external-events-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-external-events");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "External events test",
    slug: `external-events-${crypto.randomUUID()}`,
    key: `E${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-external-events",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-external-events",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
      permissions: { workspace: ["admin"] },
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

/** Posts a signed provider event — no workspace credential; the HMAC over
 *  the raw body is the auth. */
async function postEvent(
  organizationId: string,
  source: string,
  body: string,
  opts: { secret?: string; eventId?: string } = {}
) {
  const signature = await hmacSha256Hex(opts.secret ?? SECRET, body);
  const headers: Record<string, string> = {
    "X-Pile-Signature": `v1=${signature}`,
  };
  if (opts.eventId) headers["X-Pile-Event-Id"] = opts.eventId;
  return fetch(`/workspaces/${organizationId}/external-events/${source}`, {
    method: "POST",
    headers,
    body,
  });
}

const ingestResultSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
  deliveryId: z.string().optional(),
  outcome: z.string().optional(),
  completedIssueIds: z.array(z.string()).optional(),
});

const mappingSchema = z.object({
  id: z.string(),
  source: z.string(),
  eventType: z.string(),
  entityType: z.string(),
  matchPath: z.string(),
  stepKey: z.string(),
  enabled: z.boolean(),
});

describe("external events (PILE-422)", () => {
  let organizationId = "";
  let token = "";

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("CRUDs mappings and never returns the secret", async () => {
    const created = await fetch(
      `/workspaces/${organizationId}/external-event-mappings`,
      {
        method: "POST",
        body: JSON.stringify({
          source: "Finix",
          eventType: "merchant.approved",
          entityType: "customer",
          matchPath: "data.merchant_id",
          stepKey: "Approved",
          secret: SECRET,
        }),
      },
      token
    );
    expect(created.status).toBe(201);
    const { mapping } = z
      .object({ mapping: mappingSchema.passthrough() })
      .parse(await created.json());
    expect(mapping.source).toBe("finix");
    expect(mapping.stepKey).toBe("approved");
    expect(mapping.eventType).toBe("merchant.approved");
    expect("secret" in mapping).toBe(false);

    const list = await fetch(
      `/workspaces/${organizationId}/external-event-mappings?source=finix`,
      {},
      token
    );
    expect(list.status).toBe(200);
    const { mappings } = z
      .object({ mappings: z.array(mappingSchema.passthrough()) })
      .parse(await list.json());
    expect(mappings.some((m) => m.id === mapping.id)).toBe(true);
    expect(mappings.every((m) => !("secret" in m))).toBe(true);
  });

  it("completes the mapped sub-step on a signed event, idempotently", async () => {
    const customerRes = await fetch(
      `/workspaces/${organizationId}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ name: "Acme", externalId: "finix-mu-9" }),
      },
      token
    );
    expect(customerRes.status).toBe(201);
    const customer = z
      .object({ id: z.string() })
      .parse(await customerRes.json());

    const parentRes = await fetch(
      `/workspaces/${organizationId}/issues`,
      { method: "POST", body: JSON.stringify({ title: "Deal — Acme" }) },
      token
    );
    const parent = z.object({ id: z.string() }).parse(await parentRes.json());
    await fetch(
      `/workspaces/${organizationId}/entities/customer/${customer.id}/links`,
      {
        method: "POST",
        body: JSON.stringify({ toType: "issue", toId: parent.id }),
      },
      token
    );
    const childRes = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Approved",
          parentId: parent.id,
          stepKey: "approved",
        }),
      },
      token
    );
    const child = z.object({ id: z.string() }).parse(await childRes.json());

    const body = JSON.stringify({
      id: "evt_finix_1",
      type: "merchant.approved",
      data: { merchant_id: "finix-mu-9" },
    });
    const applied = await postEvent(organizationId, "finix", body);
    expect(applied.status).toBe(200);
    const result = ingestResultSchema.parse(await applied.json());
    expect(result.status).toBe("applied");
    expect(result.completedIssueIds).toEqual([child.id]);

    const childrenRes = await fetch(
      `/workspaces/${organizationId}/issues?parentId=${parent.id}`,
      {},
      token
    );
    const { issues } = z
      .object({
        issues: z.array(
          z.object({
            id: z.string(),
            status: z.string(),
            stepKey: z.string().nullable(),
          })
        ),
      })
      .parse(await childrenRes.json());
    expect(issues.find((i) => i.id === child.id)?.status).toBe("done");

    // A replay with the same event id is a recorded no-op.
    const replay = await postEvent(organizationId, "finix", body);
    expect(replay.status).toBe(200);
    const replayed = ingestResultSchema.parse(await replay.json());
    expect(replayed.status).toBe("replay");
    expect(replayed.outcome).toBe("applied");
    expect(replayed.deliveryId).toBe(result.deliveryId);

    // The delivery ledger records the applied event.
    const deliveriesRes = await fetch(
      `/workspaces/${organizationId}/external-event-deliveries?source=finix`,
      {},
      token
    );
    expect(deliveriesRes.status).toBe(200);
    const { deliveries } = z
      .object({
        deliveries: z.array(
          z.object({
            source: z.string(),
            eventType: z.string().nullable(),
            status: z.string(),
            completedIssueIds: z.array(z.string()),
          })
        ),
      })
      .parse(await deliveriesRes.json());
    const row = deliveries.find((d) => d.eventType === "merchant.approved");
    expect(row?.status).toBe("applied");
    expect(row?.completedIssueIds).toEqual([child.id]);
  });

  it("rejects a bad signature and logs it without changing state", async () => {
    const res = await postEvent(
      organizationId,
      "finix",
      JSON.stringify({
        id: "evt_bad",
        type: "merchant.approved",
        data: { merchant_id: "finix-mu-9" },
      }),
      { secret: "attacker-secret" }
    );
    expect(res.status).toBe(401);

    const deliveriesRes = await fetch(
      `/workspaces/${organizationId}/external-event-deliveries?status=invalid_signature`,
      {},
      token
    );
    const { deliveries } = z
      .object({ deliveries: z.array(z.object({ status: z.string() })) })
      .parse(await deliveriesRes.json());
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 404 for an unconfigured source and 200 for unmapped events", async () => {
    const unknown = await postEvent(
      organizationId,
      "unknown-provider",
      JSON.stringify({ id: "e1", type: "x.y" })
    );
    expect(unknown.status).toBe(404);

    const unmapped = await postEvent(
      organizationId,
      "finix",
      JSON.stringify({
        id: "evt_unmapped",
        type: "merchant.declined",
        data: { merchant_id: "finix-mu-9" },
      })
    );
    expect(unmapped.status).toBe(200);
    expect(ingestResultSchema.parse(await unmapped.json()).status).toBe(
      "unmapped"
    );
  });

  it("disabling a mapping turns the source off for ingest", async () => {
    const created = await fetch(
      `/workspaces/${organizationId}/external-event-mappings`,
      {
        method: "POST",
        body: JSON.stringify({
          source: "seal",
          eventType: "agreement.signed",
          entityType: "customer",
          matchPath: "deal_ref",
          stepKey: "agreement_signed",
          secret: SECRET,
        }),
      },
      token
    );
    const { mapping } = z
      .object({ mapping: mappingSchema })
      .parse(await created.json());

    await fetch(
      `/workspaces/${organizationId}/external-event-mappings/${mapping.id}`,
      { method: "PATCH", body: JSON.stringify({ enabled: false }) },
      token
    );

    const res = await postEvent(
      organizationId,
      "seal",
      JSON.stringify({ id: "s1", type: "agreement.signed", deal_ref: "x" })
    );
    // No enabled mappings → the source is not configured.
    expect(res.status).toBe(404);

    const removed = await fetch(
      `/workspaces/${organizationId}/external-event-mappings/${mapping.id}`,
      { method: "DELETE" },
      token
    );
    expect(removed.status).toBe(200);
  });
});
