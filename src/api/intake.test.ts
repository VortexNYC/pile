import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { buildIntakeMarkdown } from "./intake.js";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-intake",
      name: "Intake User",
      email: "intake-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-intake");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Intake test",
    slug: `intake-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-intake",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-intake",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

async function api(
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : undefined),
    ...(init.headers as Record<string, string> | undefined),
  };
  return app.fetch(
    new Request(`https://example.com${path}`, { ...init, headers }),
    env
  );
}

async function post(path: string, body: unknown, token?: string) {
  return api(path, { method: "POST", body: JSON.stringify(body) }, token);
}

describe("intake page", () => {
  it("serves the mobile intake shell", async () => {
    const res = await api("/intake");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Merchant intake");
    expect(body).toContain("/api/auth/sign-in/email");
    expect(body).toContain("/customer-statuses");
    expect(body).toContain('"/intake"');
    expect(body).toContain('accept="image/*"');
  });
});

describe("intake API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects intake without auth", async () => {
    const res = await post(`/workspaces/${organizationId}/intake`, {
      businessName: "Bodega",
    });
    expect([401, 403]).toContain(res.status);
  });

  it("creates customer, contact, document, status and booking link", async () => {
    const statusRes = await post(
      `/workspaces/${organizationId}/customer-statuses`,
      { name: "New", position: 0 },
      token
    );
    const status = z.object({ id: z.string() }).parse(await statusRes.json());

    const res = await post(
      `/workspaces/${organizationId}/intake`,
      {
        intakeId: "visit-001",
        businessName: "Joe's Deli",
        address: "123 Main St",
        visitedAt: "2026-10-07T14:00:00Z",
        owner: {
          name: "Joe Owner",
          email: "joe@joesdeli.example",
          phone: "+1 555 0100",
          bestTime: "mornings",
        },
        meeting: {
          booked: true,
          at: "2026-10-09T15:00:00Z",
          bookingUrl: "https://cal.com/vortex/intro",
        },
        discovery: {
          businessType: "counter service",
          billingSystems: ["point-of-sale"],
          paymentMethods: ["card-present", "keyed"],
          hardware: "Square terminal",
          hardwareOwnership: "bundled",
        },
        pricing: {
          currentProcessor: "Square",
          underContract: false,
          monthlyCardVolume: "40000",
          cardMix: "mostly debit",
        },
        pain: { biggestComplaint: "fees are too high" },
        pipelineStatusId: status.id,
        nextStep: "statement handoff",
        repNotes: "real prospect",
        statementFiles: [
          {
            key: `${organizationId}/files/abc/page1.jpg`,
            url: `/workspaces/${organizationId}/files?key=${organizationId}%2Ffiles%2Fabc%2Fpage1.jpg`,
            name: "page1.jpg",
          },
        ],
      },
      token
    );
    expect(res.status).toBe(201);
    const result = z
      .object({
        customerId: z.string(),
        contactId: z.string(),
        documentId: z.string(),
        statusId: z.string(),
        bookingLinkId: z.string(),
        deduped: z.boolean(),
      })
      .parse(await res.json());
    expect(result.deduped).toBe(false);

    const customerRes = await api(
      `/workspaces/${organizationId}/customers/${result.customerId}`,
      {},
      token
    );
    const customer = z
      .object({
        name: z.string(),
        statusId: z.string().nullable(),
        externalId: z.string().nullable(),
      })
      .parse(await customerRes.json());
    expect(customer.name).toBe("Joe's Deli");
    expect(customer.statusId).toBe(status.id);
    expect(customer.externalId).toBe("visit-001");

    const docRes = await api(
      `/workspaces/${organizationId}/documents/${result.documentId}`,
      {},
      token
    );
    const doc = z
      .object({ content: z.string(), slug: z.string().nullable() })
      .parse(await docRes.json());
    expect(doc.slug).toBe("intake-visit-001");
    expect(doc.content).toContain("Joe's Deli");
    expect(doc.content).toContain("Square");
    expect(doc.content).toContain("fees are too high");
    expect(doc.content).toContain("cal.com/vortex/intro");
    expect(doc.content).toContain("page1.jpg");

    const linksRes = await api(
      `/workspaces/${organizationId}/external-links?entityType=customer&entityId=${result.customerId}`,
      {},
      token
    );
    const { links } = z
      .object({ links: z.array(z.object({ url: z.string() })) })
      .parse(await linksRes.json());
    expect(links.map((l) => l.url)).toContain("https://cal.com/vortex/intro");
  });

  it("dedupes a retried submit on intakeId", async () => {
    const body = {
      intakeId: "visit-retry",
      businessName: "Retry Cafe",
      owner: { email: "owner@retry.example", name: "Retry Owner" },
      meeting: { booked: false, bookingUrl: "https://cal.com/vortex/retry" },
    };
    const first = await post(
      `/workspaces/${organizationId}/intake`,
      body,
      token
    );
    expect(first.status).toBe(201);
    const second = await post(
      `/workspaces/${organizationId}/intake`,
      body,
      token
    );
    expect(second.status).toBe(200);
    const result = z
      .object({ deduped: z.boolean() })
      .parse(await second.json());
    expect(result.deduped).toBe(true);

    const customersRes = await api(
      `/workspaces/${organizationId}/customers`,
      {},
      token
    );
    const { customers } = z
      .object({
        customers: z.array(z.object({ externalId: z.string().nullable() })),
      })
      .parse(await customersRes.json());
    expect(
      customers.filter((cust) => cust.externalId === "visit-retry")
    ).toHaveLength(1);
  });

  it("rejects statement files from another workspace", async () => {
    const res = await post(
      `/workspaces/${organizationId}/intake`,
      {
        businessName: "Foreign Files Co",
        statementFiles: [{ key: "other-org/files/abc/page1.jpg", url: "/x" }],
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown pipeline status", async () => {
    const res = await post(
      `/workspaces/${organizationId}/intake`,
      { businessName: "Bad Status Co", pipelineStatusId: "missing" },
      token
    );
    expect(res.status).toBe(400);
  });
});

describe("buildIntakeMarkdown", () => {
  it("renders checklist sections and omits empty fields", () => {
    const md = buildIntakeMarkdown({
      businessName: "Taco Truck",
      discovery: { businessType: "counter service" },
      pricing: { currentProcessor: "Clover", underContract: true },
    });
    expect(md).toContain("# Taco Truck — visit intake");
    expect(md).toContain("## Discovery");
    expect(md).toContain("**Business type:** counter service");
    expect(md).toContain("**Current processor:** Clover");
    expect(md).toContain("**Under contract:** yes");
    expect(md).not.toContain("**Contract end:**");
    expect(md).toContain("- none captured");
  });
});
