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
});
