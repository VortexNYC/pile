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
      id: "user-external-links",
      name: "External Links User",
      email: "external-links-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-external-links");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "External links test",
    slug: `external-links-${crypto.randomUUID()}`,
    key: `X${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-external-links",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-external-links",
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

const linkSchema = z.object({
  id: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  url: z.string(),
  verificationStatus: z.enum([
    "verified",
    "failed",
    "unreachable",
    "unchecked",
  ]),
  verifiedAt: z.string().nullable(),
  resolvedUrl: z.string().nullable(),
  resolvedTitle: z.string().nullable(),
  httpStatus: z.number().nullable(),
});

/** Runs `fn` with `globalThis.fetch` replaced by `probe`. Only outbound
 *  subrequests go through it — the app under test is invoked via
 *  `app.fetch`, so stubbing the global is safe. */
async function withProbe<T>(
  probe: (url: string) => Promise<Response>,
  fn: () => Promise<T>
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (input) =>
    probe(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    );
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe("external links API (PILE-429)", () => {
  let organizationId: string;
  let token: string;
  let customerId: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;

    const res = await fetch(
      `/workspaces/${organizationId}/customers`,
      { method: "POST", body: JSON.stringify({ name: "Acme Links" }) },
      token
    );
    expect(res.status).toBe(201);
    customerId = z.object({ id: z.string() }).parse(await res.json()).id;
  });

  function postLink(body: unknown) {
    return fetch(
      `/workspaces/${organizationId}/external-links`,
      { method: "POST", body: JSON.stringify(body) },
      token
    );
  }

  it("records a verified probe with the resolved title and status", async () => {
    const link = await withProbe(
      async () =>
        new Response(
          "<html><head><title>Acme &amp; Co — Spec</title></head><body/></html>",
          { status: 200, headers: { "content-type": "text/html" } }
        ),
      async () => {
        const res = await postLink({
          entityType: "customer",
          entityId: customerId,
          url: "https://links.example.com/spec",
        });
        expect(res.status).toBe(201);
        return linkSchema.parse(await res.json());
      }
    );
    expect(link.verificationStatus).toBe("verified");
    expect(link.httpStatus).toBe(200);
    expect(link.resolvedTitle).toBe("Acme & Co — Spec");
    expect(link.resolvedUrl).toBe("https://links.example.com/spec");
    expect(link.verifiedAt).not.toBeNull();

    const listed = await fetch(
      `/workspaces/${organizationId}/external-links?entityType=customer&entityId=${customerId}`,
      {},
      token
    );
    expect(listed.status).toBe(200);
    const links = z
      .object({ links: z.array(linkSchema) })
      .parse(await listed.json());
    expect(links.links.find((l) => l.id === link.id)?.verificationStatus).toBe(
      "verified"
    );
  });

  it("still creates the link when the host is unreachable or returns an error", async () => {
    const unreachable = await withProbe(
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => {
        const res = await postLink({
          entityType: "customer",
          entityId: customerId,
          url: "https://dead.example.com/nope",
        });
        expect(res.status).toBe(201);
        return linkSchema.parse(await res.json());
      }
    );
    expect(unreachable.verificationStatus).toBe("unreachable");
    expect(unreachable.httpStatus).toBeNull();

    const failed = await withProbe(
      async () => new Response("not found", { status: 404 }),
      async () => {
        const res = await postLink({
          entityType: "customer",
          entityId: customerId,
          url: "https://links.example.com/missing",
        });
        expect(res.status).toBe(201);
        return linkSchema.parse(await res.json());
      }
    );
    expect(failed.verificationStatus).toBe("failed");
    expect(failed.httpStatus).toBe(404);
  });

  it("does not probe non-http(s) URLs", async () => {
    let probed = false;
    const link = await withProbe(
      async () => {
        probed = true;
        return new Response("ok", { status: 200 });
      },
      async () => {
        const res = await postLink({
          entityType: "customer",
          entityId: customerId,
          url: "ftp://files.example.com/readme",
        });
        expect(res.status).toBe(201);
        return linkSchema.parse(await res.json());
      }
    );
    expect(probed).toBe(false);
    expect(link.verificationStatus).toBe("unchecked");
    expect(link.verifiedAt).toBeNull();
  });

  it("re-probes when the URL changes on update", async () => {
    const created = await withProbe(
      async () => new Response("ok", { status: 200 }),
      async () => {
        const res = await postLink({
          entityType: "customer",
          entityId: customerId,
          url: "https://links.example.com/v1",
        });
        expect(res.status).toBe(201);
        return linkSchema.parse(await res.json());
      }
    );

    const updated = await withProbe(
      async () => new Response("gone", { status: 410 }),
      async () => {
        const res = await fetch(
          `/workspaces/${organizationId}/external-links/${created.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({ url: "https://links.example.com/v2" }),
          },
          token
        );
        expect(res.status).toBe(200);
        return linkSchema.parse(await res.json());
      }
    );
    expect(updated.verificationStatus).toBe("failed");
    expect(updated.httpStatus).toBe(410);

    // Label-only update keeps the prior verification.
    const relabeled = await fetch(
      `/workspaces/${organizationId}/external-links/${created.id}`,
      { method: "PATCH", body: JSON.stringify({ label: "renamed" }) },
      token
    );
    expect(relabeled.status).toBe(200);
    const kept = linkSchema.parse(await relabeled.json());
    expect(kept.verificationStatus).toBe("failed");
    expect(kept.httpStatus).toBe(410);
  });

  it("rejects bodies with unknown keys", async () => {
    const res = await postLink({
      entityType: "customer",
      entityId: customerId,
      url: "https://links.example.com/spec",
      linkType: "spec",
    });
    expect(res.status).toBe(400);
  });
});
