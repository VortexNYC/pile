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
      id: "user-documents",
      name: "Documents User",
      email: "documents-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-documents");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Documents test",
    slug: `documents-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-documents",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-documents",
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
    ...(token ? { Authorization: `Bearer ${token}` } : undefined),
    ...(init.headers as Record<string, string> | undefined),
  };
  const request = new Request(`https://example.com${path}`, {
    ...init,
    headers,
  });
  return app.fetch(request, env);
}

describe("documents API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects listing documents without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/documents`);
    expect(res.status).toBe(401);
  });

  it("rejects creating a document with an empty title", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({ title: "" }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating a document with an invalid content format", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Bad format",
          contentFormat: "html",
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating a document without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/documents`, {
      method: "POST",
      body: JSON.stringify({ title: "No auth" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects getting an unknown document", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/00000000-0000-0000-0000-000000000000`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects updating an unknown document", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/00000000-0000-0000-0000-000000000000`,
      {
        method: "PATCH",
        body: JSON.stringify({ title: "Updated" }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects deleting an unknown document", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/00000000-0000-0000-0000-000000000000`,
      {
        method: "DELETE",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects restoring an unknown document", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/00000000-0000-0000-0000-000000000000/restore`,
      {
        method: "POST",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects fetching history for an unknown document", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/00000000-0000-0000-0000-000000000000/history`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects creating a space with an empty name", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/document-spaces`,
      {
        method: "POST",
        body: JSON.stringify({ name: "" }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects updating an unknown space", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/document-spaces/00000000-0000-0000-0000-000000000000`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: "Updated" }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects deleting an unknown space", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/document-spaces/00000000-0000-0000-0000-000000000000`,
      {
        method: "DELETE",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects creating a comment on an unknown document", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/00000000-0000-0000-0000-000000000000/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "Hello" }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects creating a share for an unknown document", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/00000000-0000-0000-0000-000000000000/share`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects reading a shared document with an unknown token", async () => {
    const res = await fetch(
      `/shared-documents/${organizationId}/00000000-0000-0000-0000-000000000000`
    );
    expect(res.status).toBe(404);
  });

  it("rejects searching without a query", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/search`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });
});

describe("issue-linked documents", () => {
  async function createIssue(organizationId: string, token: string) {
    const res = await fetch(
      `/workspaces/${organizationId}/issues`,
      { method: "POST", body: JSON.stringify({ title: "Notes target" }) },
      token
    );
    expect(res.status).toBe(201);
    return z
      .object({ id: z.string(), identifier: z.string() })
      .parse(await res.json());
  }

  it("creates and retrieves a markdown note by issue id or identifier", async () => {
    const seeded = await seedWorkspace();
    const issue = await createIssue(seeded.organizationId, seeded.token);

    const createRes = await fetch(
      `/workspaces/${seeded.organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          title: `${issue.identifier} — session findings`,
          content: "## Findings\n\nNotes live here.",
          contentFormat: "markdown",
          issueId: issue.identifier,
        }),
      },
      seeded.token
    );
    expect(createRes.status).toBe(201);
    const doc = z
      .object({
        id: z.string(),
        issueId: z.string(),
        contentFormat: z.string(),
      })
      .parse(await createRes.json());
    expect(doc.issueId).toBe(issue.id);
    expect(doc.contentFormat).toBe("markdown");

    const listSchema = z.object({
      documents: z.array(z.object({ id: z.string() })),
    });

    for (const ref of [issue.id, issue.identifier]) {
      const res = await fetch(
        `/workspaces/${seeded.organizationId}/documents?issueId=${ref}`,
        {},
        seeded.token
      );
      expect(res.status).toBe(200);
      const listed = listSchema.parse(await res.json());
      expect(listed.documents.map((d) => d.id)).toContain(doc.id);

      const scoped = await fetch(
        `/workspaces/${seeded.organizationId}/issues/${ref}/documents`,
        {},
        seeded.token
      );
      expect(scoped.status).toBe(200);
      const scopedDocs = listSchema.parse(await scoped.json());
      expect(scopedDocs.documents.map((d) => d.id)).toContain(doc.id);
    }
  });

  it("rejects an unresolvable issueId on create", async () => {
    const seeded = await seedWorkspace();
    const res = await fetch(
      `/workspaces/${seeded.organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({ title: "Orphan note", issueId: "ZZZ-99999" }),
      },
      seeded.token
    );
    expect(res.status).toBe(400);
  });

  it("resolves identifiers when updating issueId", async () => {
    const seeded = await seedWorkspace();
    const issue = await createIssue(seeded.organizationId, seeded.token);

    const createRes = await fetch(
      `/workspaces/${seeded.organizationId}/documents`,
      { method: "POST", body: JSON.stringify({ title: "Floating note" }) },
      seeded.token
    );
    expect(createRes.status).toBe(201);
    const doc = z.object({ id: z.string() }).parse(await createRes.json());

    const badRes = await fetch(
      `/workspaces/${seeded.organizationId}/documents/${doc.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ issueId: "ZZZ-99999" }),
      },
      seeded.token
    );
    expect(badRes.status).toBe(400);

    const res = await fetch(
      `/workspaces/${seeded.organizationId}/documents/${doc.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ issueId: issue.identifier }),
      },
      seeded.token
    );
    expect(res.status).toBe(200);
    const updated = z.object({ issueId: z.string() }).parse(await res.json());
    expect(updated.issueId).toBe(issue.id);
  });
});
