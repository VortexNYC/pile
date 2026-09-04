import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import {
  createNotification,
  getNotificationsForRecipient,
} from "../global/notifications.js";
import { member as memberTable, user as userTable } from "../global/schema.js";
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
  return { id: parsed.id, token: parsed.key, referenceId: "user-1" };
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
    const listBody = await list.json<{ states: unknown[] }>();
    expect(listBody.states).toHaveLength(1);

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

    const userNotes = await getNotificationsForRecipient(
      db,
      organizationId,
      userId,
      "user"
    );
    expect(userNotes.length).toBeGreaterThanOrEqual(1);
    expect(userNotes[0].type).toBe("issue_created");
    expect(userNotes[0].issueId).toBe(issueData.id);

    await createNotification(db, {
      organizationId,
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

    const assigneeNotes = await getNotificationsForRecipient(
      db,
      organizationId,
      userId,
      "user"
    );
    const commentNotes = assigneeNotes.filter(
      (n) => n.type === "comment_created"
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
});
