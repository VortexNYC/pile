import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

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
  const auth = createAuth(env);
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

describe("support-contacts API", () => {
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

  it("creates a company and customer and auto-resolves company by email domain", async () => {
    const companyRes = await fetch(
      `/workspaces/${organizationId}/support/companies`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Acme",
          domain: "acme.com",
        }),
      }
    );
    expect(companyRes.status).toBe(201);
    const company = (await companyRes.json()) as { company: { id: string } };

    const customerRes = await fetch(
      `/workspaces/${organizationId}/support/customers`,
      {
        method: "POST",
        body: JSON.stringify({
          email: "jane@acme.com",
          fullName: "Jane Doe",
        }),
      }
    );
    expect(customerRes.status).toBe(201);
    const customer = (await customerRes.json()) as {
      customer: {
        id: string;
        companies: { companyId: string; isPrimary: boolean }[];
      };
    };

    expect(customer.customer.companies.length).toBe(1);
    expect(customer.customer.companies[0].companyId).toBe(company.company.id);
    expect(customer.customer.companies[0].isPrimary).toBe(true);
  });

  it("creates a customer with explicit companies and identities", async () => {
    const companyRes = await fetch(
      `/workspaces/${organizationId}/support/companies`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Globex",
        }),
      }
    );
    const company = (await companyRes.json()) as { company: { id: string } };

    const customerRes = await fetch(
      `/workspaces/${organizationId}/support/customers`,
      {
        method: "POST",
        body: JSON.stringify({
          email: "alice@globex.example",
          fullName: "Alice Smith",
          companies: [{ companyId: company.company.id, isPrimary: true }],
          identities: [
            { type: "email", value: "alice@globex.example", isPrimary: true },
            { type: "slack", value: "alice", isPrimary: false },
          ],
        }),
      }
    );
    expect(customerRes.status).toBe(201);
    const customer = (await customerRes.json()) as {
      customer: { id: string; companies: unknown[]; identities: unknown[] };
    };

    expect(customer.customer.companies.length).toBe(1);
    expect(customer.customer.identities.length).toBe(2);
  });

  it("gets, updates, and sets identities for a customer", async () => {
    const createRes = await fetch(
      `/workspaces/${organizationId}/support/customers`,
      {
        method: "POST",
        body: JSON.stringify({
          email: "bob@example.com",
          fullName: "Bob",
        }),
      }
    );
    const { customer } = (await createRes.json()) as {
      customer: { id: string };
    };

    const getRes = await fetch(
      `/workspaces/${organizationId}/support/customers/${customer.id}`
    );
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as {
      customer: { fullName: string | null };
    };
    expect(got.customer.fullName).toBe("Bob");

    const patchRes = await fetch(
      `/workspaces/${organizationId}/support/customers/${customer.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ fullName: "Bob Updated" }),
      }
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      customer: { fullName: string };
    };
    expect(patched.customer.fullName).toBe("Bob Updated");

    const putRes = await fetch(
      `/workspaces/${organizationId}/support/customers/${customer.id}/identities`,
      {
        method: "PUT",
        body: JSON.stringify({
          identities: [
            { type: "email", value: "bob@example.com", isPrimary: true },
            { type: "chat", value: "bob-chat", isPrimary: false },
          ],
        }),
      }
    );
    expect(putRes.status).toBe(200);
    const updated = (await putRes.json()) as {
      customer: { identities: { type: string; value: string }[] };
    };
    expect(
      updated.customer.identities.some((i) => i.value === "bob-chat")
    ).toBe(true);
  });

  it("lists and searches customers and companies", async () => {
    await fetch(`/workspaces/${organizationId}/support/companies`, {
      method: "POST",
      body: JSON.stringify({
        name: "SearchCo",
        domain: "searchco.test",
      }),
    });

    const customerRes = await fetch(
      `/workspaces/${organizationId}/support/customers`,
      {
        method: "POST",
        body: JSON.stringify({
          email: "searchable@searchco.test",
          fullName: "Searchable User",
        }),
      }
    );
    const { customer } = (await customerRes.json()) as {
      customer: { id: string };
    };

    const listRes = await fetch(
      `/workspaces/${organizationId}/support/customers?q=searchable`
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { customers: unknown[] };
    expect(list.customers.length).toBeGreaterThanOrEqual(1);

    const companyListRes = await fetch(
      `/workspaces/${organizationId}/support/companies?q=SearchCo`
    );
    expect(companyListRes.status).toBe(200);
    const companyList = (await companyListRes.json()) as {
      companies: unknown[];
    };
    expect(companyList.companies.length).toBeGreaterThanOrEqual(1);

    const getRes = await fetch(
      `/workspaces/${organizationId}/support/customers/${customer.id}`
    );
    expect(getRes.status).toBe(200);
  });

  it("tracks email opt-out via PATCH and the public unsubscribe route", async () => {
    const createRes = await fetch(
      `/workspaces/${organizationId}/support/customers`,
      {
        method: "POST",
        body: JSON.stringify({ email: "optout@example.com" }),
      }
    );
    expect(createRes.status).toBe(201);
    const { customer } = (await createRes.json()) as {
      customer: {
        id: string;
        emailOptOut: boolean;
        emailOptOutAt: string | null;
      };
    };
    expect(customer.emailOptOut).toBe(false);
    expect(customer.emailOptOutAt).toBeNull();

    // Staff-side PATCH sets the flag + timestamp.
    const patchRes = await fetch(
      `/workspaces/${organizationId}/support/customers/${customer.id}`,
      { method: "PATCH", body: JSON.stringify({ emailOptOut: true }) }
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      customer: { emailOptOut: boolean; emailOptOutAt: string | null };
    };
    expect(patched.customer.emailOptOut).toBe(true);
    expect(patched.customer.emailOptOutAt).toBeTruthy();

    // Clearing resets the timestamp.
    const clearRes = await fetch(
      `/workspaces/${organizationId}/support/customers/${customer.id}`,
      { method: "PATCH", body: JSON.stringify({ emailOptOut: false }) }
    );
    const cleared = (await clearRes.json()) as {
      customer: { emailOptOut: boolean; emailOptOutAt: string | null };
    };
    expect(cleared.customer.emailOptOut).toBe(false);
    expect(cleared.customer.emailOptOutAt).toBeNull();

    // Public unsubscribe — no auth, always ok.
    const unsubRes = await app.fetch(
      new Request(`${ORIGIN}/support/unsubscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          email: "optout@example.com",
        }),
      }),
      env
    );
    expect(unsubRes.status).toBe(200);

    const checkRes = await fetch(
      `/workspaces/${organizationId}/support/customers/${customer.id}`
    );
    const checked = (await checkRes.json()) as {
      customer: { emailOptOut: boolean };
    };
    expect(checked.customer.emailOptOut).toBe(true);

    // Unknown email — still ok, no existence oracle.
    const unknownRes = await app.fetch(
      new Request(`${ORIGIN}/support/unsubscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          email: "ghost@example.com",
        }),
      }),
      env
    );
    expect(unknownRes.status).toBe(200);
  });
});
