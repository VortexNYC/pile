import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
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
    ownerId: "user-1",
  });
  return workspace!.id;
}

async function adminToken(workspaceId: string) {
  const db = createD1(env.D1);
  const token = await createWorkspaceToken(
    db,
    workspaceId,
    "test-admin",
    "admin",
    env.TOKEN_HASH_SECRET
  );
  return token.token;
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
    const body = await res.json();
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
    const state = await create.json();
    expect(state.name).toBe("Todo");

    const list = await app.fetch(
      request("/workspaces/" + workspaceId + "/states", { token }),
      env
    );
    expect(list.status).toBe(200);
    const listBody = await list.json();
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
    const updated = await patch.json();
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
    const created = await create.json();
    expect(created.name).toBe("ci");

    const list = await app.fetch(
      request("/workspaces/" + workspaceId + "/tokens", { token }),
      env
    );
    expect(list.status).toBe(200);
    const listBody = await list.json();
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
    const membership = await create.json();
    expect(membership.userId).toBe("user-1");

    const list = await app.fetch(
      request("/workspaces/" + workspaceId + "/memberships", { token }),
      env
    );
    expect(list.status).toBe(200);
    const listBody = await list.json();
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
    const user = await create.json();
    expect(user.linearId).toBe("linear-user-1");

    const get = await app.fetch(
      request("/workspaces/" + workspaceId + "/linear-users/" + user.linearId, {
        token,
      }),
      env
    );
    expect(get.status).toBe(200);
    const got = await get.json();
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
    const body = await list.json();
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
    const issue = await create.json();

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
    const historyBody = await historyRes.json();
    expect(historyBody.history.length).toBeGreaterThanOrEqual(1);
  });
});
