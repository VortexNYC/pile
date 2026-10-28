import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { getWorkspaceStub } from "../api/stub.js";
import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAdminHeaders } from "../platform/test-auth.js";

const SMS_SECRET = "test-sms-inbound-secret";
// Matches wrangler.test.toml BETTER_AUTH_URL — an allowed origin so the
// CSRF middleware lets the secret-checked request through. Bearer-carried
// secrets skip the origin check entirely (the agent-session webhook
// pattern), covered by its own test below.
const ALLOWED_ORIGIN = "https://pile.example.workers.dev";

const smsResponseSchema = z.object({
  ok: z.literal(true),
  deduplicated: z.boolean(),
  customer: z
    .object({
      id: z.string(),
      name: z.string(),
      phone: z.string().nullable(),
      statusId: z.string().nullable(),
      nextStepText: z.string().nullable(),
      nextStepDueAt: z.string().nullable(),
    })
    .nullable(),
  actions: z.array(z.object({ type: z.string() }).passthrough()),
  replyText: z.string(),
});

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-sms",
      name: "SMS User",
      email: "sms-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-sms");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "SMS inbound test",
    slug: `sms-inbound-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-sms",
  });
  return { organizationId: workspace!.id };
}

function smsPost(
  organizationId: string,
  body: unknown,
  opts: {
    secret?: string;
    headerSecret?: string;
    bearerSecret?: string;
    origin?: string;
  } = {}
): Promise<Response> {
  const url = new URL(
    `https://example.com/workspaces/${organizationId}/customers/sms-inbound`
  );
  if (opts.secret !== undefined) url.searchParams.set("secret", opts.secret);
  return app.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: opts.origin ?? ALLOWED_ORIGIN,
        ...(opts.headerSecret !== undefined
          ? { "x-sms-secret": opts.headerSecret }
          : {}),
        ...(opts.bearerSecret !== undefined
          ? { Authorization: `Bearer ${opts.bearerSecret}` }
          : {}),
      },
      body: JSON.stringify(body),
    }),
    env
  ) as Promise<Response>;
}

describe("sms-inbound agent webhook (PILE-395)", () => {
  let organizationId: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    env.SMS_INBOUND_SECRET = SMS_SECRET;
  });

  it("rejects with 503 NOT_CONFIGURED when SMS_INBOUND_SECRET is unset", async () => {
    delete (env as Record<string, unknown>).SMS_INBOUND_SECRET;
    try {
      const res = await smsPost(
        organizationId,
        { from: "+15551234567", text: "knocked 1 Main St" },
        { secret: SMS_SECRET }
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("NOT_CONFIGURED");
    } finally {
      env.SMS_INBOUND_SECRET = SMS_SECRET;
    }
  });

  it("rejects with 401 on a missing or wrong secret", async () => {
    const noSecret = await smsPost(organizationId, {
      from: "+15551234567",
      text: "hi",
    });
    expect(noSecret.status).toBe(401);
    const body = (await noSecret.json()) as { code?: string };
    expect(body.code).toBe("UNAUTHORIZED");

    const wrongSecret = await smsPost(
      organizationId,
      { from: "+15551234567", text: "hi" },
      { secret: "nope" }
    );
    expect(wrongSecret.status).toBe(401);

    const wrongHeader = await smsPost(
      organizationId,
      { from: "+15551234567", text: "hi" },
      { headerSecret: "also-nope" }
    );
    expect(wrongHeader.status).toBe(401);

    const wrongBearer = await smsPost(
      organizationId,
      { from: "+15551234567", text: "hi" },
      { bearerSecret: "bad-bearer" }
    );
    expect(wrongBearer.status).toBe(401);
  });

  it("accepts the secret via Authorization: Bearer (provider header)", async () => {
    const res = await smsPost(
      organizationId,
      { from: "+15550001111", text: "gate was locked, will swing by later" },
      { bearerSecret: SMS_SECRET, origin: "" }
    );
    expect(res.status).toBe(200);
    const body = smsResponseSchema.parse(await res.json());
    expect(body.deduplicated).toBe(false);
    expect(body.customer?.phone).toBe("+15550001111");
  });

  it("accepts the secret via x-sms-secret header and logs a bare note", async () => {
    const res = await smsPost(
      organizationId,
      { from: "+15550002222", text: "left a flyer at the deli" },
      { headerSecret: SMS_SECRET }
    );
    expect(res.status).toBe(200);
    const body = smsResponseSchema.parse(await res.json());
    expect(body.deduplicated).toBe(false);
    expect(body.customer?.phone).toBe("+15550002222");
    expect(body.replyText.length).toBeGreaterThan(0);
  });

  it("parses knock + quote + follow-up and bridges all three into CRM", async () => {
    const res = await smsPost(
      organizationId,
      {
        from: "+15551234567",
        text: "knocked 276 Wilson Ave talked to Miro wants XRF follow up Friday quoted $225",
        messageId: `msg-${crypto.randomUUID()}`,
      },
      { secret: SMS_SECRET }
    );
    expect(res.status).toBe(200);
    const body = smsResponseSchema.parse(await res.json());
    expect(body.deduplicated).toBe(false);

    const types = body.actions.map((a) => a.type);
    expect(types).toContain("interaction_logged");
    expect(types).toContain("deal_created");
    expect(types).toContain("follow_up_set");

    const dealAction = body.actions.find((a) => a.type === "deal_created");
    expect(
      (dealAction as { amountCents?: number } | undefined)?.amountCents
    ).toBe(22500);

    expect(body.replyText).toContain("276 Wilson Ave");
    expect(body.replyText).toContain("$225");
    expect(body.replyText).toContain("Follow-up");

    // The follow-up due date lands on a Friday.
    const customer = body.customer;
    expect(customer?.nextStepDueAt).toBeTruthy();
    expect(new Date(customer!.nextStepDueAt!).getUTCDay()).toBe(5);

    // Verify through the workspace DO: customer by phone, deal at
    // proposal stage with the quoted amount.
    const stub = getWorkspaceStub(env, organizationId);
    const deals = await stub.listDeals({ stage: "proposal" });
    const deal = deals.find(
      (row) => row.customerId === customer!.id && row.amountCents === 22500
    );
    expect(deal).toBeTruthy();
    const stored = await stub.getCustomer(customer!.id);
    expect(stored?.phone).toBe("+15551234567");
    expect(stored?.source).toBe("sms_inbound");
    expect(stored?.nextStepDueAt).toBe(customer!.nextStepDueAt);
  });

  it("dedupes a retried webhook on messageId", async () => {
    const messageId = `dedupe-${crypto.randomUUID()}`;
    const first = await smsPost(
      organizationId,
      {
        from: "+15559876543",
        text: "knocked 12 Court St quoted $500",
        messageId,
      },
      { secret: SMS_SECRET }
    );
    expect(first.status).toBe(200);
    const firstBody = smsResponseSchema.parse(await first.json());
    expect(firstBody.deduplicated).toBe(false);

    const stub = getWorkspaceStub(env, organizationId);
    const beforeDeals = (await stub.listDeals()).filter(
      (row) => row.customerId === firstBody.customer!.id
    );

    const retry = await smsPost(
      organizationId,
      {
        from: "+15559876543",
        text: "knocked 12 Court St quoted $500",
        messageId,
      },
      { secret: SMS_SECRET }
    );
    expect(retry.status).toBe(200);
    const retryBody = smsResponseSchema.parse(await retry.json());
    expect(retryBody.deduplicated).toBe(true);
    expect(retryBody.actions).toEqual([]);
    expect(retryBody.customer?.id).toBe(firstBody.customer!.id);

    const afterDeals = (await stub.listDeals()).filter(
      (row) => row.customerId === firstBody.customer!.id
    );
    expect(afterDeals.length).toBe(beforeDeals.length);
    expect(beforeDeals.length).toBe(1);
  });

  it("answers a due-list query with pending follow-ups", async () => {
    const res = await smsPost(
      organizationId,
      { from: "+15551234567", text: "what's due" },
      { secret: SMS_SECRET }
    );
    expect(res.status).toBe(200);
    const body = smsResponseSchema.parse(await res.json());
    const dueAction = body.actions.find((a) => a.type === "due_list");
    expect(dueAction).toBeTruthy();
  });
});
