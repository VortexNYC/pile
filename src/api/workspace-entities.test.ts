import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import {
  labels,
  member,
  states,
  team,
  teamMember,
  user as userTable,
} from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

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

async function seed(extraMembers: Array<{ userId: string; role: string }>) {
  const db = createD1(env.D1);
  const auth = await createAuth(env);
  const ownerId = `user-${crypto.randomUUID()}`;
  const now = new Date();
  const allUsers = [
    { id: ownerId, email: `${ownerId}@example.com` },
    ...extraMembers.map((m) => ({
      id: m.userId,
      email: `${m.userId}@example.com`,
    })),
  ];
  for (const u of allUsers) {
    await db
      .insert(userTable)
      .values({
        id: u.id,
        name: u.id,
        email: u.email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
  }
  const setupHeaders = await createAdminHeaders(env, ownerId);
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Memberships test",
    slug: `members-${crypto.randomUUID()}`,
    key: `M${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId,
  });
  if (!workspace) throw new Error("workspace not created");

  const membershipIds: Record<string, string> = {};
  for (const m of extraMembers) {
    const membershipId = `mem-${crypto.randomUUID()}`;
    await db.insert(member).values({
      id: membershipId,
      organizationId: workspace.id,
      userId: m.userId,
      role: m.role,
      createdAt: now,
    });
    membershipIds[m.userId] = membershipId;
  }

  const adminResult = await auth.api.createApiKey({
    body: {
      userId: ownerId,
      name: "test-admin",
      metadata: { organizationId: workspace.id, permissions: "admin" },
      permissions: { workspace: ["admin"] },
    },
  });
  const adminParsed = z.object({ key: z.string() }).parse(adminResult);
  return {
    db,
    organizationId: workspace.id,
    adminToken: adminParsed.key,
    ownerId,
    membershipIds,
  };
}

describe("membership retirement endpoints (PILE-623)", () => {
  it("PATCHes a member role and returns 404 for unknown ids", async () => {
    const memberUser = `user-${crypto.randomUUID()}`;
    const { organizationId, adminToken, membershipIds } = await seed([
      { userId: memberUser, role: "member" },
    ]);
    const res = await fetch(
      `/workspaces/${organizationId}/memberships/${membershipIds[memberUser]}`,
      { method: "PATCH", body: JSON.stringify({ role: "admin" }) },
      adminToken
    );
    expect(res.status).toBe(200);
    const body = z.object({ role: z.string() }).parse(await res.json());
    expect(body.role).toBe("admin");

    const missing = await fetch(
      `/workspaces/${organizationId}/memberships/does-not-exist`,
      { method: "PATCH", body: JSON.stringify({ role: "admin" }) },
      adminToken
    );
    expect(missing.status).toBe(404);
  });

  it("refuses to downgrade the last workspace owner", async () => {
    const { db, organizationId, adminToken, ownerId } = await seed([]);
    const ownerRow = await db
      .select()
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, ownerId)
        )
      )
      .get();
    const res = await fetch(
      `/workspaces/${organizationId}/memberships/${ownerRow!.id}`,
      { method: "PATCH", body: JSON.stringify({ role: "member" }) },
      adminToken
    );
    expect(res.status).toBe(400);
  });

  it("DELETE removes the member and cascades team_member rows", async () => {
    const agentUser = `user-${crypto.randomUUID()}`;
    const { db, organizationId, adminToken, membershipIds } = await seed([
      { userId: agentUser, role: "member" },
    ]);
    // Simulate an install on the org's default team — the cascade only
    // touches team_member rows for teams owned by this workspace.
    const memberId = membershipIds[agentUser]!;
    const defaultTeam = await db
      .select({ id: team.id })
      .from(team)
      .where(eq(team.organizationId, organizationId))
      .get();
    await db.insert(teamMember).values({
      id: `tm-${crypto.randomUUID()}`,
      teamId: defaultTeam!.id,
      userId: agentUser,
      role: "member",
      createdAt: new Date(),
    });
    const res = await fetch(
      `/workspaces/${organizationId}/memberships/${memberId}`,
      { method: "DELETE" },
      adminToken
    );
    expect(res.status).toBe(200);
    const body = z
      .object({ deleted: z.boolean(), id: z.string(), userId: z.string() })
      .parse(await res.json());
    expect(body.deleted).toBe(true);
    expect(body.userId).toBe(agentUser);
    const gone = await db
      .select()
      .from(member)
      .where(eq(member.id, memberId))
      .get();
    expect(gone).toBeUndefined();
    const orphanTeamRows = await db
      .select()
      .from(teamMember)
      .where(eq(teamMember.userId, agentUser))
      .all();
    expect(orphanTeamRows).toHaveLength(0);

    const missing = await fetch(
      `/workspaces/${organizationId}/memberships/${memberId}`,
      { method: "DELETE" },
      adminToken
    );
    expect(missing.status).toBe(404);
  });

  it("refuses to remove the last workspace owner", async () => {
    const { db, organizationId, adminToken, ownerId } = await seed([]);
    const ownerRow = await db
      .select()
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, ownerId)
        )
      )
      .get();
    const res = await fetch(
      `/workspaces/${organizationId}/memberships/${ownerRow!.id}`,
      { method: "DELETE" },
      adminToken
    );
    expect(res.status).toBe(400);
  });
});

describe("legacy timestamp normalization (VTX-751)", () => {
  it("returns ISO-8601 timestamps for SQLite-format states and labels", async () => {
    const { db, organizationId, adminToken } = await seed([]);
    // Rows written before the API normalized timestamps carry SQLite's
    // CURRENT_TIMESTAMP shape ("YYYY-MM-DD HH:MM:SS", no timezone).
    const legacy = "2026-09-07 20:14:42";
    await db.insert(states).values({
      id: `st-${crypto.randomUUID()}`,
      organizationId,
      linearId: "legacy-todo",
      name: "Legacy Todo",
      type: "unstarted",
      createdAt: legacy,
    });
    const labelId = `lbl-${crypto.randomUUID()}`;
    await db.insert(labels).values({
      id: labelId,
      organizationId,
      name: "legacy-label",
      createdAt: legacy,
      updatedAt: legacy,
    });

    const statesRes = await fetch(
      `/workspaces/${organizationId}/states`,
      {},
      adminToken
    );
    expect(statesRes.status).toBe(200);
    const statesBody = z
      .object({ states: z.array(z.object({ createdAt: z.string() })) })
      .parse(await statesRes.json());
    for (const row of statesBody.states) {
      expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(row.createdAt.endsWith("Z")).toBe(true);
    }
    const legacyState = statesBody.states.find(
      (row) => row.createdAt === "2026-09-07T20:14:42.000Z"
    );
    expect(legacyState).toBeDefined();

    const labelsRes = await fetch(
      `/workspaces/${organizationId}/labels/${labelId}`,
      {},
      adminToken
    );
    expect(labelsRes.status).toBe(200);
    const labelBody = z
      .object({ createdAt: z.string(), updatedAt: z.string() })
      .parse(await labelsRes.json());
    expect(labelBody.createdAt).toBe("2026-09-07T20:14:42.000Z");
    expect(labelBody.updatedAt).toBe("2026-09-07T20:14:42.000Z");
  });
});
