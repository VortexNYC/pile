import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import {
  createNotification,
  getNotificationsForRecipient,
} from "../global/notifications.js";
import { user as userTable, workspaceMemberships } from "../global/schema.js";
import { createWorkspaceToken } from "../global/tokens.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import type { WorkerEnv } from "../platform/middleware.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

const ORIGIN = "https://your-domain.com";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const workspace = await createWorkspace(db, {
    name: "Test workspace",
    slug: `test-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-1",
  });
  return workspace!.id;
}

async function adminToken(workspaceId: string) {
  const token = await createAdminTokenRecord(workspaceId);
  return token.token;
}

async function createAdminTokenRecord(workspaceId: string) {
  const db = createD1(env.D1);
  return createWorkspaceToken(
    db,
    workspaceId,
    "test-admin",
    "admin",
    env.TOKEN_HASH_SECRET
  );
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
    const workspaceId = await seedWorkspace();
    const token = await adminToken(workspaceId);

    const create = await app.fetch(
      request("/workspaces/" + workspaceId + "/states", {
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
      request("/workspaces/" + workspaceId + "/states", { token }),
      env
    );
    expect(list.status).toBe(200);
    const listBody = await list.json<{ states: unknown[] }>();
    expect(listBody.states).toHaveLength(1);

    const get = await app.fetch(
      request("/workspaces/" + workspaceId + "/states/" + state.id, { token }),
      env
    );
    expect(get.status).toBe(200);

    const patch = await app.fetch(
      request("/workspaces/" + workspaceId + "/states/" + state.id, {
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
      request("/workspaces/" + workspaceId + "/states/" + state.id, {
        method: "DELETE",
        token,
      }),
      env
    );
    expect(del.status).toBe(204);
  });

  it("manages workspace tokens", async () => {
    const workspaceId = await seedWorkspace();
    const token = await adminToken(workspaceId);

    const create = await app.fetch(
      request("/workspaces/" + workspaceId + "/tokens", {
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
      request("/workspaces/" + workspaceId + "/tokens", { token }),
      env
    );
    expect(list.status).toBe(200);
    const listBody = await list.json<{ tokens: unknown[] }>();
    expect(listBody.tokens.length).toBeGreaterThanOrEqual(1);

    const del = await app.fetch(
      request("/workspaces/" + workspaceId + "/tokens/" + created.id, {
        method: "DELETE",
        token,
      }),
      env
    );
    expect(del.status).toBe(204);
  });

  it("manages memberships", async () => {
    const workspaceId = await seedWorkspace();
    const token = await adminToken(workspaceId);

    const create = await app.fetch(
      request("/workspaces/" + workspaceId + "/memberships", {
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
      request("/workspaces/" + workspaceId + "/memberships", { token }),
      env
    );
    expect(list.status).toBe(200);
    const listBody = await list.json<{ memberships: unknown[] }>();
    expect(listBody.memberships).toHaveLength(1);
  });

  it("manages linear users", async () => {
    const workspaceId = await seedWorkspace();
    const token = await adminToken(workspaceId);

    const create = await app.fetch(
      request("/workspaces/" + workspaceId + "/linear-users", {
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
      request("/workspaces/" + workspaceId + "/linear-users/" + user.linearId, {
        token,
      }),
      env
    );
    expect(get.status).toBe(200);
    const got = await get.json<{ id: string }>();
    expect(got.id).toBe(user.id);
  });

  it("manages issue subscribers", async () => {
    const workspaceId = await seedWorkspace();
    const issueId = "issue-1";
    const token = await adminToken(workspaceId);

    const create = await app.fetch(
      request(
        "/workspaces/" + workspaceId + "/issues/" + issueId + "/subscribers",
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
        "/workspaces/" + workspaceId + "/issues/" + issueId + "/subscribers",
        { token }
      ),
      env
    );
    expect(list.status).toBe(200);
    const body = await list.json<{ subscribers: unknown[] }>();
    expect(body.subscribers).toHaveLength(1);
  });

  it("records issue history on create and update", async () => {
    const workspaceId = await seedWorkspace();
    const token = await adminToken(workspaceId);

    const create = await app.fetch(
      request("/workspaces/" + workspaceId + "/issues", {
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
      request("/workspaces/" + workspaceId + "/issues/" + issue.id, {
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
        "/workspaces/" + workspaceId + "/issues/" + issue.id + "/history",
        { token }
      ),
      env
    );
    expect(historyRes.status).toBe(200);
    const historyBody = await historyRes.json<{ history: unknown[] }>();
    expect(historyBody.history.length).toBeGreaterThanOrEqual(1);
  });

  it("manages webhook subscriptions", async () => {
    const workspaceId = await seedWorkspace();
    const token = await adminToken(workspaceId);
    const url = "http://127.0.0.1:1/webhook";

    const createRes = await app.fetch(
      request(`/workspaces/${workspaceId}/webhook-subscriptions`, {
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
      request(`/workspaces/${workspaceId}/webhook-subscriptions`, { token }),
      env
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json<{ subscriptions: unknown[] }>();
    expect(list.subscriptions.length).toBe(1);

    const deliveriesRes = await app.fetch(
      request(
        `/workspaces/${workspaceId}/webhook-subscriptions/${sub.id}/deliveries`,
        { token }
      ),
      env
    );
    expect(deliveriesRes.status).toBe(200);
    const deliveries = await deliveriesRes.json<{ deliveries: unknown[] }>();
    expect(Array.isArray(deliveries.deliveries)).toBe(true);

    const deleteRes = await app.fetch(
      request(`/workspaces/${workspaceId}/webhook-subscriptions/${sub.id}`, {
        method: "DELETE",
        token,
      }),
      env
    );
    expect(deleteRes.status).toBe(204);
  });

  it("searches issues by title, description, identifier and comments", async () => {
    const workspaceId = await seedWorkspace();
    const token = await adminToken(workspaceId);

    const issueA = await app.fetch(
      request(`/workspaces/${workspaceId}/issues`, {
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
      request(`/workspaces/${workspaceId}/issues`, {
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
      request(`/workspaces/${workspaceId}/issues/${issueAData.id}/comments`, {
        method: "POST",
        token,
        body: JSON.stringify({ body: "epsilon comment body" }),
      }),
      env
    );

    const byTitle = await app.fetch(
      request(`/workspaces/${workspaceId}/issues?search=Unique+alpha`, {
        token,
      }),
      env
    );
    expect(byTitle.status).toBe(200);
    const byTitleBody = await byTitle.json<{ issues: unknown[] }>();
    expect(byTitleBody.issues.length).toBe(1);

    const byDescription = await app.fetch(
      request(`/workspaces/${workspaceId}/issues?search=gamma`, { token }),
      env
    );
    expect(byDescription.status).toBe(200);
    const byDescriptionBody = await byDescription.json<{ issues: unknown[] }>();
    expect(byDescriptionBody.issues.length).toBe(1);

    const byIdentifier = await app.fetch(
      request(
        `/workspaces/${workspaceId}/issues?search=${issueAData.identifier}`,
        { token }
      ),
      env
    );
    expect(byIdentifier.status).toBe(200);
    const byIdentifierBody = await byIdentifier.json<{ issues: unknown[] }>();
    expect(byIdentifierBody.issues.length).toBe(1);

    const byComment = await app.fetch(
      request(`/workspaces/${workspaceId}/issues?search=epsilon`, { token }),
      env
    );
    expect(byComment.status).toBe(200);
    const byCommentBody = await byComment.json<{ issues: unknown[] }>();
    expect(byCommentBody.issues.length).toBe(1);
  });

  it("creates saved views and applies them to issue lists", async () => {
    const workspaceId = await seedWorkspace();
    const token = await adminToken(workspaceId);

    const todoIssue = await app.fetch(
      request(`/workspaces/${workspaceId}/issues`, {
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
      request(`/workspaces/${workspaceId}/issues`, {
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
      request(`/workspaces/${workspaceId}/saved-views`, {
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
      request(`/workspaces/${workspaceId}/issues?view=${view.id}`, { token }),
      env
    );
    expect(apply.status).toBe(200);
    const applyBody = await apply.json<{ issues: unknown[] }>();
    expect(applyBody.issues.length).toBe(1);
  });

  it("creates notifications on issue creation and lists them", async () => {
    const db = createD1(env.D1);
    const workspaceId = await seedWorkspace();
    const tokenRecord = await createAdminTokenRecord(workspaceId);
    const token = tokenRecord.token;

    const userId = crypto.randomUUID();
    const ts = new Date().toISOString();
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
    await db.insert(workspaceMemberships).values({
      id: crypto.randomUUID(),
      workspaceId,
      userId,
      role: "member",
      createdAt: ts,
    });

    const issue = await app.fetch(
      request(`/workspaces/${workspaceId}/issues`, {
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

    const userNotes = await getNotificationsForRecipient(
      db,
      workspaceId,
      userId,
      "user"
    );
    expect(userNotes.length).toBeGreaterThanOrEqual(1);
    expect(userNotes[0].type).toBe("issue_created");
    expect(userNotes[0].issueId).toBe(issueData.id);

    await createNotification(db, {
      workspaceId,
      recipientId: tokenRecord.id,
      recipientType: "agent",
      issueId: issueData.id,
      type: "issue_created",
    });

    const list = await app.fetch(
      request(`/workspaces/${workspaceId}/notifications`, { token }),
      env
    );
    expect(list.status).toBe(200);
    const listBody = await list.json<{ notifications: unknown[] }>();
    expect(listBody.notifications.length).toBe(1);

    const count = await app.fetch(
      request(`/workspaces/${workspaceId}/notifications/unread-count`, {
        token,
      }),
      env
    );
    expect(count.status).toBe(200);
    const countBody = await count.json<{ count: number }>();
    expect(countBody.count).toBe(1);

    const noteId = (listBody.notifications[0] as { id: string }).id;
    const mark = await app.fetch(
      request(`/workspaces/${workspaceId}/notifications/${noteId}/read`, {
        method: "PATCH",
        token,
      }),
      env
    );
    expect(mark.status).toBe(200);
    const markBody = await mark.json<{ read: boolean }>();
    expect(markBody.read).toBe(true);

    const markAll = await app.fetch(
      request(`/workspaces/${workspaceId}/notifications/mark-all-read`, {
        method: "POST",
        token,
      }),
      env
    );
    expect(markAll.status).toBe(204);
  });
});
