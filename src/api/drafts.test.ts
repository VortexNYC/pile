import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
      id: "user-drafts",
      name: "Drafts User",
      email: "drafts-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-drafts");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Drafts test",
    slug: `drafts-${crypto.randomUUID()}`,
    key: `D${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-drafts",
  });

  const auth = await createAuth(env);
  const userKey = await auth.api.createApiKey({
    body: {
      userId: "user-drafts",
      name: "test-user",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
      permissions: { workspace: ["admin"] },
    },
  });
  const agentKey = await auth.api.createApiKey({
    body: {
      userId: "user-drafts",
      name: "test-agent",
      rateLimitEnabled: false,
      metadata: {
        organizationId: workspace!.id,
        permissions: "admin",
        actorType: "agent",
      },
      permissions: { workspace: ["admin"] },
    },
  });
  return {
    organizationId: workspace!.id,
    userToken: z.object({ key: z.string() }).parse(userKey).key,
    agentToken: z.object({ key: z.string() }).parse(agentKey).key,
  };
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

const issueSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  sensitive: z.boolean(),
});

const draftSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  entityId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdById: z.string().nullable(),
  reviewedById: z.string().nullable(),
  publishedCommentId: z.string().nullable(),
});

async function createIssue(
  organizationId: string,
  token: string,
  input: Record<string, unknown> = {}
) {
  const res = await fetch(
    `/workspaces/${organizationId}/issues`,
    { method: "POST", body: JSON.stringify({ title: "t", ...input }) },
    token
  );
  expect(res.status).toBe(201);
  return issueSchema.parse(await res.json());
}

describe("draft review API (PILE-428)", () => {
  it("exposes the sensitive flag on create + patch", async () => {
    const { organizationId, userToken } = await seedWorkspace();
    const issue = await createIssue(organizationId, userToken, {
      title: "merchant-facing",
      sensitive: true,
    });
    expect(issue.sensitive).toBe(true);

    const res = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ sensitive: false }),
      },
      userToken
    );
    expect(res.status).toBe(200);
    expect(issueSchema.parse(await res.json()).sensitive).toBe(false);
  });

  it("drafts an agent's issue patch instead of applying it", async () => {
    const { organizationId, userToken, agentToken } = await seedWorkspace();
    const issue = await createIssue(organizationId, userToken, {
      sensitive: true,
    });

    const res = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title: "agent retitled" }),
      },
      agentToken
    );
    expect(res.status).toBe(202);
    const { draft } = z.object({ draft: draftSchema }).parse(await res.json());
    expect(draft.kind).toBe("field_change");
    expect(draft.status).toBe("pending");
    expect(draft.entityId).toBe(issue.id);
    expect(draft.createdById).not.toBeNull();

    // The patch did not apply.
    const after = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {},
      userToken
    );
    expect(issueSchema.parse(await after.json()).title).not.toBe(
      "agent retitled"
    );

    // It is visible on the record's draft list and the workspace queue.
    const forIssue = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}/drafts`,
      {},
      userToken
    );
    const issueDrafts = z
      .object({ drafts: z.array(draftSchema) })
      .parse(await forIssue.json());
    expect(issueDrafts.drafts.map((d) => d.id)).toContain(draft.id);

    const queue = await fetch(
      `/workspaces/${organizationId}/drafts?status=pending`,
      {},
      userToken
    );
    const pending = z
      .object({ drafts: z.array(draftSchema) })
      .parse(await queue.json());
    expect(pending.drafts.map((d) => d.id)).toContain(draft.id);
  });

  it("publishes a field_change draft and applies the patch", async () => {
    const { organizationId, userToken, agentToken } = await seedWorkspace();
    const issue = await createIssue(organizationId, userToken, {
      sensitive: true,
    });
    const res = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title: "approved title", status: "todo" }),
      },
      agentToken
    );
    const { draft } = z.object({ draft: draftSchema }).parse(await res.json());

    // Agents cannot resolve their own drafts — the gate is human-only.
    const forbidden = await fetch(
      `/workspaces/${organizationId}/drafts/${draft.id}/publish`,
      { method: "POST", body: JSON.stringify({}) },
      agentToken
    );
    expect(forbidden.status).toBe(403);

    const published = await fetch(
      `/workspaces/${organizationId}/drafts/${draft.id}/publish`,
      { method: "POST", body: JSON.stringify({ note: "looks right" }) },
      userToken
    );
    expect(published.status).toBe(200);
    const resolved = draftSchema.parse(await published.json());
    expect(resolved.status).toBe("published");
    expect(resolved.reviewedById).not.toBeNull();

    const after = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {},
      userToken
    );
    const updated = issueSchema.parse(await after.json());
    expect(updated.title).toBe("approved title");
    expect(updated.status).toBe("todo");

    // A resolved draft rejects a second transition.
    const again = await fetch(
      `/workspaces/${organizationId}/drafts/${draft.id}/discard`,
      { method: "POST", body: JSON.stringify({}) },
      userToken
    );
    expect(again.status).toBe(409);
  });

  it("lets a human edit a draft payload before publishing", async () => {
    const { organizationId, userToken, agentToken } = await seedWorkspace();
    const issue = await createIssue(organizationId, userToken, {
      sensitive: true,
    });
    const res = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title: "rough title" }),
      },
      agentToken
    );
    const { draft } = z.object({ draft: draftSchema }).parse(await res.json());

    const edited = await fetch(
      `/workspaces/${organizationId}/drafts/${draft.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ payload: { fields: { title: "edited" } } }),
      },
      userToken
    );
    expect(edited.status).toBe(200);
    const pending = draftSchema.parse(await edited.json());
    expect(pending.status).toBe("pending");

    await fetch(
      `/workspaces/${organizationId}/drafts/${draft.id}/publish`,
      { method: "POST", body: JSON.stringify({}) },
      userToken
    );
    const after = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {},
      userToken
    );
    expect(issueSchema.parse(await after.json()).title).toBe("edited");
  });

  it("retains discarded drafts for inspection", async () => {
    const { organizationId, userToken, agentToken } = await seedWorkspace();
    const issue = await createIssue(organizationId, userToken, {
      sensitive: true,
    });
    const res = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title: "discarded title" }),
      },
      agentToken
    );
    const { draft } = z.object({ draft: draftSchema }).parse(await res.json());

    const discarded = await fetch(
      `/workspaces/${organizationId}/drafts/${draft.id}/discard`,
      { method: "POST", body: JSON.stringify({ note: "off-brand" }) },
      userToken
    );
    expect(discarded.status).toBe(200);
    expect(draftSchema.parse(await discarded.json()).status).toBe("discarded");

    // Still listed — the row is review history.
    const list = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}/drafts?status=discarded`,
      {},
      userToken
    );
    const rows = z
      .object({ drafts: z.array(draftSchema) })
      .parse(await list.json());
    expect(rows.drafts.map((d) => d.id)).toContain(draft.id);

    const after = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {},
      userToken
    );
    expect(issueSchema.parse(await after.json()).title).not.toBe(
      "discarded title"
    );
  });

  it("splits batch patches: sensitive issues draft, the rest apply", async () => {
    const { organizationId, userToken, agentToken } = await seedWorkspace();
    const gated = await createIssue(organizationId, userToken, {
      title: "gated",
      sensitive: true,
    });
    const open = await createIssue(organizationId, userToken, {
      title: "open",
    });

    const res = await fetch(
      `/workspaces/${organizationId}/issues/batch`,
      {
        method: "POST",
        body: JSON.stringify({
          ids: [gated.id, open.id],
          patch: { priority: "urgent" },
        }),
      },
      agentToken
    );
    expect(res.status).toBe(200);
    const body = z
      .object({
        issues: z.array(issueSchema),
        drafts: z.array(draftSchema),
      })
      .parse(await res.json());
    expect(body.issues.map((i) => i.id)).toEqual([open.id]);
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0]?.entityId).toBe(gated.id);
    expect(body.drafts[0]?.kind).toBe("field_change");
  });

  it("leaves human writes on sensitive records live", async () => {
    const { organizationId, userToken } = await seedWorkspace();
    const issue = await createIssue(organizationId, userToken, {
      sensitive: true,
    });
    const res = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title: "human edit" }),
      },
      userToken
    );
    expect(res.status).toBe(200);
    const drafts = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}/drafts`,
      {},
      userToken
    );
    expect(
      z.object({ drafts: z.array(draftSchema) }).parse(await drafts.json())
        .drafts
    ).toHaveLength(0);
  });

  it("artifact drafts on records gate send behind human approve/edit (PILE-404)", async () => {
    const { organizationId, userToken, agentToken } = await seedWorkspace();
    const cust = await fetch(
      `/workspaces/${organizationId}/customers`,
      { method: "POST", body: JSON.stringify({ name: "Draft Co" }) },
      userToken
    );
    const customer = z.object({ id: z.string() }).parse(await cust.json());

    // Agent (token) drafts an artifact on the customer record — provenance
    // travels with it.
    const create = await fetch(
      `/workspaces/${organizationId}/drafts`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "customer",
          entityId: customer.id,
          kind: "artifact",
          agentSlug: "merchant-courier",
          promptVersion: "v3",
          payload: { markdown: "# Proposal\n\nWe noticed you pay 2.9%." },
        }),
      },
      agentToken
    );
    expect(create.status).toBe(201);
    const draft = z
      .object({
        id: z.string(),
        status: z.string(),
        agentSlug: z.string().nullable(),
        promptVersion: z.string().nullable(),
        originalPayload: z.unknown().nullable(),
        slaBreached: z.boolean(),
      })
      .parse(await create.json());
    expect(draft.status).toBe("pending");
    expect(draft.agentSlug).toBe("merchant-courier");
    expect(draft.promptVersion).toBe("v3");
    expect(draft.originalPayload).toBeNull();
    expect(draft.slaBreached).toBe(false);

    // Human edits the draft — the agent's original is snapshotted.
    const edit = await fetch(
      `/workspaces/${organizationId}/drafts/${draft.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          payload: { markdown: "# Proposal (edited)" },
        }),
      },
      userToken
    );
    expect(edit.status).toBe(200);
    const edited = z
      .object({
        payload: z.object({ markdown: z.string() }),
        originalPayload: z.object({ markdown: z.string() }).nullable(),
      })
      .parse(await edit.json());
    expect(edited.payload.markdown).toBe("# Proposal (edited)");
    expect(edited.originalPayload?.markdown).toContain("2.9%");

    // Approve → publish: reviewedById records who decided.
    const approve = await fetch(
      `/workspaces/${organizationId}/drafts/${draft.id}/publish`,
      { method: "POST", body: JSON.stringify({ note: "looks good" }) },
      userToken
    );
    expect(approve.status).toBe(200);
    const published = z
      .object({ status: z.string(), reviewedById: z.string().nullable() })
      .parse(await approve.json());
    expect(published.status).toBe("published");
    expect(published.reviewedById).toBe("user-drafts");
  });
});
