import { env, runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { WorkerEnv } from "../platform/middleware.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { createD1 } from "./db.js";
import { member, organization, user as userTable } from "./schema.js";
import { createDefaultTeam } from "./teams.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

const WORKSPACE_ID = `agent-session-test-${crypto.randomUUID()}`;

function getStub() {
  const id = env.WORKSPACE_DURABLE_OBJECT.idFromName(WORKSPACE_ID);
  return env.WORKSPACE_DURABLE_OBJECT.get(id);
}

async function withWorkspace<T>(
  callback: (instance: WorkspaceDO) => T | Promise<T>
): Promise<T> {
  const stub = getStub();
  return runInDurableObject(stub, async (instance) => {
    await instance.setOrganizationId(WORKSPACE_ID);
    return callback(instance);
  });
}

describe("agent sessions", () => {
  beforeAll(async () => {
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
    await db
      .insert(organization)
      .values({
        id: WORKSPACE_ID,
        name: "Agent session tests",
        slug: WORKSPACE_ID,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await db
      .insert(member)
      .values({
        id: crypto.randomUUID(),
        organizationId: WORKSPACE_ID,
        userId: "user-1",
        role: "owner",
        createdAt: now,
      })
      .onConflictDoNothing();
    const existing = await db
      .select()
      .from(organization)
      .where(eq(organization.id, WORKSPACE_ID))
      .get();
    if (existing) {
      await createDefaultTeam(db, WORKSPACE_ID, "AST", "user-1");
    }
  });

  it("creates and retrieves a session", async () => {
    const session = await withWorkspace((instance) =>
      instance.createAgentSession({
        issueId: "issue-1",
        agentId: "devin",
        provider: "devin",
        actorId: "user-1",
        actorType: "user",
      })
    );

    expect(session.organizationId).toBe(WORKSPACE_ID);
    expect(session.issueId).toBe("issue-1");
    expect(session.status).toBe("created");

    const found = await withWorkspace((instance) =>
      instance.getAgentSession(session.id)
    );
    expect(found).not.toBeNull();
    expect(found?.id).toBe(session.id);
  });

  it("lists sessions and updates status", async () => {
    const session = await withWorkspace((instance) =>
      instance.createAgentSession({
        issueId: "issue-2",
        agentId: "devin",
        provider: "devin",
        actorId: "user-1",
        actorType: "user",
      })
    );
    const listed = await withWorkspace((instance) =>
      instance.listAgentSessions({ issueId: "issue-2" })
    );
    expect(listed.map((row) => row.id)).toContain(session.id);

    const updated = await withWorkspace((instance) =>
      instance.updateAgentSession(session.id, { status: "completed" })
    );
    expect(updated?.status).toBe("completed");
  });

  it("records activities and returns session with activities", async () => {
    const session = await withWorkspace((instance) =>
      instance.createAgentSession({
        issueId: "issue-3",
        agentId: "devin",
        provider: "devin",
        actorId: "user-1",
        actorType: "user",
      })
    );
    await withWorkspace((instance) =>
      instance.addAgentActivity({
        sessionId: session.id,
        type: "thought",
        message: "thinking",
      })
    );
    const full = await withWorkspace((instance) =>
      instance.getAgentSessionWithActivities(session.id)
    );
    expect(full?.activities).toHaveLength(1);
    expect(full?.activities[0]?.message).toBe("thinking");
  });
});
