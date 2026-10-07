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
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
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
