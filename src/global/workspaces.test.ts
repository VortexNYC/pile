import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createAdminHeaders } from "../platform/test-auth.js";
import { createD1 } from "./db.js";
import { organization, user as userTable } from "./schema.js";
import { createTeam, setDefaultTeam } from "./teams.js";
import { createWorkspace, getWorkspaceById } from "./workspaces.js";

async function seedWorkspace(userId: string) {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: userId,
      name: userId,
      email: `${userId}@example.com`,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const workspace = await createWorkspace(
    db,
    env,
    await createAdminHeaders(env, userId),
    {
      name: userId,
      slug: `${userId}-${crypto.randomUUID()}`,
      key: "WS",
      ownerId: userId,
    }
  );
  await db
    .update(organization)
    .set({ metadata: JSON.stringify({ key: "WS", extra: "keep" }) })
    .where(eq(organization.id, workspace.id));
  return { db, organizationId: workspace.id };
}

describe("workspace defaultTeamId", () => {
  it("reflects the team chosen by setDefaultTeam", async () => {
    const { db, organizationId } = await seedWorkspace("user-ws-default");
    const ops = await createTeam(db, env, new Headers(), {
      organizationId,
      key: "ops",
      name: "Ops",
      ownerId: "user-ws-default",
    });
    await setDefaultTeam(db, organizationId, ops.id);
    const workspace = await getWorkspaceById(db, organizationId);
    expect(workspace?.defaultTeamId).toBe(ops.id);
    expect(workspace?.key).toBe("WS");
  });

  it("is null when the org metadata has no default team", async () => {
    const { db, organizationId } = await seedWorkspace("user-ws-nodefault");
    await db
      .update(organization)
      .set({ metadata: JSON.stringify({ key: "WS" }) })
      .where(eq(organization.id, organizationId));
    expect((await getWorkspaceById(db, organizationId))?.defaultTeamId).toBe(
      null
    );
  });
});
