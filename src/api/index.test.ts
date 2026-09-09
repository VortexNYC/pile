import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { hmacSha256Hex } from "../global/crypto.js";
import { createD1 } from "../global/db.js";
import { createGitlabInstallation } from "../global/gitlab-installations.js";
import {
  apikey as apikeyTable,
  githubInstallations as githubInstallationsTable,
  member as memberTable,
  user as userTable,
} from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import type { WorkerEnv } from "../platform/middleware.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

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
  const workspace = await createWorkspace(db, env, {
    name: "Test workspace",
    slug: `test-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-1",
  });
  return workspace!.id;
}

async function adminToken(organizationId: string) {
  const token = await createAdminTokenRecord(organizationId);
  return token.token;
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
  return { id: parsed.id, token: parsed.key, referenceId: "user-1" };
}

function notionPath(input: RequestInfo | URL): string | null {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (!url.startsWith("https://api.notion.com/v1")) return null;
  return url.replace("https://api.notion.com/v1", "");
}

function request(
  path: string,
  init: RequestInit & { token?: string } = {}
): Request {
  const headers = new Headers(init.headers);
  if (init.token) {
    headers.set("Authorization", `Bearer ${init.token}`);
  }
  if (["POST", "PATCH", "PUT", "DELETE"].includes(init.method ?? "GET")) {
    headers.set("Origin", ORIGIN);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }
  return new Request(`http://localhost${path}`, {
    ...init,
    headers,
  });
}

describe("API integration", () => {
  it("lists workspaces", async () => {
    const res = await app.fetch(request("/workspaces"), env);
    expect(res.status).toBe(200);
    const body = await res.json<{ workspaces: unknown[] }>();
    expect(Array.isArray(body.workspaces)).toBe(true);
  });

  it("manages workspace states", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const create = await app.fetch(
      request("/workspaces/" + organizationId + "/states", {
        method: "POST",
        token,
        body: JSON.stringify({
          linearId: "linear-state-1",
          name: "Todo",
          type: "backlog",
        }),
      }),
      env
    );
    expect(create.status).toBe(201);
    const state = await create.json<{ id: string; name: string }>();
    expect(state.name).toBe("Todo");

    const list = await app.fetch(
      request("/workspaces/" + organizationId + "/states", { token }),
      env
    );
    expect(list.status).toBe(200);
    const listBody = await list.json<{
      states: Array<{ id: string; name: string }>;
    }>();
    expect(listBody.states.some((s) => s.id === state.id)).toBe(true);

    const get = await app.fetch(
      request("/workspaces/" + organizationId + "/states/" + state.id, {
        token,
      }),
      env
    );
    expect(get.status).toBe(200);

    const patch = await app.fetch(
      request("/workspaces/" + organizationId + "/states/" + state.id, {
        method: "PATCH",
        token,
        body: JSON.stringify({ name: "In Progress", type: "started" }),
      }),
      env
    );
    expect(patch.status).toBe(200);
    const updated = await patch.json<{ name: string }>();
    expect(updated.name).toBe("In Progress");

    const del = await app.fetch(
      request("/workspaces/" + organizationId + "/states/" + state.id, {
        method: "DELETE",
        token,
      }),
      env
    );
    expect(del.status).toBe(204);
  });

  it("manages workspace tokens", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const create = await app.fetch(
      request("/workspaces/" + organizationId + "/tokens", {
        method: "POST",
        token,
        body: JSON.stringify({ name: "ci", permissions: "read" }),
      }),
      env
    );
    expect(create.status).toBe(201);
    const created = await create.json<{ id: string; name: string }>();
    expect(created.name).toBe("ci");

    const list = await app.fetch(
      request("/workspaces/" + organizationId + "/tokens", { token }),
      env
    );
    expect(list.status).toBe(200);
    const listBody = await list.json<{ tokens: unknown[] }>();
    expect(listBody.tokens.length).toBeGreaterThanOrEqual(1);

    const del = await app.fetch(
      request("/workspaces/" + organizationId + "/tokens/" + created.id, {
        method: "DELETE",
        token,
      }),
      env
    );
    expect(del.status).toBe(204);
  });

  it("manages memberships", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const create = await app.fetch(
      request("/workspaces/" + organizationId + "/memberships", {
        method: "POST",
        token,
        body: JSON.stringify({ userId: "user-1", role: "member" }),
      }),
      env
    );
    expect(create.status).toBe(201);
    const membership = await create.json<{ userId: string }>();
    expect(membership.userId).toBe("user-1");

    const list = await app.fetch(
      request("/workspaces/" + organizationId + "/memberships", { token }),
      env
    );
    expect(list.status).toBe(200);
    const listBody = await list.json<{ memberships: unknown[] }>();
    expect(listBody.memberships).toHaveLength(1);
  });

  it("manages linear users", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const create = await app.fetch(
      request("/workspaces/" + organizationId + "/linear-users", {
        method: "POST",
        token,
        body: JSON.stringify({
          linearId: "linear-user-1",
          name: "Alice",
          email: "alice@example.com",
        }),
      }),
      env
    );
    expect(create.status).toBe(201);
    const user = await create.json<{ id: string; linearId: string }>();
    expect(user.linearId).toBe("linear-user-1");

    const get = await app.fetch(
      request(
        "/workspaces/" + organizationId + "/linear-users/" + user.linearId,
        {
          token,
        }
      ),
      env
    );
    expect(get.status).toBe(200);
    const got = await get.json<{ id: string }>();
    expect(got.id).toBe(user.id);
  });

  it("manages issue subscribers", async () => {
    const organizationId = await seedWorkspace();
    const issueId = "issue-1";
    const token = await adminToken(organizationId);

    const create = await app.fetch(
      request(
        "/workspaces/" + organizationId + "/issues/" + issueId + "/subscribers",
        {
          method: "POST",
          token,
          body: JSON.stringify({ linearUserId: "linear-user-1" }),
        }
      ),
      env
    );
    expect(create.status).toBe(201);

    const list = await app.fetch(
      request(
        "/workspaces/" + organizationId + "/issues/" + issueId + "/subscribers",
        { token }
      ),
      env
    );
    expect(list.status).toBe(200);
    const body = await list.json<{ subscribers: unknown[] }>();
    expect(body.subscribers).toHaveLength(1);
  });

  it("records issue history on create and update", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const create = await app.fetch(
      request("/workspaces/" + organizationId + "/issues", {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "History test",
          status: "backlog",
          priority: "medium",
        }),
      }),
      env
    );
    expect(create.status).toBe(201);
    const issue = await create.json<{ id: string }>();

    const update = await app.fetch(
      request("/workspaces/" + organizationId + "/issues/" + issue.id, {
        method: "PATCH",
        token,
        body: JSON.stringify({
          title: "History test updated",
          status: "in_progress",
        }),
      }),
      env
    );
    expect(update.status).toBe(200);

    const historyRes = await app.fetch(
      request(
        "/workspaces/" + organizationId + "/issues/" + issue.id + "/history",
        { token }
      ),
      env
    );
    expect(historyRes.status).toBe(200);
    const historyBody = await historyRes.json<{ history: unknown[] }>();
    expect(historyBody.history.length).toBeGreaterThanOrEqual(1);
  });

  it("supports triage status and resolution on issues", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const create = await app.fetch(
      request("/workspaces/" + organizationId + "/issues", {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Triage issue",
          status: "triage",
        }),
      }),
      env
    );
    expect(create.status).toBe(201);
    const triage = await create.json<{
      id: string;
      status: string;
      resolution: string | null;
    }>();
    expect(triage.status).toBe("triage");
    expect(triage.resolution).toBeNull();

    const resolve = await app.fetch(
      request("/workspaces/" + organizationId + "/issues/" + triage.id, {
        method: "PATCH",
        token,
        body: JSON.stringify({
          status: "done",
          resolution: "resolved",
        }),
      }),
      env
    );
    expect(resolve.status).toBe(200);
    const resolved = await resolve.json<{
      status: string;
      resolution: string | null;
    }>();
    expect(resolved.status).toBe("done");
    expect(resolved.resolution).toBe("resolved");

    const bad = await app.fetch(
      request("/workspaces/" + organizationId + "/issues/" + triage.id, {
        method: "PATCH",
        token,
        body: JSON.stringify({
          status: "todo",
          resolution: "duplicate",
        }),
      }),
      env
    );
    expect(bad.status).toBe(400);
  });

  it("manages webhook subscriptions", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);
    const url = "http://127.0.0.1:1/webhook";

    const createRes = await app.fetch(
      request(`/workspaces/${organizationId}/webhook-subscriptions`, {
        method: "POST",
        token,
        body: JSON.stringify({ url, events: "issue.created" }),
      }),
      env
    );
    expect(createRes.status).toBe(201);
    const sub = await createRes.json<{ id: string; url: string }>();
    expect(sub.url).toBe(url);

    const listRes = await app.fetch(
      request(`/workspaces/${organizationId}/webhook-subscriptions`, { token }),
      env
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json<{ subscriptions: unknown[] }>();
    expect(list.subscriptions.length).toBe(1);

    const deliveriesRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/webhook-subscriptions/${sub.id}/deliveries`,
        { token }
      ),
      env
    );
    expect(deliveriesRes.status).toBe(200);
    const deliveries = await deliveriesRes.json<{ deliveries: unknown[] }>();
    expect(Array.isArray(deliveries.deliveries)).toBe(true);

    const deleteRes = await app.fetch(
      request(`/workspaces/${organizationId}/webhook-subscriptions/${sub.id}`, {
        method: "DELETE",
        token,
      }),
      env
    );
    expect(deleteRes.status).toBe(204);
  });

  it("searches issues by title, description, identifier and comments", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const issueA = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Unique alpha title",
          description: "beta description",
        }),
      }),
      env
    );
    expect(issueA.status).toBe(201);
    const issueAData = await issueA.json<{ id: string; identifier: string }>();

    const issueB = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Another issue",
          description: "gamma delta",
        }),
      }),
      env
    );
    expect(issueB.status).toBe(201);

    await app.fetch(
      request(
        `/workspaces/${organizationId}/issues/${issueAData.id}/comments`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ body: "epsilon comment body" }),
        }
      ),
      env
    );

    const byTitle = await app.fetch(
      request(`/workspaces/${organizationId}/issues?search=Unique+alpha`, {
        token,
      }),
      env
    );
    expect(byTitle.status).toBe(200);
    const byTitleBody = await byTitle.json<{ issues: unknown[] }>();
    expect(byTitleBody.issues.length).toBe(1);

    const byDescription = await app.fetch(
      request(`/workspaces/${organizationId}/issues?search=gamma`, { token }),
      env
    );
    expect(byDescription.status).toBe(200);
    const byDescriptionBody = await byDescription.json<{ issues: unknown[] }>();
    expect(byDescriptionBody.issues.length).toBe(1);

    const byIdentifier = await app.fetch(
      request(
        `/workspaces/${organizationId}/issues?search=${issueAData.identifier}`,
        { token }
      ),
      env
    );
    expect(byIdentifier.status).toBe(200);
    const byIdentifierBody = await byIdentifier.json<{ issues: unknown[] }>();
    expect(byIdentifierBody.issues.length).toBe(1);

    const byComment = await app.fetch(
      request(`/workspaces/${organizationId}/issues?search=epsilon`, { token }),
      env
    );
    expect(byComment.status).toBe(200);
    const byCommentBody = await byComment.json<{ issues: unknown[] }>();
    expect(byCommentBody.issues.length).toBe(1);
  });

  it("creates saved views and applies them to issue lists", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const todoIssue = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Todo issue",
          description: "todo desc",
          status: "todo",
        }),
      }),
      env
    );
    expect(todoIssue.status).toBe(201);

    await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Done issue",
          description: "done desc",
          status: "done",
        }),
      }),
      env
    );

    const filter = {
      op: "eq",
      field: "status",
      value: "todo",
    } as const;

    const createView = await app.fetch(
      request(`/workspaces/${organizationId}/saved-views`, {
        method: "POST",
        token,
        body: JSON.stringify({
          name: "Todo only",
          filter,
        }),
      }),
      env
    );
    expect(createView.status).toBe(201);
    const view = await createView.json<{ id: string }>();

    const apply = await app.fetch(
      request(`/workspaces/${organizationId}/issues?view=${view.id}`, {
        token,
      }),
      env
    );
    expect(apply.status).toBe(200);
    const applyBody = await apply.json<{ issues: unknown[] }>();
    expect(applyBody.issues.length).toBe(1);
  });

  it("creates parent/child issue hierarchies", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const parentRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Parent issue",
          priority: "high",
        }),
      }),
      env
    );
    expect(parentRes.status).toBe(201);
    const parent = await parentRes.json<{ id: string; priority: string }>();
    expect(parent.priority).toBe("high");

    const childRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Child issue",
          parentId: parent.id,
        }),
      }),
      env
    );
    expect(childRes.status).toBe(201);
    const child = await childRes.json<{
      id: string;
      parentId: string | null;
      priority: string;
    }>();
    expect(child.parentId).toBe(parent.id);
    expect(child.priority).toBe("high");

    const childrenRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${parent.id}/children`, {
        token,
      }),
      env
    );
    expect(childrenRes.status).toBe(200);
    const childrenBody = await childrenRes.json<{ issues: unknown[] }>();
    expect(childrenBody.issues).toHaveLength(1);

    const cycleRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${parent.id}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({ parentId: child.id }),
      }),
      env
    );
    expect(cycleRes.status).toBe(400);

    const hasParentRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues?hasParent=true`, {
        token,
      }),
      env
    );
    expect(hasParentRes.status).toBe(200);
    const hasParentBody = await hasParentRes.json<{ issues: unknown[] }>();
    expect(hasParentBody.issues.length).toBeGreaterThan(0);
    expect(
      hasParentBody.issues.every(
        (issue) =>
          typeof issue === "object" &&
          issue !== null &&
          "parentId" in issue &&
          issue.parentId !== null
      )
    ).toBe(true);

    const isParentRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues?isParent=true`, {
        token,
      }),
      env
    );
    expect(isParentRes.status).toBe(200);
    const isParentBody = await isParentRes.json<{ issues: unknown[] }>();
    expect(
      isParentBody.issues.some(
        (issue) =>
          typeof issue === "object" &&
          issue !== null &&
          "id" in issue &&
          issue.id === parent.id
      )
    ).toBe(true);
  });

  it("batch updates issues", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const issue1Res = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Batch one" }),
      }),
      env
    );
    expect(issue1Res.status).toBe(201);
    const issue1 = await issue1Res.json<{ id: string }>();

    const issue2Res = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Batch two" }),
      }),
      env
    );
    expect(issue2Res.status).toBe(201);
    const issue2 = await issue2Res.json<{ id: string }>();

    const batchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/batch`, {
        method: "POST",
        token,
        body: JSON.stringify({
          ids: [issue1.id, issue2.id],
          patch: { status: "done", resolution: "resolved" },
        }),
      }),
      env
    );
    expect(batchRes.status).toBe(200);
    const batchBody = await batchRes.json<{
      issues: { id: string; status: string; resolution: string | null }[];
    }>();
    expect(batchBody.issues).toHaveLength(2);
    expect(batchBody.issues.every((issue) => issue.status === "done")).toBe(
      true
    );
    expect(
      batchBody.issues.every((issue) => issue.resolution === "resolved")
    ).toBe(true);
  });

  it("manages reactions on issues and comments", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "React to me" }),
      }),
      env
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string }>();

    const reactRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/reactions`, {
        method: "POST",
        token,
        body: JSON.stringify({ emoji: "👍" }),
      }),
      env
    );
    expect(reactRes.status).toBe(201);
    const reaction = await reactRes.json<{ id: string }>();

    const listRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/reactions`, {
        token,
      }),
      env
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json<{ reactions: { emoji: string }[] }>();
    expect(listBody.reactions).toHaveLength(1);
    expect(listBody.reactions[0].emoji).toBe("👍");

    const commentRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/comments`, {
        method: "POST",
        token,
        body: JSON.stringify({ body: "A comment" }),
      }),
      env
    );
    expect(commentRes.status).toBe(201);
    const comment = await commentRes.json<{ id: string }>();

    const commentReactRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/comments/${comment.id}/reactions`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ emoji: "🎉" }),
        }
      ),
      env
    );
    expect(commentReactRes.status).toBe(201);

    const delRes = await app.fetch(
      request(`/workspaces/${organizationId}/reactions/${reaction.id}`, {
        method: "DELETE",
        token,
      }),
      env
    );
    expect(delRes.status).toBe(204);

    const afterDelRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/reactions`, {
        token,
      }),
      env
    );
    expect(afterDelRes.status).toBe(200);
    const afterDelBody = await afterDelRes.json<{ reactions: unknown[] }>();
    expect(afterDelBody.reactions).toHaveLength(0);
  });

  it("manages issue relations with all Linear types and inverse lookup", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const aRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Issue A" }),
      }),
      env
    );
    expect(aRes.status).toBe(201);
    const issueA = await aRes.json<{ id: string }>();

    const bRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Issue B" }),
      }),
      env
    );
    expect(bRes.status).toBe(201);
    const issueB = await bRes.json<{ id: string }>();

    const types = ["related", "blocks", "duplicate", "similar"] as const;
    const created = await Promise.all(
      types.map(async (type) => {
        const relRes = await app.fetch(
          request(
            `/workspaces/${organizationId}/issues/${issueA.id}/relations`,
            {
              method: "POST",
              token,
              body: JSON.stringify({ toIssueId: issueB.id, type }),
            }
          ),
          env
        );
        expect(relRes.status).toBe(201);
        return relRes.json<{ id: string; type: string }>();
      })
    );

    const outgoingRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/issues/${issueA.id}/relations?direction=outgoing`,
        { token }
      ),
      env
    );
    expect(outgoingRes.status).toBe(200);
    const outgoingBody = await outgoingRes.json<{
      relations: { type: string }[];
    }>();
    expect(outgoingBody.relations).toHaveLength(4);
    expect(
      types.every((type) =>
        outgoingBody.relations.some((rel) => rel.type === type)
      )
    ).toBe(true);

    const incomingRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/issues/${issueB.id}/relations?direction=incoming`,
        { token }
      ),
      env
    );
    expect(incomingRes.status).toBe(200);
    const incomingBody = await incomingRes.json<{
      inverseRelations: { type: string }[];
    }>();
    expect(incomingBody.inverseRelations).toHaveLength(4);

    const invalidRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issueA.id}/relations`, {
        method: "POST",
        token,
        body: JSON.stringify({ toIssueId: issueB.id, type: "unknown" }),
      }),
      env
    );
    expect(invalidRes.status).toBe(400);

    await Promise.all(
      created.map(async (rel) => {
        const delRes = await app.fetch(
          request(`/workspaces/${organizationId}/relations/${rel.id}`, {
            method: "DELETE",
            token,
          }),
          env
        );
        expect(delRes.status).toBe(204);
      })
    );

    const afterDelRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/issues/${issueA.id}/relations?direction=outgoing`,
        { token }
      ),
      env
    );
    expect(afterDelRes.status).toBe(200);
    const afterDelBody = await afterDelRes.json<{ relations: unknown[] }>();
    expect(afterDelBody.relations).toHaveLength(0);
  });

  it("creates notifications on issue creation and lists them", async () => {
    const db = createD1(env.D1);
    const organizationId = await seedWorkspace();
    const tokenRecord = await createAdminTokenRecord(organizationId);
    const token = tokenRecord.token;

    const userId = crypto.randomUUID();
    const now = new Date();
    await db.insert(userTable).values({
      id: userId,
      name: "Alice",
      email: "alice@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(memberTable).values({
      id: crypto.randomUUID(),
      organizationId: organizationId,
      userId,
      role: "member",
      createdAt: now,
    });

    const issue = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Notify me",
          description: "Assigned issue",
          assigneeId: userId,
        }),
      }),
      env
    );
    expect(issue.status).toBe(201);
    const issueData = await issue.json<{ id: string }>();

    const doStub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const userNotes = await doStub.listNotificationsForRecipient(
      userId,
      "user"
    );
    expect(userNotes.length).toBeGreaterThanOrEqual(1);
    expect(userNotes[0].type).toBe("issue_created");
    expect(userNotes[0].issueId).toBe(issueData.id);

    await doStub.createNotification({
      recipientId: tokenRecord.referenceId,
      recipientType: "user",
      issueId: issueData.id,
      type: "issue_created",
    });

    const list = await app.fetch(
      request(`/workspaces/${organizationId}/notifications`, { token }),
      env
    );
    expect(list.status).toBe(200);
    const listBody = await list.json<{ notifications: unknown[] }>();
    expect(listBody.notifications.length).toBe(1);

    const count = await app.fetch(
      request(`/workspaces/${organizationId}/notifications/unread-count`, {
        token,
      }),
      env
    );
    expect(count.status).toBe(200);
    const countBody = await count.json<{ count: number }>();
    expect(countBody.count).toBe(1);

    const noteId = (listBody.notifications[0] as { id: string }).id;
    const mark = await app.fetch(
      request(`/workspaces/${organizationId}/notifications/${noteId}/read`, {
        method: "PATCH",
        token,
      }),
      env
    );
    expect(mark.status).toBe(200);
    const markBody = await mark.json<{ read: boolean }>();
    expect(markBody.read).toBe(true);

    const markAll = await app.fetch(
      request(`/workspaces/${organizationId}/notifications/mark-all-read`, {
        method: "POST",
        token,
      }),
      env
    );
    expect(markAll.status).toBe(204);

    const comment = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issueData.id}/comments`, {
        method: "POST",
        token,
        body: JSON.stringify({ body: "New comment" }),
      }),
      env
    );
    expect(comment.status).toBe(201);
    await comment.json();

    const assigneeNotes = await doStub.listNotificationsForRecipient(
      userId,
      "user"
    );
    const commentNotes = assigneeNotes.filter(
      (n: { type: string }) => n.type === "comment_created"
    );
    expect(commentNotes.length).toBe(1);
    expect(commentNotes[0].issueId).toBe(issueData.id);
  });

  it("scopes issues to teams with per-team numbering and visibility", async () => {
    const organizationId = await seedWorkspace();
    const admin = await adminToken(organizationId);

    const teamA = await app.fetch(
      request(`/workspaces/${organizationId}/teams`, {
        method: "POST",
        token: admin,
        body: JSON.stringify({
          key: "ENG",
          name: "Engineering",
          isPublic: false,
        }),
      }),
      env
    );
    expect(teamA.status).toBe(201);
    const teamAData = await teamA.json<{ id: string; key: string }>();

    const teamB = await app.fetch(
      request(`/workspaces/${organizationId}/teams`, {
        method: "POST",
        token: admin,
        body: JSON.stringify({
          key: "DES",
          name: "Design",
          isPublic: false,
        }),
      }),
      env
    );
    expect(teamB.status).toBe(201);
    const teamBData = await teamB.json<{ id: string; key: string }>();

    const issueA = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token: admin,
        body: JSON.stringify({
          title: "Eng issue",
          teamId: teamAData.id,
        }),
      }),
      env
    );
    expect(issueA.status).toBe(201);
    const issueAData = await issueA.json<{ identifier: string }>();
    expect(issueAData.identifier).toBe("ENG-1");

    const issueB = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token: admin,
        body: JSON.stringify({
          title: "Des issue",
          teamId: teamBData.id,
        }),
      }),
      env
    );
    expect(issueB.status).toBe(201);
    const issueBData = await issueB.json<{ identifier: string }>();
    expect(issueBData.identifier).toBe("DES-1");

    const engList = await app.fetch(
      request(`/workspaces/${organizationId}/issues?teamId=${teamAData.id}`, {
        token: admin,
      }),
      env
    );
    expect(engList.status).toBe(200);
    const engBody = await engList.json<{ issues: { identifier: string }[] }>();
    expect(engBody.issues.length).toBe(1);
    expect(engBody.issues[0].identifier).toBe("ENG-1");

    const memberTokenRes = await app.fetch(
      request(`/workspaces/${organizationId}/tokens`, {
        method: "POST",
        token: admin,
        body: JSON.stringify({
          name: "member",
          permissions: "read,write",
          actorType: "agent",
        }),
      }),
      env
    );
    expect(memberTokenRes.status).toBe(201);
    const memberTokenData = await memberTokenRes.json<{
      id: string;
      token: string;
    }>();

    const addMember = await app.fetch(
      request(`/workspaces/${organizationId}/teams/${teamAData.id}/members`, {
        method: "POST",
        token: admin,
        body: JSON.stringify({
          memberId: memberTokenData.id,
          memberType: "agent",
        }),
      }),
      env
    );
    expect(addMember.status).toBe(204);

    const memberList = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        token: memberTokenData.token,
      }),
      env
    );
    expect(memberList.status).toBe(200);
    const memberBody = await memberList.json<{
      issues: { identifier: string }[];
    }>();
    expect(memberBody.issues.length).toBe(1);
    expect(memberBody.issues[0].identifier).toBe("ENG-1");

    const privateTeamList = await app.fetch(
      request(`/workspaces/${organizationId}/issues?teamId=${teamBData.id}`, {
        token: memberTokenData.token,
      }),
      env
    );
    expect(privateTeamList.status).toBe(404);
  });

  it("manages roadmaps and initiatives", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const roadmapRes = await app.fetch(
      request(`/workspaces/${organizationId}/roadmaps`, {
        method: "POST",
        token,
        body: JSON.stringify({
          name: "2026 Roadmap",
          description: "Annual product roadmap",
        }),
      }),
      env
    );
    expect(roadmapRes.status).toBe(201);
    const roadmapData = await roadmapRes.json<{
      id: string;
      name: string;
      description: string | null;
    }>();
    expect(roadmapData.name).toBe("2026 Roadmap");

    const createInitiative = await app.fetch(
      request(`/workspaces/${organizationId}/initiatives`, {
        method: "POST",
        token,
        body: JSON.stringify({
          roadmapId: roadmapData.id,
          name: "Platform scale",
          description: "Scale the platform",
          status: "active",
          startDate: "2026-01-01",
          targetDate: "2026-06-30",
        }),
      }),
      env
    );
    expect(createInitiative.status).toBe(201);
    const initiativeData = await createInitiative.json<{
      id: string;
      roadmapId: string | null;
      name: string;
    }>();
    expect(initiativeData.roadmapId).toBe(roadmapData.id);

    const listRoadmaps = await app.fetch(
      request(`/workspaces/${organizationId}/roadmaps`, { token }),
      env
    );
    expect(listRoadmaps.status).toBe(200);
    const roadmapsBody = await listRoadmaps.json<{ roadmaps: unknown[] }>();
    expect(roadmapsBody.roadmaps.length).toBe(1);

    const roadmapInitiatives = await app.fetch(
      request(
        `/workspaces/${organizationId}/roadmaps/${roadmapData.id}/initiatives`,
        { token }
      ),
      env
    );
    expect(roadmapInitiatives.status).toBe(200);
    const roadmapInitiativesBody = await roadmapInitiatives.json<{
      initiatives: { id: string }[];
    }>();
    expect(roadmapInitiativesBody.initiatives.length).toBe(1);
    expect(roadmapInitiativesBody.initiatives[0].id).toBe(initiativeData.id);

    const updateInitiative = await app.fetch(
      request(
        `/workspaces/${organizationId}/initiatives/${initiativeData.id}`,
        {
          method: "PATCH",
          token,
          body: JSON.stringify({ status: "completed" }),
        }
      ),
      env
    );
    expect(updateInitiative.status).toBe(200);
    const updated = await updateInitiative.json<{ status: string }>();
    expect(updated.status).toBe("completed");

    const deleteInitiative = await app.fetch(
      request(
        `/workspaces/${organizationId}/initiatives/${initiativeData.id}`,
        {
          method: "DELETE",
          token,
        }
      ),
      env
    );
    expect(deleteInitiative.status).toBe(204);

    const deleteRoadmap = await app.fetch(
      request(`/workspaces/${organizationId}/roadmaps/${roadmapData.id}`, {
        method: "DELETE",
        token,
      }),
      env
    );
    expect(deleteRoadmap.status).toBe(204);
  });

  it("manages issue approvals and unified activity", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const teamRes = await app.fetch(
      request(`/workspaces/${organizationId}/teams`, {
        method: "POST",
        token,
        body: JSON.stringify({ name: "Engineering" }),
      }),
      env
    );
    const team = await teamRes.json<{ id: string }>();

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Approval test", teamId: team.id }),
      }),
      env
    );
    const issue = await issueRes.json<{ id: string }>();

    const createRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/approvals`, {
        method: "POST",
        token,
        body: JSON.stringify({
          approverId: "user-1",
          comment: "Please review",
        }),
      }),
      env
    );
    expect(createRes.status).toBe(201);
    const approval = await createRes.json<{ id: string; status: string }>();
    expect(approval.status).toBe("pending");

    const listRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/approvals`, {
        token,
      }),
      env
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json<{
      approvals: Array<{ id: string; status: string }>;
    }>();
    expect(list.approvals).toHaveLength(1);

    const respondRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/approvals/${approval.id}/respond`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ status: "approved" }),
        }
      ),
      env
    );
    expect(respondRes.status).toBe(200);
    const resolved = await respondRes.json<{ status: string }>();
    expect(resolved.status).toBe("approved");

    const commentRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/comments`, {
        method: "POST",
        token,
        body: JSON.stringify({ body: "hello" }),
      }),
      env
    );
    expect(commentRes.status).toBe(201);

    const activityRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/activity`, {
        token,
      }),
      env
    );
    expect(activityRes.status).toBe(200);
    const activity = await activityRes.json<{
      activity: Array<{ kind: string }>;
    }>();
    expect(activity.activity.some((a) => a.kind === "comment")).toBe(true);
    expect(activity.activity.some((a) => a.kind === "history")).toBe(true);
  });

  it("exports workspace data and reports readiness", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const teamRes = await app.fetch(
      request(`/workspaces/${organizationId}/teams`, {
        method: "POST",
        token,
        body: JSON.stringify({ key: "ENG", name: "Engineering" }),
      }),
      env
    );
    const team = await teamRes.json<{ id: string }>();

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Export test", teamId: team.id }),
      }),
      env
    );
    const issue = await issueRes.json<{ id: string }>();

    const exportRes = await app.fetch(
      request(`/workspaces/${organizationId}/export`, { token }),
      env
    );
    expect(exportRes.status).toBe(200);
    const exportBody = await exportRes.json<{
      organizationId: string;
      issues: Array<{ id: string }>;
      comments: unknown[];
      teams: Array<{ id: string }>;
    }>();
    expect(exportBody.organizationId).toBe(organizationId);
    expect(exportBody.issues).toHaveLength(1);
    expect(exportBody.issues[0]?.id).toBe(issue.id);
    expect(exportBody.teams.some((t) => t.id === team.id)).toBe(true);

    const readinessRes = await app.fetch(
      request(`/workspaces/${organizationId}/readiness`, { token }),
      env
    );
    expect(readinessRes.status).toBe(200);
    const readiness = await readinessRes.json<{
      ready: boolean;
      checks: Array<{ name: string; ok: boolean; required: boolean }>;
    }>();
    expect(readiness.ready).toBe(true);
    expect(readiness.checks.find((c) => c.name === "issues")?.ok).toBe(true);
  });

  it("manages GitHub installations and user mappings", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const userRes = await app.fetch(
      request(`/workspaces/${organizationId}/github/users`, {
        method: "POST",
        token,
        body: JSON.stringify({ userId: "user-1", githubLogin: "shlomo" }),
      }),
      env
    );
    expect(userRes.status).toBe(201);

    const listUsersRes = await app.fetch(
      request(`/workspaces/${organizationId}/github/users`, { token }),
      env
    );
    expect(listUsersRes.status).toBe(200);
    const usersBody = await listUsersRes.json<{
      users: Array<{ githubLogin: string; userId: string }>;
    }>();
    expect(usersBody.users).toHaveLength(1);
    expect(usersBody.users[0]?.githubLogin).toBe("shlomo");

    const db = createD1(env.D1);
    const installationId = crypto.randomUUID();
    await db.insert(githubInstallationsTable).values({
      id: installationId,
      organizationId,
      installationId: "12345",
      repo: "vortex/app",
    });

    const listInstallsRes = await app.fetch(
      request(`/workspaces/${organizationId}/github/installations`, { token }),
      env
    );
    expect(listInstallsRes.status).toBe(200);
    const installsBody = await listInstallsRes.json<{
      installations: Array<{ id: string; repo: string }>;
    }>();
    expect(installsBody.installations).toHaveLength(1);
    expect(installsBody.installations[0]?.repo).toBe("vortex/app");

    const deleteRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/github/installations/${installationId}`,
        { method: "DELETE", token }
      ),
      env
    );
    expect(deleteRes.status).toBe(204);

    const afterRes = await app.fetch(
      request(`/workspaces/${organizationId}/github/installations`, { token }),
      env
    );
    expect(afterRes.status).toBe(200);
    const afterBody = await afterRes.json<{
      installations: Array<{ id: string; repo: string }>;
    }>();
    expect(afterBody.installations).toHaveLength(0);
  });

  it("manages GitLab installations, user mappings, and webhooks", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);
    const db = createD1(env.D1);

    const userRes = await app.fetch(
      request(`/workspaces/${organizationId}/gitlab/users`, {
        method: "POST",
        token,
        body: JSON.stringify({ userId: "user-1", gitlabUsername: "shlomo" }),
      }),
      env
    );
    expect(userRes.status).toBe(201);

    const listUsersRes = await app.fetch(
      request(`/workspaces/${organizationId}/gitlab/users`, { token }),
      env
    );
    expect(listUsersRes.status).toBe(200);
    const usersBody = await listUsersRes.json<{
      users: Array<{ gitlabUsername: string; userId: string }>;
    }>();
    expect(usersBody.users).toHaveLength(1);
    expect(usersBody.users[0]?.gitlabUsername).toBe("shlomo");

    const projectPath = "vortex/gitlab-test";
    await createGitlabInstallation(
      db,
      organizationId,
      "123",
      projectPath,
      "gltoken",
      "webhook-secret"
    );

    const listInstallsRes = await app.fetch(
      request(`/workspaces/${organizationId}/gitlab/installations`, { token }),
      env
    );
    expect(listInstallsRes.status).toBe(200);
    const installsBody = await listInstallsRes.json<{
      installations: Array<{ projectPath: string }>;
    }>();
    expect(installsBody.installations).toHaveLength(1);
    expect(installsBody.installations[0]?.projectPath).toBe(projectPath);

    const basePayload = {
      object_kind: "issue" as const,
      event_type: "issue",
      project: { id: 123, path_with_namespace: projectPath },
      object_attributes: {
        id: 1,
        iid: 42,
        title: "GitLab issue title",
        description: "GitLab issue body",
        state: "opened",
        action: "open",
        url: "https://gitlab.com/vortex/gitlab-test/-/issues/42",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        assignees: [{ username: "shlomo" }],
        labels: [],
      },
    };

    const gitlabRequest = (body: unknown, headers?: Record<string, string>) =>
      request("/gitlab", {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "X-Gitlab-Token": "webhook-secret",
          ...headers,
        },
      });

    const invalidRes = await app.fetch(
      gitlabRequest(basePayload, { "X-Gitlab-Token": "wrong" }),
      env
    );
    expect(invalidRes.status).toBe(401);

    const malformedRes = await app.fetch(
      request("/gitlab", {
        method: "POST",
        body: "not-json",
        headers: { "X-Gitlab-Token": "webhook-secret" },
      }),
      env
    );
    expect(malformedRes.status).toBe(400);

    const unknownProjectRes = await app.fetch(
      gitlabRequest({
        object_kind: "issue",
        project: {
          id: 999,
          path_with_namespace: "unknown/project",
        },
        object_attributes: {
          id: 99,
          iid: 99,
          title: "Unknown",
          description: null,
          state: "opened",
          action: "open",
          url: "https://gitlab.com/unknown/project/-/issues/99",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          assignees: [],
          labels: [],
        },
      }),
      env
    );
    expect(unknownProjectRes.status).toBe(200);

    const createRes = await app.fetch(gitlabRequest(basePayload), env);
    expect(createRes.status).toBe(200);

    const dedupeRes = await app.fetch(gitlabRequest(basePayload), env);
    expect(dedupeRes.status).toBe(200);

    const issuesRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, { token }),
      env
    );
    expect(issuesRes.status).toBe(200);
    const issuesBody = await issuesRes.json<{
      issues: Array<{
        id: string;
        title: string;
        status: string;
        assigneeId: string | null;
      }>;
    }>();
    expect(issuesBody.issues).toHaveLength(1);
    expect(issuesBody.issues[0]?.title).toBe("GitLab issue title");
    expect(issuesBody.issues[0]?.status).toBe("backlog");
    expect(issuesBody.issues[0]?.assigneeId).toBe("user-1");

    const issueId = issuesBody.issues[0]!.id;

    const updateRes = await app.fetch(
      gitlabRequest({
        ...basePayload,
        object_attributes: {
          ...basePayload.object_attributes,
          title: "Updated title",
          action: "update",
          updated_at: "2026-01-01T00:01:00Z",
        },
      }),
      env
    );
    expect(updateRes.status).toBe(200);

    const getRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issueId}`, { token }),
      env
    );
    expect(getRes.status).toBe(200);
    const getIssue = await getRes.json<{ title: string }>();
    expect(getIssue.title).toBe("Updated title");

    const closeRes = await app.fetch(
      gitlabRequest({
        ...basePayload,
        object_attributes: {
          ...basePayload.object_attributes,
          state: "closed",
          action: "close",
          updated_at: "2026-01-01T00:02:00Z",
        },
      }),
      env
    );
    expect(closeRes.status).toBe(200);

    const afterCloseRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issueId}`, { token }),
      env
    );
    expect(afterCloseRes.status).toBe(200);
    const closedIssue = await afterCloseRes.json<{ status: string }>();
    expect(closedIssue.status).toBe("canceled");

    const notePayload = {
      object_kind: "note" as const,
      event_type: "note",
      project: { id: 123, path_with_namespace: projectPath },
      object_attributes: {
        id: 10,
        note: "A GitLab note",
        noteable_type: "Issue",
        noteable_id: 42,
        created_at: "2026-01-01T00:10:00Z",
        updated_at: "2026-01-01T00:10:00Z",
        action: "created",
      },
      issue: { iid: 42, title: "Updated title" },
      author: { username: "shlomo", name: "Shlomo" },
    };

    const noteRes = await app.fetch(gitlabRequest(notePayload), env);
    expect(noteRes.status).toBe(200);

    const commentsRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issueId}/comments`, {
        token,
      }),
      env
    );
    expect(commentsRes.status).toBe(200);
    const commentsBody = await commentsRes.json<{
      comments: Array<{ id: string; body: string }>;
    }>();
    expect(commentsBody.comments).toHaveLength(1);
    expect(commentsBody.comments[0]?.body).toBe("A GitLab note");

    const noteUpdateRes = await app.fetch(
      gitlabRequest({
        ...notePayload,
        object_attributes: {
          ...notePayload.object_attributes,
          note: "Updated note",
          action: "updated",
          updated_at: "2026-01-01T00:11:00Z",
        },
      }),
      env
    );
    expect(noteUpdateRes.status).toBe(200);

    const commentsAfterUpdateRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issueId}/comments`, {
        token,
      }),
      env
    );
    expect(commentsAfterUpdateRes.status).toBe(200);
    const commentsAfterUpdate = await commentsAfterUpdateRes.json<{
      comments: Array<{ body: string }>;
    }>();
    expect(commentsAfterUpdate.comments[0]?.body).toBe("Updated note");

    const noteDeleteRes = await app.fetch(
      gitlabRequest({
        ...notePayload,
        object_attributes: {
          ...notePayload.object_attributes,
          action: "deleted",
          updated_at: "2026-01-01T00:12:00Z",
        },
      }),
      env
    );
    expect(noteDeleteRes.status).toBe(200);

    const commentsAfterDeleteRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issueId}/comments`, {
        token,
      }),
      env
    );
    expect(commentsAfterDeleteRes.status).toBe(200);
    const commentsAfterDelete = await commentsAfterDeleteRes.json<{
      comments: Array<unknown>;
    }>();
    expect(commentsAfterDelete.comments).toHaveLength(0);
  });

  it("syncs GitLab merge requests and MR notes into Vortex", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);
    const db = createD1(env.D1);

    const projectPath = "vortex/gitlab-mr";
    await createGitlabInstallation(
      db,
      organizationId,
      "456",
      projectPath,
      "gltoken",
      "webhook-secret"
    );

    const issueWithBranchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Backend issue",
          repo: projectPath,
          branch: "feature/backend",
        }),
      }),
      env
    );
    expect(issueWithBranchRes.status).toBe(201);
    const issueWithBranch = await issueWithBranchRes.json<{
      id: string;
      identifier: string;
    }>();

    const issueByIdentifierRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Linked issue",
        }),
      }),
      env
    );
    expect(issueByIdentifierRes.status).toBe(201);
    const linkedIssue = await issueByIdentifierRes.json<{
      id: string;
      identifier: string;
    }>();

    const gitlabRequest = (body: unknown) =>
      request("/gitlab", {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "X-Gitlab-Token": "webhook-secret",
        },
      });

    const openMrPayload = {
      object_kind: "merge_request" as const,
      event_type: "merge_request",
      project: { id: 456, path_with_namespace: projectPath },
      object_attributes: {
        id: 100,
        iid: 7,
        title: `Fixes ${linkedIssue.identifier}`,
        description: "MR description",
        state: "opened",
        action: "open",
        draft: false,
        work_in_progress: false,
        source_branch: "feature/backend",
        target_branch: "main",
        url: "https://gitlab.com/vortex/gitlab-mr/-/merge_requests/7",
        source: { id: 456, path_with_namespace: projectPath },
        target: { id: 456, path_with_namespace: projectPath },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      author: { username: "shlomo", name: "Shlomo" },
    };

    const openMrRes = await app.fetch(gitlabRequest(openMrPayload), env);
    expect(openMrRes.status).toBe(200);

    const issueWithBranchAfterMrRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issueWithBranch.id}`, {
        token,
      }),
      env
    );
    expect(issueWithBranchAfterMrRes.status).toBe(200);
    const issueWithBranchAfterMr = await issueWithBranchAfterMrRes.json<{
      prUrl: string | null;
      prState: string | null;
      status: string;
    }>();
    expect(issueWithBranchAfterMr.prUrl).toBe(
      "https://gitlab.com/vortex/gitlab-mr/-/merge_requests/7"
    );
    expect(issueWithBranchAfterMr.prState).toBe("open");
    expect(issueWithBranchAfterMr.status).toBe("in_progress");

    const linkedIssueAfterMrRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${linkedIssue.id}`, {
        token,
      }),
      env
    );
    expect(linkedIssueAfterMrRes.status).toBe(200);
    const linkedIssueAfterMr = await linkedIssueAfterMrRes.json<{
      prUrl: string | null;
      prState: string | null;
      repo: string | null;
      branch: string | null;
      status: string;
    }>();
    expect(linkedIssueAfterMr.prUrl).toBe(
      "https://gitlab.com/vortex/gitlab-mr/-/merge_requests/7"
    );
    expect(linkedIssueAfterMr.prState).toBe("open");
    expect(linkedIssueAfterMr.repo).toBe(projectPath);
    expect(linkedIssueAfterMr.branch).toBe("feature/backend");
    expect(linkedIssueAfterMr.status).toBe("in_progress");

    const mrNotePayload = {
      object_kind: "note" as const,
      event_type: "note",
      project: { id: 456, path_with_namespace: projectPath },
      object_attributes: {
        id: 20,
        note: "MR review note",
        noteable_type: "MergeRequest",
        noteable_id: 7,
        action: "created",
        created_at: "2026-01-01T00:10:00Z",
        updated_at: "2026-01-01T00:10:00Z",
      },
      merge_request: {
        iid: 7,
        source_branch: "feature/backend",
        source: { id: 456, path_with_namespace: projectPath },
        target: { id: 456, path_with_namespace: projectPath },
      },
      author: { username: "shlomo", name: "Shlomo" },
    };

    const mrNoteRes = await app.fetch(gitlabRequest(mrNotePayload), env);
    expect(mrNoteRes.status).toBe(200);

    const commentsRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/issues/${issueWithBranch.id}/comments`,
        { token }
      ),
      env
    );
    expect(commentsRes.status).toBe(200);
    const commentsBody = await commentsRes.json<{
      comments: Array<{ body: string }>;
    }>();
    expect(commentsBody.comments).toHaveLength(1);
    expect(commentsBody.comments[0]?.body).toBe("MR review note");

    const mergeMrPayload = {
      ...openMrPayload,
      object_attributes: {
        ...openMrPayload.object_attributes,
        state: "merged",
        action: "merge",
        updated_at: "2026-01-01T00:20:00Z",
      },
    };

    const mergeMrRes = await app.fetch(gitlabRequest(mergeMrPayload), env);
    expect(mergeMrRes.status).toBe(200);

    const issueAfterMergeRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issueWithBranch.id}`, {
        token,
      }),
      env
    );
    expect(issueAfterMergeRes.status).toBe(200);
    const issueAfterMerge = await issueAfterMergeRes.json<{
      prState: string | null;
      status: string;
    }>();
    expect(issueAfterMerge.prState).toBe("merged");
    expect(issueAfterMerge.status).toBe("done");
  });

  it("syncs GitLab labels, milestones, and assignees on issues", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);
    const db = createD1(env.D1);

    const projectPath = "vortex/gitlab-attrs";
    await createGitlabInstallation(
      db,
      organizationId,
      "789",
      projectPath,
      "gltoken",
      "webhook-secret"
    );

    await app.fetch(
      request(`/workspaces/${organizationId}/gitlab/users`, {
        method: "POST",
        token,
        body: JSON.stringify({ userId: "user-1", gitlabUsername: "shlomo" }),
      }),
      env
    );

    const labelRes = await app.fetch(
      request(`/workspaces/${organizationId}/labels`, {
        method: "POST",
        token,
        body: JSON.stringify({ name: "bug", color: "#ff0000" }),
      }),
      env
    );
    expect(labelRes.status).toBe(201);
    const label = await labelRes.json<{ id: string }>();

    const cycleRes = await app.fetch(
      request(`/workspaces/${organizationId}/cycles`, {
        method: "POST",
        token,
        body: JSON.stringify({ name: "Sprint 1" }),
      }),
      env
    );
    expect(cycleRes.status).toBe(201);
    const cycle = await cycleRes.json<{ id: string }>();

    const gitlabRequest = (body: unknown) =>
      request("/gitlab", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "X-Gitlab-Token": "webhook-secret" },
      });

    const issuePayload = {
      object_kind: "issue" as const,
      event_type: "issue",
      project: { id: 789, path_with_namespace: projectPath },
      object_attributes: {
        id: 30,
        iid: 50,
        title: "Issue with attributes",
        description: "desc",
        state: "opened",
        action: "open",
        url: "https://gitlab.com/vortex/gitlab-attrs/-/issues/50",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        assignees: [{ username: "shlomo" }],
        labels: [{ title: "bug" }],
        milestone: { title: "Sprint 1" },
      },
    };

    const createRes = await app.fetch(gitlabRequest(issuePayload), env);
    expect(createRes.status).toBe(200);

    const issuesRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, { token }),
      env
    );
    expect(issuesRes.status).toBe(200);
    const issuesBody = await issuesRes.json<{
      issues: Array<{
        id: string;
        labelIds: string | null;
        cycleId: string | null;
        assigneeId: string | null;
      }>;
    }>();
    expect(issuesBody.issues).toHaveLength(1);
    expect(issuesBody.issues[0]?.labelIds).toBe(label.id);
    expect(issuesBody.issues[0]?.cycleId).toBe(cycle.id);
    expect(issuesBody.issues[0]?.assigneeId).toBe("user-1");

    const issueId = issuesBody.issues[0]!.id;

    const updateRes = await app.fetch(
      gitlabRequest({
        ...issuePayload,
        object_attributes: {
          ...issuePayload.object_attributes,
          action: "update",
          assignees: [],
          labels: [],
          milestone: null,
          updated_at: "2026-01-01T00:01:00Z",
        },
      }),
      env
    );
    expect(updateRes.status).toBe(200);

    const issueAfterUpdateRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issueId}`, { token }),
      env
    );
    expect(issueAfterUpdateRes.status).toBe(200);
    const issueAfterUpdate = await issueAfterUpdateRes.json<{
      labelIds: string | null;
      cycleId: string | null;
      assigneeId: string | null;
    }>();
    expect(issueAfterUpdate.labelIds).toBeNull();
    expect(issueAfterUpdate.cycleId).toBeNull();
    expect(issueAfterUpdate.assigneeId).toBeNull();
  });

  it("syncs GitLab MR diff notes as file-annotated comments", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);
    const db = createD1(env.D1);

    const projectPath = "vortex/gitlab-diff";
    await createGitlabInstallation(
      db,
      organizationId,
      "900",
      projectPath,
      "gltoken",
      "webhook-secret"
    );

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Review target",
          repo: projectPath,
          branch: "feature/diff",
        }),
      }),
      env
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string }>();

    const diffNotePayload = {
      object_kind: "note" as const,
      event_type: "note",
      project: { id: 900, path_with_namespace: projectPath },
      object_attributes: {
        id: 50,
        note: "This looks wrong",
        noteable_type: "MergeRequest",
        noteable_id: 9,
        action: "created",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        position: {
          new_path: "src/agents/gitlab.ts",
          old_path: "src/agents/gitlab.ts",
        },
      },
      merge_request: {
        iid: 9,
        source_branch: "feature/diff",
        source: { id: 900, path_with_namespace: projectPath },
        target: { id: 900, path_with_namespace: projectPath },
      },
      author: { username: "shlomo", name: "Shlomo" },
    };

    const diffNoteRes = await app.fetch(
      request("/gitlab", {
        method: "POST",
        body: JSON.stringify(diffNotePayload),
        headers: { "X-Gitlab-Token": "webhook-secret" },
      }),
      env
    );
    expect(diffNoteRes.status).toBe(200);

    const commentsRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/comments`, {
        token,
      }),
      env
    );
    expect(commentsRes.status).toBe(200);
    const commentsBody = await commentsRes.json<{
      comments: Array<{ body: string }>;
    }>();
    expect(commentsBody.comments).toHaveLength(1);
    expect(commentsBody.comments[0]?.body).toBe(
      "[src/agents/gitlab.ts] This looks wrong"
    );
  });

  it("manages Slack installation state and verifies events", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const statusRes = await app.fetch(
      request(`/workspaces/${organizationId}/slack`, { token }),
      env
    );
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json<{ installed: boolean }>();
    expect(statusBody.installed).toBe(false);

    const installRes = await app.fetch(
      request(`/workspaces/${organizationId}/slack/install`, {
        method: "POST",
        token,
      }),
      env
    );
    expect(installRes.status).toBe(200);
    const installBody = await installRes.json<{ url: string }>();
    const installUrl = new URL(installBody.url);
    expect(installUrl.hostname).toBe("slack.com");
    expect(installUrl.searchParams.get("state")).toBe(organizationId);
    expect(installUrl.searchParams.get("client_id")).toBe(
      "test-slack-client-id"
    );

    const channelRes = await app.fetch(
      request(`/workspaces/${organizationId}/slack/channel`, {
        method: "POST",
        token,
        body: JSON.stringify({ channelId: "C123" }),
      }),
      env
    );
    expect(channelRes.status).toBe(404);

    const deleteRes = await app.fetch(
      request(`/workspaces/${organizationId}/slack`, {
        method: "DELETE",
        token,
      }),
      env
    );
    expect(deleteRes.status).toBe(404);

    const body = JSON.stringify({
      type: "url_verification",
      challenge: "test-challenge",
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = `v0=${await hmacSha256Hex(
      "test-slack-signing-secret",
      `v0:${timestamp}:${body}`
    )}`;
    const eventsRes = await app.fetch(
      new Request("http://localhost/slack/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": signature,
        },
        body,
      }),
      env
    );
    expect(eventsRes.status).toBe(200);
    const eventsBody = await eventsRes.json<{ challenge: string }>();
    expect(eventsBody.challenge).toBe("test-challenge");

    const badRes = await app.fetch(
      new Request("http://localhost/slack/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": "v0=invalid",
        },
        body,
      }),
      env
    );
    expect(badRes.status).toBe(401);
  });

  it("imports Notion pages into Vortex documents", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const notionRequests: { method: string; path: string }[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const path = notionPath(input);
      if (!path) return originalFetch(input, init);

      const method = init?.method ?? "GET";
      notionRequests.push({ method, path });

      if (method === "GET" && path === "/users/me") {
        return Response.json({
          object: "user",
          id: "bot-1",
          type: "bot",
          bot: {
            owner: { type: "workspace", workspace: true },
            workspace_name: "Test Notion",
            workspace_id: "ws-1",
          },
        });
      }

      if (method === "GET" && path === "/pages/page-1") {
        return Response.json({
          object: "page",
          id: "page-1",
          url: "https://www.notion.so/page-1",
          icon: { type: "emoji", emoji: "📄" },
          properties: {
            title: {
              title: [{ plain_text: "Hello Notion" }],
            },
          },
          parent: { type: "page_id", page_id: "parent-page-1" },
          created_by: { id: "notion-user-1" },
          last_edited_by: { id: "notion-user-1" },
        });
      }

      if (method === "GET" && path === "/pages/page-1/markdown") {
        return Response.json({
          object: "page_markdown",
          id: "page-1",
          markdown: "# Hello Notion\n\nImported body.",
        });
      }

      if (method === "POST" && path === "/search") {
        return Response.json({
          object: "list",
          results: [
            {
              object: "page",
              id: "search-page-1",
              url: "https://www.notion.so/search-page-1",
              properties: {
                title: {
                  title: [{ plain_text: "Search Page" }],
                },
              },
              parent: { type: "workspace" },
            },
          ],
          has_more: false,
          next_cursor: null,
        });
      }

      if (method === "GET" && path === "/pages/search-page-1") {
        return Response.json({
          object: "page",
          id: "search-page-1",
          url: "https://www.notion.so/search-page-1",
          properties: {
            title: {
              title: [{ plain_text: "Search Page" }],
            },
          },
          parent: { type: "workspace" },
          created_by: { id: "notion-user-1" },
          last_edited_by: { id: "notion-user-1" },
        });
      }

      if (method === "GET" && path === "/pages/search-page-1/markdown") {
        return Response.json({
          object: "page_markdown",
          id: "search-page-1",
          markdown: "# Search Page\n\nBody.",
        });
      }

      return new Response("Not Found", { status: 404 });
    };

    try {
      const userRes = await app.fetch(
        request(`/workspaces/${organizationId}/notion/users`, {
          method: "POST",
          token,
          body: JSON.stringify({
            userId: "user-1",
            notionUserId: "notion-user-1",
          }),
        }),
        env
      );
      expect(userRes.status).toBe(201);

      const listUsersRes = await app.fetch(
        request(`/workspaces/${organizationId}/notion/users`, { token }),
        env
      );
      expect(listUsersRes.status).toBe(200);
      const usersBody = await listUsersRes.json<{
        users: Array<{ userId: string; notionUserId: string }>;
      }>();
      expect(usersBody.users).toHaveLength(1);
      expect(usersBody.users[0]?.notionUserId).toBe("notion-user-1");

      const rootRes = await app.fetch(
        request(`/workspaces/${organizationId}/notion/import`, {
          method: "POST",
          token,
          body: JSON.stringify({ token: "ntn-test", rootPageId: "page-1" }),
        }),
        env
      );
      expect(rootRes.status).toBe(200);
      const rootBody = await rootRes.json<{
        created: number;
        updated: number;
        errors: number;
        workspaceId: string;
        workspaceName: string | null;
      }>();
      expect(rootBody.created).toBe(1);
      expect(rootBody.updated).toBe(0);
      expect(rootBody.errors).toBe(0);
      expect(rootBody.workspaceId).toBe("ws-1");

      const docsRes = await app.fetch(
        request(`/workspaces/${organizationId}/documents`, { token }),
        env
      );
      expect(docsRes.status).toBe(200);
      const docsBody = await docsRes.json<{ documents: unknown[] }>();
      expect(docsBody.documents).toHaveLength(1);

      const searchRes = await app.fetch(
        request(`/workspaces/${organizationId}/notion/import`, {
          method: "POST",
          token,
          body: JSON.stringify({ token: "ntn-test" }),
        }),
        env
      );
      expect(searchRes.status).toBe(200);
      const searchBody = await searchRes.json<{
        created: number;
        updated: number;
        errors: number;
      }>();
      expect(searchBody.created).toBe(1);
      expect(searchBody.updated).toBe(0);
      expect(searchBody.errors).toBe(0);

      const allDocsRes = await app.fetch(
        request(`/workspaces/${organizationId}/documents`, { token }),
        env
      );
      expect(allDocsRes.status).toBe(200);
      const allDocsBody = await allDocsRes.json<{ documents: unknown[] }>();
      expect(allDocsBody.documents).toHaveLength(2);

      const getDocRes = await app.fetch(
        request(
          `/workspaces/${organizationId}/documents/${(allDocsBody.documents[1] as { id: string }).id}`,
          { token }
        ),
        env
      );
      expect(getDocRes.status).toBe(200);
      const doc = await getDocRes.json<{
        title: string;
        contentFormat: string;
        content: string;
        icon: string | null;
      }>();
      expect(doc.title).toBe("Search Page");
      expect(doc.contentFormat).toBe("markdown");
      expect(doc.content).toBe("# Search Page\n\nBody.");
      expect(doc.icon).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("imports Jira issues into Vortex", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const jiraHost = "https://jira-test.example.com";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (!url.startsWith(jiraHost)) return originalFetch(input, init);
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";

      if (method === "GET" && path === "/rest/api/3/myself") {
        return Response.json({
          accountId: "jira-me",
          emailAddress: "me@example.com",
          displayName: "Me",
        });
      }

      if (method === "POST" && path === "/rest/api/3/search/jql") {
        return Response.json({
          issues: [
            {
              id: "10000",
              key: "TEST-1",
              fields: {
                summary: "Jira issue title",
                description: {
                  type: "doc",
                  version: 1,
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Body" }],
                    },
                  ],
                },
                status: {
                  id: "1",
                  name: "In Progress",
                  statusCategory: { key: "indeterminate", name: "In Progress" },
                },
                priority: { name: "High" },
                assignee: {
                  accountId: "jira-user-1",
                  emailAddress: "assignee@example.com",
                  displayName: "Assignee",
                },
                reporter: { accountId: "jira-me" },
                labels: ["backend"],
                issuetype: { name: "Story" },
                created: "2026-01-01T00:00:00.000+0000",
                updated: "2026-01-02T00:00:00.000+0000",
                comment: {
                  comments: [
                    {
                      id: "comment-1",
                      body: {
                        type: "doc",
                        version: 1,
                        content: [
                          {
                            type: "paragraph",
                            content: [{ type: "text", text: "Comment body" }],
                          },
                        ],
                      },
                      author: {
                        accountId: "jira-user-1",
                        emailAddress: "assignee@example.com",
                        displayName: "Assignee",
                      },
                      created: "2026-01-01T00:00:00.000+0000",
                      updated: "2026-01-01T00:00:00.000+0000",
                    },
                  ],
                },
                attachment: [
                  {
                    id: "att-1",
                    filename: "note.txt",
                    contentType: "text/plain",
                    created: "2026-01-01T00:00:00.000+0000",
                  },
                ],
                project: { id: "1", key: "TEST", name: "Test Project" },
              },
            },
          ],
          maxResults: 100,
        });
      }

      return new Response("Not Found", { status: 404 });
    };

    try {
      const importRes = await app.fetch(
        request(`/workspaces/${organizationId}/import`, {
          method: "POST",
          token,
          body: JSON.stringify({
            source: "jira",
            credentials: {
              host: jiraHost,
              email: "me@example.com",
              token: "secret",
            },
            options: { projectKey: "TEST" },
          }),
        }),
        env
      );
      expect(importRes.status).toBe(200);
      const importBody = await importRes.json<{
        ok: boolean;
        counts: Record<string, number>;
      }>();
      expect(importBody.ok).toBe(true);
      expect(importBody.counts.issues).toBe(1);
      expect(importBody.counts.comments).toBe(1);

      const issuesRes = await app.fetch(
        request(`/workspaces/${organizationId}/issues`, { token }),
        env
      );
      expect(issuesRes.status).toBe(200);
      const issuesBody = await issuesRes.json<{
        issues: Array<{ title: string; status: string }>;
      }>();
      expect(issuesBody.issues).toHaveLength(1);
      expect(issuesBody.issues[0]?.title).toBe("Jira issue title");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("imports Confluence pages into Vortex documents", async () => {
    const organizationId = await seedWorkspace();
    const token = await adminToken(organizationId);

    const confluenceHost = "https://confluence-test.example.com";
    const adf = JSON.stringify({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello Confluence" }],
        },
      ],
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (!url.startsWith(confluenceHost)) return originalFetch(input, init);
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";

      if (method === "GET" && path === "/wiki/rest/api/space/TEST") {
        return Response.json({
          id: "space-1",
          key: "TEST",
          name: "Test Space",
        });
      }

      if (method === "GET" && path === "/wiki/api/v2/pages") {
        return Response.json({
          results: [
            {
              id: "page-1",
              status: "current",
              title: "Confluence Page",
              spaceId: "space-1",
              authorId: "conf-me",
              ownerId: "conf-me",
              createdAt: "2026-01-01T00:00:00.000+0000",
              version: { createdAt: "2026-01-01T00:00:00.000+0000" },
              body: { atlas_doc_format: { value: adf } },
            },
          ],
          _links: {},
        });
      }

      if (method === "GET" && path === "/wiki/rest/api/user") {
        return Response.json({
          accountId: "conf-me",
          email: "me@example.com",
          displayName: "Me",
        });
      }

      return new Response("Not Found", { status: 404 });
    };

    try {
      const importRes = await app.fetch(
        request(`/workspaces/${organizationId}/import`, {
          method: "POST",
          token,
          body: JSON.stringify({
            source: "confluence",
            credentials: {
              host: confluenceHost,
              email: "me@example.com",
              token: "secret",
            },
            options: { spaceKey: "TEST" },
          }),
        }),
        env
      );
      expect(importRes.status).toBe(200);
      const importBody = await importRes.json<{
        ok: boolean;
        counts: Record<string, number>;
      }>();
      expect(importBody.ok).toBe(true);
      expect(importBody.counts.documents).toBe(1);

      const docsRes = await app.fetch(
        request(`/workspaces/${organizationId}/documents`, { token }),
        env
      );
      expect(docsRes.status).toBe(200);
      const docsBody = await docsRes.json<{
        documents: Array<{ title: string; content: string }>;
      }>();
      expect(docsBody.documents).toHaveLength(1);
      expect(docsBody.documents[0]?.title).toBe("Confluence Page");
      expect(docsBody.documents[0]?.content).toContain("Hello Confluence");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
