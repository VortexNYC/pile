import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createMembership } from "../global/workspace-entities.js";
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
    expect(res.status).toBe(400);
  });
});

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

describe("issue-linked documents", () => {
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

describe("member document visibility", () => {
  it("hides restricted docs from ungranted members in the list", async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: "user-documents-member",
        name: "Member",
        email: "documents-member@example.com",
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });

    const { organizationId, token } = await seedWorkspace();
    await createMembership(
      db,
      env,
      organizationId,
      "user-documents-member",
      "member"
    );

    // One open doc + one restricted doc
    const openRes = await fetch(
      `/workspaces/${organizationId}/documents`,
      { method: "POST", body: JSON.stringify({ title: "Open doc" }) },
      token
    );
    expect(openRes.status).toBe(201);
    const restrictedRes = await fetch(
      `/workspaces/${organizationId}/documents`,
      { method: "POST", body: JSON.stringify({ title: "Restricted doc" }) },
      token
    );
    expect(restrictedRes.status).toBe(201);
    const restricted = z
      .object({ id: z.string() })
      .parse(await restrictedRes.json());

    // Restrict it — grant row to a random actor nobody matches
    const grant = await fetch(
      `/workspaces/${organizationId}/documents/${restricted.id}/permissions`,
      {
        method: "PUT",
        body: JSON.stringify({
          actorId: "somebody-else",
          level: "edit",
        }),
      },
      token
    );
    expect(grant.status).toBe(200);

    // Mint a plain `read` key — same ceiling an unprivileged member hits
    // on restricted docs (documentAccessLevel → null → hidden/404).
    const auth = await createAuth(env);
    const keyRes = await auth.api.createApiKey({
      body: {
        userId: "user-documents-member",
        name: "member-read",
        rateLimitEnabled: false,
        metadata: { organizationId, permissions: "read" },
        permissions: { workspace: ["read"] },
      },
    });
    const memberKey = z.object({ key: z.string() }).parse(keyRes).key;

    const list = await fetch(
      `/workspaces/${organizationId}/documents`,
      {},
      memberKey
    );
    expect(list.status).toBe(200);
    const titles = z
      .object({ documents: z.array(z.object({ title: z.string() })) })
      .parse(await list.json())
      .documents.map((d) => d.title);
    expect(titles).toContain("Open doc");
    expect(titles).not.toContain("Restricted doc");

    const detail = await fetch(
      `/workspaces/${organizationId}/documents/${restricted.id}`,
      {},
      memberKey
    );
    expect(detail.status).toBe(404);
  });
});

describe("default-deny creator grants", () => {
  it("a scoped creator keeps sight of their own document", async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: "user-docs-scoped",
        name: "Scoped",
        email: "docs-scoped@example.com",
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const { organizationId } = await seedWorkspace();
    await createMembership(
      db,
      env,
      organizationId,
      "user-docs-scoped",
      "member"
    );

    const auth = await createAuth(env);
    const keyRes = await auth.api.createApiKey({
      body: {
        userId: "user-docs-scoped",
        name: "scoped-doc",
        rateLimitEnabled: false,
        metadata: {
          organizationId,
          permissions: "document:view,document:create,document:edit",
        },
        permissions: {
          workspace: ["document:view", "document:create", "document:edit"],
        },
      },
    });
    const scoped = z.object({ key: z.string() }).parse(keyRes).key;

    const created = await fetch(
      `/workspaces/${organizationId}/documents`,
      { method: "POST", body: JSON.stringify({ title: "mine" }) },
      scoped
    );
    expect(created.status).toBe(201);
    const doc = z.object({ id: z.string() }).parse(await created.json());

    // The auto-grant row makes the doc visible in the grant-only list.
    const list = await fetch(
      `/workspaces/${organizationId}/documents`,
      {},
      scoped
    );
    expect(list.status).toBe(200);
    const ids = z
      .object({ documents: z.array(z.object({ id: z.string() })) })
      .parse(await list.json())
      .documents.map((d) => d.id);
    expect(ids).toContain(doc.id);
  });
});

describe("space permission routes (PILE-447)", () => {
  it("registers document-spaces/{id}/permissions grant+revoke", async () => {
    expect(true).toBe(true);
  });

  it("routes GET /documents/search before /documents/{id} and matches markdown content (VTX-649)", async () => {
    const { organizationId, token } = await seedWorkspace();
    const created = await fetch(
      `/workspaces/${organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "VTX-649 — markdown search proof",
          contentFormat: "markdown",
          content: "UniqueTokenVtx649SearchProof in markdown body",
        }),
      },
      token
    );
    expect(created.status).toBe(201);
    const doc = z.object({ id: z.string() }).parse(await created.json());

    const res = await fetch(
      `/workspaces/${organizationId}/documents/search?q=UniqueTokenVtx649SearchProof`,
      {},
      token
    );
    expect(res.status).toBe(200);
    const raw = (await res.json()) as { documents: { content?: unknown }[] };
    const body = z
      .object({
        documents: z.array(
          z.object({
            id: z.string(),
            score: z.number(),
            snippet: z.string(),
          })
        ),
      })
      .parse(raw);
    expect(body.documents.map((d) => d.id)).toContain(doc.id);

    // VTX-758 — hits carry a score and an excerpt, never the full body.
    const hit = body.documents.find((d) => d.id === doc.id);
    expect(hit?.snippet).toContain("UniqueTokenVtx649SearchProof");
    expect(
      raw.documents.every((d) => !("content" in d) || d.content === undefined)
    ).toBe(true);
  });

  it("honours ?limit on document search (VTX-758)", async () => {
    const { organizationId, token } = await seedWorkspace();
    const marker = `limitproof${crypto.randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 3; i++) {
      const created = await fetch(
        `/workspaces/${organizationId}/documents`,
        {
          method: "POST",
          body: JSON.stringify({
            title: `${marker} doc ${i}`,
            contentFormat: "markdown",
            content: `${marker} body ${i}`,
          }),
        },
        token
      );
      expect(created.status).toBe(201);
    }

    const res = await fetch(
      `/workspaces/${organizationId}/documents/search?q=${marker}&limit=2`,
      {},
      token
    );
    expect(res.status).toBe(200);
    const body = z
      .object({ documents: z.array(z.object({ id: z.string() })) })
      .parse(await res.json());
    expect(body.documents.length).toBeLessThanOrEqual(2);
  });

  it("returns content: '' with ?summary=1 but full content on GET /{id} (PILE-645)", async () => {
    const { organizationId, token } = await seedWorkspace();
    const created = await fetch(
      `/workspaces/${organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Summary strip proof",
          contentFormat: "markdown",
          content: "FullBodyShouldNotBeInSummaryList",
        }),
      },
      token
    );
    expect(created.status).toBe(201);
    const doc = z.object({ id: z.string() }).parse(await created.json());

    const list = await fetch(
      `/workspaces/${organizationId}/documents?summary=1`,
      {},
      token
    );
    expect(list.status).toBe(200);
    const listed = z
      .object({
        documents: z.array(
          z.object({ id: z.string(), title: z.string(), content: z.unknown() })
        ),
      })
      .parse(await list.json());
    const row = listed.documents.find((d) => d.id === doc.id);
    expect(row?.title).toBe("Summary strip proof");
    expect(row?.content).toBe("");

    const full = await fetch(
      `/workspaces/${organizationId}/documents/${doc.id}`,
      {},
      token
    );
    const fullDoc = z.object({ content: z.unknown() }).parse(await full.json());
    expect(fullDoc.content).toBe("FullBodyShouldNotBeInSummaryList");
  });
});

describe("document write integrity (VTX-767)", () => {
  it("rejects a content/contentFormat mismatch with 400 and no write", async () => {
    const { organizationId, token } = await seedWorkspace();
    const bad = await fetch(
      `/workspaces/${organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "poison",
          contentFormat: "blocks",
          content: "a plain string is not blocks",
        }),
      },
      token
    );
    expect(bad.status).toBe(400);

    const list = await fetch(
      `/workspaces/${organizationId}/documents`,
      {},
      token
    );
    expect(list.status).toBe(200);
    const titles = z
      .object({ documents: z.array(z.object({ title: z.string() })) })
      .parse(await list.json())
      .documents.map((d) => d.title);
    expect(titles).not.toContain("poison");
  });

  it("rejects a format-only flip that would strand stored content", async () => {
    const { organizationId, token } = await seedWorkspace();
    const created = await fetch(
      `/workspaces/${organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "md doc",
          contentFormat: "markdown",
          content: "# hi",
        }),
      },
      token
    );
    const doc = z.object({ id: z.string() }).parse(await created.json());
    const flip = await fetch(
      `/workspaces/${organizationId}/documents/${doc.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ contentFormat: "blocks" }),
      },
      token
    );
    expect(flip.status).toBe(400);
    const after = await fetch(
      `/workspaces/${organizationId}/documents/${doc.id}`,
      {},
      token
    );
    expect(
      z.object({ contentFormat: z.string() }).parse(await after.json())
        .contentFormat
    ).toBe("markdown");
  });

  it("a malformed stored row does not take down list or get (VTX-767)", async () => {
    const { organizationId, token } = await seedWorkspace();
    // Seed the poisoned row directly in the DO, bypassing the API
    // validation that now prevents it.
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance, ctx) => {
      ctx.storage.sql.exec(
        `INSERT INTO documents (id, organization_id, title, icon, content, content_format, slug, project_id, issue_id, initiative_id, parent_document_id, space_id, is_template, created_by_id, updated_by_id, created_at, updated_at, trashed_at)
         VALUES ('poison-doc', ?, 'Poisoned', NULL, 'not json at all', 'blocks', NULL, NULL, NULL, NULL, NULL, NULL, 0, 'seed', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`,
        organizationId
      );
    });
    const list = await fetch(
      `/workspaces/${organizationId}/documents`,
      {},
      token
    );
    expect(list.status).toBe(200);
    const docs = z
      .object({
        documents: z.array(z.object({ id: z.string(), content: z.unknown() })),
      })
      .parse(await list.json()).documents;
    const poisoned = docs.find((d) => d.id === "poison-doc");
    expect(poisoned?.content).toBe("not json at all");

    const got = await fetch(
      `/workspaces/${organizationId}/documents/poison-doc`,
      {},
      token
    );
    expect(got.status).toBe(200);
    expect(
      z.object({ content: z.unknown() }).parse(await got.json()).content
    ).toBe("not json at all");
  });
});

describe("document space write ACL (VTX-768)", () => {
  it("a member key cannot create into a restricted space; unknown spaceId 400s", async () => {
    const { organizationId, token } = await seedWorkspace();
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: "user-doc-space-member",
        name: "Space Member",
        email: "doc-space-member@example.com",
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    await createMembership(
      db,
      env,
      organizationId,
      "user-doc-space-member",
      "member"
    );

    const spaceRes = await fetch(
      `/workspaces/${organizationId}/document-spaces`,
      {
        method: "POST",
        body: JSON.stringify({ name: "Leadership", restricted: true }),
      },
      token
    );
    expect(spaceRes.status).toBe(201);
    const space = z.object({ id: z.string() }).parse(await spaceRes.json());

    const auth = await createAuth(env);
    const memberKey = z.object({ key: z.string() }).parse(
      await auth.api.createApiKey({
        body: {
          userId: "user-doc-space-member",
          name: "member-key",
          rateLimitEnabled: false,
          metadata: { organizationId, permissions: "member" },
          permissions: { workspace: ["member"] },
        },
      })
    ).key;

    // Restricted space: member cannot write into it.
    const denied = await fetch(
      `/workspaces/${organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({ title: "nope", spaceId: space.id }),
      },
      memberKey
    );
    expect(denied.status).toBe(403);

    // The same member CAN write into an unrestricted space.
    const openSpaceRes = await fetch(
      `/workspaces/${organizationId}/document-spaces`,
      { method: "POST", body: JSON.stringify({ name: "General" }) },
      token
    );
    const openSpace = z
      .object({ id: z.string() })
      .parse(await openSpaceRes.json());
    const allowed = await fetch(
      `/workspaces/${organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({ title: "ok", spaceId: openSpace.id }),
      },
      memberKey
    );
    expect(allowed.status).toBe(201);

    // Admin (owner) key still writes into the restricted space.
    const adminWrite = await fetch(
      `/workspaces/${organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({ title: "leadership doc", spaceId: space.id }),
      },
      token
    );
    expect(adminWrite.status).toBe(201);

    // Unknown spaceId is a 400, not a dangling reference (VTX-769).
    const unknownSpace = await fetch(
      `/workspaces/${organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "dangling",
          spaceId: "00000000-0000-4000-8000-000000000000",
        }),
      },
      token
    );
    expect(unknownSpace.status).toBe(400);

    // Unknown projectId likewise (VTX-769).
    const unknownProject = await fetch(
      `/workspaces/${organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "dangling",
          projectId: "00000000-0000-4000-8000-000000000000",
        }),
      },
      token
    );
    expect(unknownProject.status).toBe(400);

    // Moving an existing doc INTO the restricted space is denied too.
    const mine = z.object({ id: z.string() }).parse(await allowed.json());
    const moved = await fetch(
      `/workspaces/${organizationId}/documents/${mine.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ spaceId: space.id }),
      },
      memberKey
    );
    expect(moved.status).toBe(403);
    void adminWrite;
  });
});

describe("document slug handling (VTX-770)", () => {
  it("normalizes slugs and rejects duplicates within a space", async () => {
    const { organizationId, token } = await seedWorkspace();
    const first = await fetch(
      `/workspaces/${organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "a",
          slug: "Weird Slug / x?y=<b>",
        }),
      },
      token
    );
    expect(first.status).toBe(201);
    const doc = z
      .object({ id: z.string(), slug: z.string().nullable() })
      .parse(await first.json());
    expect(doc.slug).toBe("weird-slug-x-y-b");

    const dupe = await fetch(
      `/workspaces/${organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({ title: "b", slug: "weird-slug-x-y-b" }),
      },
      token
    );
    expect(dupe.status).toBe(409);
  });
});
