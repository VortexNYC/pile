import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { MockAgentProvider } from "../agents/harness.js";
import { registerAgentProvider } from "../agents/index.js";
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
      id: "user-comments",
      name: "Comments User",
      email: "comments-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-comments");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Comments test",
    slug: `comments-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-comments",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-comments",
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

describe("comments API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects listing comments without auth", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments`
    );
    expect(res.status).toBe(401);
  });

  it("rejects listing comments for an unknown issue", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects creating a comment with no JSON body", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments`,
      { method: "POST" },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating a comment with no content-type or body", async () => {
    const request = new Request(
      `https://example.com/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } }
    );
    const res = await app.fetch(request, env);
    console.log("status", res.status, await res.text());
    expect(res.status).toBe(400);
  });

  it("rejects creating a comment with an empty body", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "" }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating a comment on an unknown issue", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "Hello" }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects creating a comment without auth", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "Hello" }),
      }
    );
    expect(res.status).toBe(403);
  });

  it("rejects getting an unknown comment", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments/00000000-0000-0000-0000-000000000000`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects updating an unknown comment", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments/00000000-0000-0000-0000-000000000000`,
      {
        method: "PATCH",
        body: JSON.stringify({ body: "Updated" }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects deleting an unknown comment", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments/00000000-0000-0000-0000-000000000000`,
      {
        method: "DELETE",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects resolving an unknown comment", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments/00000000-0000-0000-0000-000000000000/resolve`,
      {
        method: "POST",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects unresolving an unknown comment", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments/00000000-0000-0000-0000-000000000000/unresolve`,
      {
        method: "POST",
      },
      token
    );
    expect(res.status).toBe(404);
  });
});

describe("comment creation", () => {
  it("creates a comment on an issue", async () => {
    const seeded = await seedWorkspace();
    const issueRes = await fetch(
      `/workspaces/${seeded.organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ title: "Comment target" }),
      },
      seeded.token
    );
    expect(issueRes.status).toBe(201);
    const issue = z.object({ id: z.string() }).parse(await issueRes.json());

    const res = await fetch(
      `/workspaces/${seeded.organizationId}/issues/${issue.id}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "Hello world" }),
      },
      seeded.token
    );
    expect(res.status).toBe(201);
    const comment = z
      .object({ id: z.string(), body: z.string() })
      .parse(await res.json());
    expect(comment.body).toBe("Hello world");
  });
});

async function createAgentToken(organizationId: string) {
  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-comments",
      name: "test-agent",
      rateLimitEnabled: false,
      metadata: {
        organizationId,
        permissions: "admin",
        actorType: "agent",
      },
      permissions: { workspace: ["admin"] },
    },
  });
  return z.object({ key: z.string() }).parse(result).key;
}

describe("sensitive records (PILE-428)", () => {
  it("holds agent comments on a sensitive issue as drafts", async () => {
    const seeded = await seedWorkspace();
    const agent = await createAgentToken(seeded.organizationId);
    const issueRes = await fetch(
      `/workspaces/${seeded.organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ title: "sensitive", sensitive: true }),
      },
      seeded.token
    );
    expect(issueRes.status).toBe(201);
    const issue = z.object({ id: z.string() }).parse(await issueRes.json());

    const res = await fetch(
      `/workspaces/${seeded.organizationId}/issues/${issue.id}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "agent draft copy" }),
      },
      agent
    );
    expect(res.status).toBe(202);
    const { draft } = z
      .object({
        draft: z.object({
          id: z.string(),
          kind: z.string(),
          status: z.string(),
        }),
      })
      .parse(await res.json());
    expect(draft.kind).toBe("comment");
    expect(draft.status).toBe("pending");

    // Nothing posted to the thread; publishing replays the comment.
    const list = await fetch(
      `/workspaces/${seeded.organizationId}/issues/${issue.id}/comments`,
      {},
      seeded.token
    );
    const { comments } = z
      .object({ comments: z.array(z.object({ body: z.string() })) })
      .parse(await list.json());
    expect(comments.some((c) => c.body === "agent draft copy")).toBe(false);

    const published = await fetch(
      `/workspaces/${seeded.organizationId}/drafts/${draft.id}/publish`,
      { method: "POST", body: JSON.stringify({}) },
      seeded.token
    );
    expect(published.status).toBe(200);
    const after = await fetch(
      `/workspaces/${seeded.organizationId}/issues/${issue.id}/comments`,
      {},
      seeded.token
    );
    const { comments: live } = z
      .object({ comments: z.array(z.object({ body: z.string() })) })
      .parse(await after.json());
    expect(live.some((c) => c.body === "agent draft copy")).toBe(true);
  });

  it("posts agent comments normally on ordinary issues", async () => {
    const seeded = await seedWorkspace();
    const agent = await createAgentToken(seeded.organizationId);
    const issueRes = await fetch(
      `/workspaces/${seeded.organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ title: "ordinary" }),
      },
      seeded.token
    );
    const issue = z.object({ id: z.string() }).parse(await issueRes.json());
    const res = await fetch(
      `/workspaces/${seeded.organizationId}/issues/${issue.id}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "agent note" }),
      },
      agent
    );
    expect(res.status).toBe(201);
  });

  it("@agent-slug mention dispatches the registered agent (PILE-435)", async () => {
    const seeded = await seedWorkspace();
    const dispatched: string[] = [];
    const providerId = `mock-mention-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(
      providerId,
      () =>
        new MockAgentProvider(providerId, {
          dispatch: (_org, issue) => {
            dispatched.push(issue.id);
            return {
              id: `sess-${crypto.randomUUID()}`,
              agentId: providerId,
              issueId: issue.id,
              status: "created" as const,
            };
          },
        })
    );
    // Register the agent type the mention resolves through.
    const type = await fetch(
      `/workspaces/${seeded.organizationId}/agent-types`,
      {
        method: "POST",
        body: JSON.stringify({
          slug: "scout",
          name: "Scout",
          providerAgentId: providerId,
        }),
      },
      seeded.token
    );
    expect(type.status).toBe(200);
    const typesRes = await fetch(
      `/workspaces/${seeded.organizationId}/agent-types`,
      {},
      seeded.token
    );
    const listed = (await typesRes.json()) as { agentTypes: unknown[] };
    expect(listed.agentTypes.length).toBe(1);
    const listed = (await typesRes.json()) as { agentTypes: unknown[] };
    const listed = (await typesRes.json()) as {
      agentTypes: Array<{ slug: string }>;
    };
    expect(listed.agentTypes.some((t) => t.slug === "scout")).toBe(true);

    const issueRes = await fetch(
      `/workspaces/${seeded.organizationId}/issues`,
      { method: "POST", body: JSON.stringify({ title: "mention test" }) },
      seeded.token
    );
    const issue = (await issueRes.json()) as { id: string };

    const res = await fetch(
      `/workspaces/${seeded.organizationId}/issues/${issue.id}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "@scout can you look at this merchant?" }),
      },
      seeded.token
    );
    expect(res.status).toBe(201);
    // A dispatched session row is the observable result.
    const sessionsRes = await fetch(
      `/workspaces/${seeded.organizationId}/agent/sessions?issueId=${issue.id}`,
      {},
      seeded.token
    );
    const sessions = (await sessionsRes.json()) as { sessions: unknown[] };
    expect(sessions.sessions.length).toBe(1);
    expect(dispatched).toContain(issue.id);
  });
});
