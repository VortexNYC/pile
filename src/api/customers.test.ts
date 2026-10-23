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
      id: "user-customers",
      name: "Customers User",
      email: "customers-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-customers");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Customers test",
    slug: `customers-${crypto.randomUUID()}`,
    key: `C${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-customers",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-customers",
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

const attachmentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  customerId: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  r2Key: z.string(),
  url: z.string(),
  createdById: z.string().nullable(),
  createdAt: z.string(),
});

async function createCustomer(
  organizationId: string,
  token: string,
  name = "Acme Corp"
) {
  const res = await fetch(
    `/workspaces/${organizationId}/customers`,
    { method: "POST", body: JSON.stringify({ name }) },
    token
  );
  expect(res.status).toBe(201);
  return z.object({ id: z.string() }).parse(await res.json());
}

describe("customers API", () => {
  it("round-trips bookingUrl", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/customers`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Cal Co",
          bookingUrl: "https://cal.com/acme/sync",
        }),
      },
      token
    );
    expect(res.status).toBe(201);
    const created = z
      .object({ id: z.string(), bookingUrl: z.string().nullable() })
      .parse(await res.json());
    expect(created.bookingUrl).toBe("https://cal.com/acme/sync");

    const updated = await fetch(
      `/workspaces/${organizationId}/customers/${created.id}`,
      { method: "PATCH", body: JSON.stringify({ bookingUrl: null }) },
      token
    );
    expect(updated.status).toBe(200);
    const body = z
      .object({ bookingUrl: z.string().nullable() })
      .parse(await updated.json());
    expect(body.bookingUrl).toBeNull();
  });
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("sets and clears a customer's website", async () => {
    const customer = await createCustomer(organizationId, token, "Web Co");
    const path = `/workspaces/${organizationId}/customers/${customer.id}`;
    const urlSchema = z.object({ url: z.string().nullable() });

    const set = await fetch(
      path,
      { method: "PATCH", body: JSON.stringify({ url: "https://web.example" }) },
      token
    );
    expect(set.status).toBe(200);
    expect(urlSchema.parse(await set.json()).url).toBe("https://web.example");

    const cleared = await fetch(
      path,
      { method: "PATCH", body: JSON.stringify({ url: null }) },
      token
    );
    expect(cleared.status).toBe(200);
    expect(urlSchema.parse(await cleared.json()).url).toBeNull();
  });

  it("rejects attachment requests without auth", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/customers/some-id/attachments`
    );
    expect(res.status).toBe(401);
  });

  it("uploads, lists, reads, downloads, and deletes a customer attachment", async () => {
    const customer = await createCustomer(organizationId, token);
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 1, 2, 3]);

    const upload = await fetch(
      `/workspaces/${organizationId}/customers/${customer.id}/attachments`,
      {
        method: "POST",
        body: JSON.stringify({
          fileName: "statement.pdf",
          contentType: "application/pdf",
          contentBase64: btoa(String.fromCharCode(...bytes)),
        }),
      },
      token
    );
    expect(upload.status).toBe(201);
    const attachment = attachmentSchema.parse(await upload.json());
    expect(attachment.customerId).toBe(customer.id);
    expect(attachment.fileName).toBe("statement.pdf");
    expect(attachment.contentType).toBe("application/pdf");
    expect(attachment.size).toBe(bytes.length);
    expect(attachment.r2Key).toMatch(
      new RegExp(`^attachments/${organizationId}/customer/${customer.id}/`)
    );

    const stored = await env.ATTACHMENTS_BUCKET.get(attachment.r2Key);
    expect(stored).not.toBeNull();
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);

    const list = await fetch(
      `/workspaces/${organizationId}/customers/${customer.id}/attachments`,
      {},
      token
    );
    expect(list.status).toBe(200);
    const { attachments } = z
      .object({ attachments: z.array(attachmentSchema) })
      .parse(await list.json());
    expect(attachments.map((a) => a.id)).toContain(attachment.id);

    const meta = await fetch(
      `/workspaces/${organizationId}/customers/${customer.id}/attachments/${attachment.id}`,
      {},
      token
    );
    expect(meta.status).toBe(200);
    expect(attachmentSchema.parse(await meta.json()).r2Key).toBe(
      attachment.r2Key
    );

    const content = await fetch(attachment.url, {}, token);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("application/pdf");
    expect(content.headers.get("content-disposition")).toBe(
      'attachment; filename="statement.pdf"'
    );
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);

    const del = await fetch(
      `/workspaces/${organizationId}/customers/${customer.id}/attachments/${attachment.id}`,
      { method: "DELETE" },
      token
    );
    expect(del.status).toBe(204);
    expect(await env.ATTACHMENTS_BUCKET.get(attachment.r2Key)).toBeNull();

    const after = await fetch(
      `/workspaces/${organizationId}/customers/${customer.id}/attachments/${attachment.id}`,
      {},
      token
    );
    expect(after.status).toBe(404);
  });

  it("defaults contentType when omitted", async () => {
    const customer = await createCustomer(organizationId, token);
    const res = await fetch(
      `/workspaces/${organizationId}/customers/${customer.id}/attachments`,
      {
        method: "POST",
        body: JSON.stringify({
          fileName: "photo.jpg",
          contentBase64: btoa("binary-photo"),
        }),
      },
      token
    );
    expect(res.status).toBe(201);
    const attachment = attachmentSchema.parse(await res.json());
    expect(attachment.contentType).toBe("application/octet-stream");
  });

  it("404s when listing or uploading to a missing customer", async () => {
    const missing = crypto.randomUUID();
    const list = await fetch(
      `/workspaces/${organizationId}/customers/${missing}/attachments`,
      {},
      token
    );
    expect(list.status).toBe(404);

    const upload = await fetch(
      `/workspaces/${organizationId}/customers/${missing}/attachments`,
      {
        method: "POST",
        body: JSON.stringify({
          fileName: "x.txt",
          contentBase64: btoa("x"),
        }),
      },
      token
    );
    expect(upload.status).toBe(404);
  });

  it("scopes attachment access to the owning customer", async () => {
    const owner = await createCustomer(organizationId, token, "Owner");
    const other = await createCustomer(organizationId, token, "Other");
    const upload = await fetch(
      `/workspaces/${organizationId}/customers/${owner.id}/attachments`,
      {
        method: "POST",
        body: JSON.stringify({
          fileName: "onboarding.docx",
          contentBase64: btoa("doc-bytes"),
        }),
      },
      token
    );
    const attachment = attachmentSchema.parse(await upload.json());

    for (const [method, suffix] of [
      ["GET", ""],
      ["GET", "/content"],
      ["DELETE", ""],
    ] as const) {
      const res = await fetch(
        `/workspaces/${organizationId}/customers/${other.id}/attachments/${attachment.id}${suffix}`,
        { method },
        token
      );
      expect(res.status).toBe(404);
    }
  });

  it("removes attachment rows and R2 objects when the customer is deleted", async () => {
    const customer = await createCustomer(organizationId, token, "Doomed");
    const upload = await fetch(
      `/workspaces/${organizationId}/customers/${customer.id}/attachments`,
      {
        method: "POST",
        body: JSON.stringify({
          fileName: "contract.pdf",
          contentBase64: btoa("contract-bytes"),
        }),
      },
      token
    );
    expect(upload.status).toBe(201);
    const attachment = attachmentSchema.parse(await upload.json());

    const del = await fetch(
      `/workspaces/${organizationId}/customers/${customer.id}`,
      { method: "DELETE" },
      token
    );
    expect(del.status).toBe(204);

    expect(await env.ATTACHMENTS_BUCKET.get(attachment.r2Key)).toBeNull();
    const content = await fetch(attachment.url, {}, token);
    expect(content.status).toBe(404);
  });
});

describe("customer hygiene fields + externalId dedupe", () => {
  let organizationId = "";
  let token = "";

  const customerShape = z.object({
    id: z.string(),
    name: z.string(),
    externalId: z.string().nullable(),
    nextStepText: z.string().nullable(),
    nextStepDueAt: z.string().nullable(),
    needsHuman: z.boolean().nullable(),
    needsHumanReason: z.string().nullable(),
    priorityScore: z.number().nullable(),
  });

  async function postCustomer(body: Record<string, unknown>, query = "") {
    return fetch(
      `/workspaces/${organizationId}/customers${query}`,
      { method: "POST", body: JSON.stringify(body) },
      token
    );
  }

  beforeAll(async () => {
    ({ organizationId, token } = await seedWorkspace());
  });

  it("writes and patches hygiene fields", async () => {
    const create = await postCustomer({
      name: "Scout merchant",
      externalId: "gplace:m-1",
      nextStepText: "Verify POS compatibility",
      nextStepDueAt: "2026-10-19T00:00:00.000Z",
      needsHuman: true,
      needsHumanReason: "language barrier",
      priorityScore: 91.25,
    });
    expect(create.status).toBe(201);
    const created = customerShape.parse(await create.json());
    expect(created.externalId).toBe("gplace:m-1");
    expect(created.nextStepText).toBe("Verify POS compatibility");
    expect(created.needsHuman).toBe(true);
    expect(created.needsHumanReason).toBe("language barrier");
    expect(created.priorityScore).toBe(91.25);

    const patch = await fetch(
      `/workspaces/${organizationId}/customers/${created.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ needsHuman: false, priorityScore: null }),
      },
      token
    );
    expect(patch.status).toBe(200);
    const patched = customerShape.parse(await patch.json());
    expect(patched.needsHuman).toBe(false);
    expect(patched.priorityScore).toBeNull();
  });

  it("dedupes create on externalId — replay returns the same record", async () => {
    const first = await postCustomer({
      name: "Dedup Cafe",
      externalId: "gplace:cafe-1",
    });
    expect(first.status).toBe(201);
    const firstCustomer = customerShape.parse(await first.json());

    const replay = await postCustomer({
      name: "Dedup Cafe (second run)",
      externalId: "gplace:cafe-1",
    });
    expect(replay.status).toBe(200);
    const replayed = customerShape.parse(await replay.json());
    expect(replayed.id).toBe(firstCustomer.id);
    expect(replayed.name).toBe("Dedup Cafe");

    const blocked = await postCustomer(
      { name: "Third", externalId: "gplace:cafe-1" },
      "?dedupe=block"
    );
    expect(blocked.status).toBe(409);
    const err = (await blocked.json()) as {
      details?: { customer?: { id: string } };
    };
    expect(err.details?.customer?.id).toBe(firstCustomer.id);
  });

  const mk = async (body: Record<string, unknown>) => {
    const res = await postCustomer(body);
    expect(res.status).toBe(201);
    return customerShape.parse(await res.json());
  };

  const list = async (query: string) => {
    const res = await fetch(
      `/workspaces/${organizationId}/customers?${query}`,
      {},
      token
    );
    expect(res.status).toBe(200);
    return (
      (await res.json()) as { customers: { id: string }[] }
    ).customers.map((c) => c.id);
  };

  it("filters lists by cold, dueBefore, and needsHuman", async () => {
    const cold = await mk({ name: "No next step" });
    const warm = await mk({
      name: "Scheduled",
      nextStepDueAt: "2026-10-18T00:00:00.000Z",
    });
    const flagged = await mk({
      name: "Escalated",
      needsHuman: true,
      nextStepText: "call back",
      nextStepDueAt: "2026-11-30T00:00:00.000Z",
    });

    const coldIds = await list("cold=true");
    expect(coldIds).toContain(cold.id);
    expect(coldIds).not.toContain(warm.id);
    expect(coldIds).not.toContain(flagged.id);

    const dueSoon = await list("dueBefore=2026-10-25T00:00:00.000Z");
    expect(dueSoon).toContain(warm.id);
    expect(dueSoon).not.toContain(cold.id);
    expect(dueSoon).not.toContain(flagged.id);

    const human = await list("needsHuman=true");
    expect(human).toContain(flagged.id);
    expect(human).not.toContain(cold.id);
  });

  it("round-trips domain normalized on create and PATCH (PILE-444)", async () => {
    const create = await postCustomer({
      name: "Domain merchant",
      domain: "HTTPS://WWW.JoesPizza.example.com/menu",
    });
    expect(create.status).toBe(201);
    const created = z
      .object({ id: z.string(), domain: z.string().nullable() })
      .parse(await create.json());
    expect(created.domain).toBe("joespizza.example.com");

    const patch = await fetch(
      `/workspaces/${organizationId}/customers/${created.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ domain: "https://newsite.example.com/" }),
      },
      token
    );
    expect(patch.status).toBe(200);
    const patched = z
      .object({ domain: z.string().nullable() })
      .parse(await patch.json());
    expect(patched.domain).toBe("newsite.example.com");

    const cleared = await fetch(
      `/workspaces/${organizationId}/customers/${created.id}`,
      { method: "PATCH", body: JSON.stringify({ domain: null }) },
      token
    );
    expect(cleared.status).toBe(200);
    expect(
      z.object({ domain: z.string().nullable() }).parse(await cleared.json())
        .domain
    ).toBeNull();
  });

  it("filters lists by externalId and domain — domain input is normalized (PILE-444)", async () => {
    const target = await mk({
      name: "Filter target",
      externalId: "gplace:flt-1",
      domain: "www.Filtered.example.com",
    });
    const other = await mk({ name: "Unfiltered", externalId: "gplace:flt-2" });

    expect(await list("externalId=gplace:flt-1")).toEqual([target.id]);
    expect(await list("domain=filtered.example.com")).toEqual([target.id]);
    // Lookup input normalizes too — scheme/www./case all hit the same row.
    expect(await list("domain=HTTPS://WWW.Filtered.example.com/")).toEqual([
      target.id,
    ]);
    expect(await list("domain=filtered.example.com")).not.toContain(other.id);
    expect(await list("externalId=gplace:missing")).toEqual([]);
  });
});

describe("customer custom fields (PILE-383)", () => {
  let organizationId = "";
  let token = "";

  const customerShape = z.object({
    id: z.string(),
    name: z.string(),
    customFields: z.record(z.string(), z.string()),
  });

  beforeAll(async () => {
    ({ organizationId, token } = await seedWorkspace());
  });

  it("writes name-keyed custom fields on create and reads them back", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/customers`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Fielded Merchant",
          customFields: {
            merchant_type: "restaurant",
            processor: "square",
            address: "123 Main St",
            phone: "+1 212 555 0100",
            batch_week: "2026-W42",
          },
        }),
      },
      token
    );
    expect(res.status).toBe(201);
    const created = customerShape.parse(await res.json());
    expect(created.customFields.processor).toBe("square");
    expect(created.customFields.batch_week).toBe("2026-W42");

    // Unknown field names auto-create text definitions the workspace can
    // later re-type via /fields.
    const fields = await fetch(
      `/workspaces/${organizationId}/fields?entityType=customer`,
      {},
      token
    );
    const defs = z
      .object({
        fields: z.array(z.object({ name: z.string(), type: z.string() })),
      })
      .parse(await fields.json());
    expect(defs.fields.map((f) => f.name)).toContain("processor");

    const got = await fetch(
      `/workspaces/${organizationId}/customers/${created.id}`,
      {},
      token
    );
    expect(customerShape.parse(await got.json()).customFields.address).toBe(
      "123 Main St"
    );
  });

  it("patches field values and clears them with null", async () => {
    const created = await fetch(
      `/workspaces/${organizationId}/customers`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Patchable",
          customFields: { processor: "toast" },
        }),
      },
      token
    );
    const customer = customerShape.parse(await created.json());

    const patched = await fetch(
      `/workspaces/${organizationId}/customers/${customer.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          customFields: { processor: "stripe", batch_week: null },
        }),
      },
      token
    );
    expect(patched.status).toBe(200);
    const body = customerShape.parse(await patched.json());
    expect(body.customFields.processor).toBe("stripe");
    expect(body.customFields.batch_week).toBeUndefined();
  });

  it("rejects values that violate a declared field type", async () => {
    // Declare a select field, then write a value outside its options.
    const define = await fetch(
      `/workspaces/${organizationId}/fields`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "customer",
          name: "merchant_size",
          type: "select",
          options: ["small", "mid", "enterprise"],
        }),
      },
      token
    );
    expect(define.status).toBe(201);

    const res = await fetch(
      `/workspaces/${organizationId}/customers`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Bad field value",
          customFields: { merchant_size: "huge" },
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });
});

describe("bulk customer import (PILE-403)", () => {
  let organizationId = "";
  let token = "";

  const rowReceipt = z.object({
    index: z.number().int(),
    externalId: z.string().nullable(),
    outcome: z.enum(["created", "existing", "failed"]),
    customerId: z.string().optional(),
    dealId: z.string().optional(),
    error: z.string().optional(),
  });
  const receiptShape = z.object({
    id: z.string(),
    organizationId: z.string(),
    source: z.string().nullable(),
    corridor: z.string().nullable(),
    total: z.number().int(),
    created: z.number().int(),
    existing: z.number().int(),
    failed: z.number().int(),
    rows: z.array(rowReceipt),
    createdAt: z.string(),
  });

  async function postImport(body: Record<string, unknown>) {
    return fetch(
      `/workspaces/${organizationId}/customers/import`,
      { method: "POST", body: JSON.stringify(body) },
      token
    );
  }

  beforeAll(async () => {
    ({ organizationId, token } = await seedWorkspace());
  });

  it("imports rows as deduped customers + deals and persists a receipt", async () => {
    const res = await postImport({
      source: "scout",
      corridor: "nyc-bakeries",
      rows: [
        {
          placeId: "b-1",
          name: "Bakery One",
          url: "https://bakery-one.example",
          status: "New",
          priorityScore: 88.5,
          customFields: { processor: "square", review_count: "412" },
          deal: { priorityScore: 88.5 },
        },
        {
          placeId: "b-2",
          name: "Bakery Two",
          priorityScore: 40,
        },
      ],
    });
    expect(res.status).toBe(200);
    const receipt = receiptShape.parse(await res.json());
    expect(receipt.source).toBe("scout");
    expect(receipt.corridor).toBe("nyc-bakeries");
    expect(receipt).toMatchObject({
      total: 2,
      created: 2,
      existing: 0,
      failed: 0,
    });
    expect(receipt.rows[0]).toMatchObject({
      index: 0,
      externalId: "gplace:b-1",
      outcome: "created",
    });
    expect(receipt.rows[0]?.dealId).toBeTruthy();
    expect(receipt.rows[1]?.dealId).toBeUndefined();

    const first = z
      .object({
        id: z.string(),
        externalId: z.string().nullable(),
        statusId: z.string().nullable(),
        priorityScore: z.number().nullable(),
        customFields: z.record(z.string(), z.string()),
      })
      .parse(
        await (
          await fetch(
            `/workspaces/${organizationId}/customers/${receipt.rows[0]?.customerId}`,
            {},
            token
          )
        ).json()
      );
    expect(first.externalId).toBe("gplace:b-1");
    expect(first.priorityScore).toBe(88.5);
    expect(first.statusId).toBeTruthy();
    expect(first.customFields.processor).toBe("square");

    // The pipeline column was materialized by name, not uuid.
    const statuses = await fetch(
      `/workspaces/${organizationId}/customer-statuses`,
      {},
      token
    );
    const statusList = z
      .object({ statuses: z.array(z.object({ name: z.string() })) })
      .parse(await statuses.json());
    expect(statusList.statuses.map((s) => s.name)).toContain("New");

    // Receipt is durable — agents can read it back later.
    const stored = await fetch(
      `/workspaces/${organizationId}/customer-imports/${receipt.id}`,
      {},
      token
    );
    expect(stored.status).toBe(200);
    expect(receiptShape.parse(await stored.json()).rows).toHaveLength(2);

    const history = await fetch(
      `/workspaces/${organizationId}/customer-imports`,
      {},
      token
    );
    const summaries = z
      .object({ imports: z.array(receiptShape.omit({ rows: true })) })
      .parse(await history.json());
    expect(summaries.imports.map((i) => i.id)).toContain(receipt.id);
  });

  it("re-runs produce zero new records — every row reports existing", async () => {
    const rows = [
      { placeId: "r-1", name: "Replay One", priorityScore: 10 },
      { placeId: "r-2", name: "Replay Two", priorityScore: 20 },
    ];
    const first = receiptShape.parse(
      await (await postImport({ source: "scout", rows })).json()
    );
    expect(first.created).toBe(2);

    const replay = receiptShape.parse(
      await (await postImport({ source: "scout", rows })).json()
    );
    expect(replay).toMatchObject({
      total: 2,
      created: 0,
      existing: 2,
      failed: 0,
    });
    expect(replay.rows[0]?.customerId).toBe(first.rows[0]?.customerId);
    expect(replay.rows[1]?.customerId).toBe(first.rows[1]?.customerId);
  });

  it("dedupe enriches empty slots but never clobbers set fields", async () => {
    const first = receiptShape.parse(
      await (
        await postImport({
          rows: [{ placeId: "e-1", name: "Enrich Me", url: null }],
        })
      ).json()
    );

    const second = receiptShape.parse(
      await (
        await postImport({
          rows: [
            {
              placeId: "e-1",
              name: "Enrich Me Renamed",
              url: "https://enriched.example",
              priorityScore: 55,
            },
          ],
        })
      ).json()
    );
    expect(second.rows[0]?.outcome).toBe("existing");

    const customer = z
      .object({
        name: z.string(),
        url: z.string().nullable(),
        priorityScore: z.number().nullable(),
      })
      .parse(
        await (
          await fetch(
            `/workspaces/${organizationId}/customers/${first.rows[0]?.customerId}`,
            {},
            token
          )
        ).json()
      );
    // Empty slots fill in; the name the record already had is kept.
    expect(customer.url).toBe("https://enriched.example");
    expect(customer.priorityScore).toBe(55);
    expect(customer.name).toBe("Enrich Me");
  });

  it("records per-row failures without aborting the batch", async () => {
    // A declared select field rejects out-of-options values.
    await fetch(
      `/workspaces/${organizationId}/fields`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "customer",
          name: "region",
          type: "select",
          options: ["north", "south"],
        }),
      },
      token
    );

    const receipt = receiptShape.parse(
      await (
        await postImport({
          rows: [
            { placeId: "ok-1", name: "Good Row" },
            {
              placeId: "bad-1",
              name: "Bad Region",
              customFields: { region: "west" },
            },
          ],
        })
      ).json()
    );
    expect(receipt.created).toBe(1);
    expect(receipt.failed).toBe(1);
    expect(receipt.rows[1]?.outcome).toBe("failed");
    expect(receipt.rows[1]?.error).toContain("region");

    // The failed row never created a customer — a corrected re-run can
    // retry just that place_id.
    expect(receipt.rows[1]?.customerId).toBeUndefined();
  });

  it("statuses carry an immutable key and a terminal type (PILE-438)", async () => {
    const seed = await seedWorkspace();
    const org = seed.organizationId;
    const admin = seed.token;

    const create = await fetch(
      `/workspaces/${org}/customer-statuses`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Onboarding In Flight",
          position: 0,
        }),
      },
      admin
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      id: string;
      key: string | null;
      type: string;
    };
    expect(created.key).toBe("onboarding_in_flight");
    expect(created.type).toBe("active");

    // rename — the key must NOT move with the display name
    const rename = await fetch(
      `/workspaces/${org}/customer-statuses/${created.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: "Live Onboarding" }),
      },
      admin
    );
    const renamed = (await rename.json()) as { key: string | null };
    expect(renamed.key).toBe("onboarding_in_flight");

    // mark terminal
    const term = await fetch(
      `/workspaces/${org}/customer-statuses/${created.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ type: "terminal" }),
      },
      admin
    );
    expect(((await term.json()) as { type: string }).type).toBe("terminal");
  });
});

describe("customer sales fields (readiness/fit)", () => {
  let organizationId = "";
  let token = "";
  beforeAll(async () => {
    ({ organizationId, token } = await seedWorkspace());
  });
  it("round-trips readiness, fit fields, and processor through the API", async () => {
    const created = await fetch(
      `/workspaces/${organizationId}/customers`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Sales Co",
          domain: "salesco.example",
          readiness: "ready",
          fit: "strong",
          fitScore: 0.9,
          processor: "toast",
        }),
      },
      token
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      id?: string;
      customer?: { id?: string };
    };
    const id = body.customer?.id ?? body.id;
    expect(id).toBeTruthy();
    const got = await fetch(
      `/workspaces/${organizationId}/customers/${id}`,
      {},
      token
    );
    const record = (await got.json()) as {
      customer?: { fitScore?: number; processor?: string };
      fitScore?: number;
      processor?: string;
    };
    const customer = record.customer ?? record;
    expect(customer.fitScore).toBe(0.9);
    expect(customer.processor).toBe("toast");
  });

  it("records customer signals, computes Ranker v2 breakdown + Why Now, evaluates send-gate, and resolves SMB dedup keys (PILE-478..533)", async () => {
    const created = await fetch(
      `/workspaces/${organizationId}/customers`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "The Bleecker Street Bistro LLC",
          address: "123 Bleecker Street, New York, NY",
          phone: "(212) 555-0144",
          vertical: "restaurant",
        }),
      },
      token
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      id?: string;
      customer?: { id?: string };
    };
    const cust = { id: (createdBody.customer?.id ?? createdBody.id)! };

    // 1. Record a signal with HTML technographics -> detects Toast POS + updates priorityScore
    const sigRes = await fetch(
      `/workspaces/${organizationId}/customers/${cust.id}/signals`,
      {
        method: "POST",
        body: JSON.stringify({
          source: "website_technographics",
          evidenceUrl: "https://bleeckerbistro.example.com",
          html: '<script src="https://order.toasttab.com/widget.js"></script>',
        }),
      },
      token
    );
    expect(sigRes.status).toBe(201);
    const sigBody = (await sigRes.json()) as {
      signal: { type: string };
      breakdown: { priorityScore: number; whyNow: string };
    };
    expect(sigBody.signal.type).toBe("pos_detected");
    expect(sigBody.breakdown.priorityScore).toBeGreaterThan(0);
    expect(sigBody.breakdown.whyNow).toContain("TOAST");

    // 2. GET /customers/:id/signals returns the persisted signal + breakdown
    const listSig = await fetch(
      `/workspaces/${organizationId}/customers/${cust.id}/signals`,
      {},
      token
    );
    expect(listSig.status).toBe(200);
    const listBody = (await listSig.json()) as {
      signals: Array<{ type: string }>;
      breakdown: { priorityScore: number };
    };
    expect(listBody.signals).toHaveLength(1);
    expect(listBody.breakdown.priorityScore).toBe(
      sigBody.breakdown.priorityScore
    );

    // 3. POST /customers/:id/send-gate blocks invalid email and passes valid email
    const gateBlock = await fetch(
      `/workspaces/${organizationId}/customers/${cust.id}/send-gate`,
      {
        method: "POST",
        body: JSON.stringify({
          channel: "email",
          contactEmail: "bad@example.com",
          emailStatus: "invalid",
        }),
      },
      token
    );
    expect(gateBlock.status).toBe(200);
    const gateBlockBody = (await gateBlock.json()) as {
      result: string;
      reasons: string[];
    };
    expect(gateBlockBody.result).toBe("block");
    expect(gateBlockBody.reasons).toContain("EMAIL_INVALID");

    // 4. POST /customers/dedup-key matches the existing SMB by normalized name + address
    const dedupRes = await fetch(
      `/workspaces/${organizationId}/customers/dedup-key`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Bleecker St Bistro",
          address: "123 Bleecker St, New York, NY",
        }),
      },
      token
    );
    expect(dedupRes.status).toBe(200);
    const dedupBody = (await dedupRes.json()) as {
      matchedCustomerId: string | null;
    };
    expect(dedupBody.matchedCustomerId).toBe(cust.id);

    // 5. POST /customers/:id/reply-ingest classifies opt-out, suppresses customer, and subsequent send-gate blocks
    const replyRes = await fetch(
      `/workspaces/${organizationId}/customers/${cust.id}/reply-ingest`,
      {
        method: "POST",
        body: JSON.stringify({
          subject: "Re: Quick question",
          body: "Please unsubscribe me and remove me from your list.",
          fromEmail: "owner@bleeckerbistro.example.com",
        }),
      },
      token
    );
    expect(replyRes.status).toBe(200);
    const replyBody = (await replyRes.json()) as {
      classified: { category: string };
      suppressed: boolean;
    };
    expect(replyBody.classified.category).toBe("opt_out");
    expect(replyBody.suppressed).toBe(true);

    const gateAfterOptOut = await fetch(
      `/workspaces/${organizationId}/customers/${cust.id}/send-gate`,
      {
        method: "POST",
        body: JSON.stringify({
          channel: "email",
          contactEmail: "owner@bleeckerbistro.example.com",
          emailStatus: "valid",
        }),
      },
      token
    );
    const gateAfterBody = (await gateAfterOptOut.json()) as {
      result: string;
      reasons: string[];
    };
    expect(gateAfterBody.result).toBe("block");
    expect(gateAfterBody.reasons).toContain("MERCHANT_DO_NOT_CONTACT");
    expect(gateAfterBody.reasons).toContain("CONTACT_DO_NOT_EMAIL");

    // 6. hard_bounce suppresses only the bounced email, leaving phone/visit channels open on a fresh customer
    const bounceCustRes = await fetch(
      `/workspaces/${organizationId}/customers`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "MacDougal Espresso LLC",
          vertical: "cafe",
        }),
      },
      token
    );
    const bounceCustBody = (await bounceCustRes.json()) as {
      id?: string;
      customer?: { id?: string };
    };
    const bounceCustId = (bounceCustBody.customer?.id ?? bounceCustBody.id)!;
    const bounceReply = await fetch(
      `/workspaces/${organizationId}/customers/${bounceCustId}/reply-ingest`,
      {
        method: "POST",
        body: JSON.stringify({
          subject: "Undeliverable",
          body: "550 5.1.1 User unknown",
          fromEmail: "dead@macdougal.example.com",
        }),
      },
      token
    );
    expect(bounceReply.status).toBe(200);
    const bounceReplyJson = (await bounceReply.json()) as {
      enrollment: { status: string; endReason: string };
    };
    expect(bounceReplyJson.enrollment.status).toBe("ended");
    expect(bounceReplyJson.enrollment.endReason).toBe("bounced");

    const callGate = await fetch(
      `/workspaces/${organizationId}/customers/${bounceCustId}/send-gate`,
      {
        method: "POST",
        body: JSON.stringify({
          channel: "call",
        }),
      },
      token
    );
    expect(((await callGate.json()) as { result: string }).result).toBe("pass");
  });
});
