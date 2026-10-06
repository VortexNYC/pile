import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createAdminHeaders } from "../platform/test-auth.js";
import { createD1 } from "./db.js";
import { organization, team, user as userTable } from "./schema.js";
import {
  createTeam,
  getDefaultTeam,
  getTeamById,
  listTeams,
  setDefaultTeam,
} from "./teams.js";
import { createWorkspace } from "./workspaces.js";

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

describe("setDefaultTeam", () => {
  it("makes exactly one team default and mirrors it into org metadata", async () => {
    const { db, organizationId } = await seedWorkspace("user-default-team");
    const eng = await createTeam(db, env, new Headers(), {
      organizationId,
      key: "eng",
      name: "Eng",
      ownerId: "user-default-team",
      triageAssigneeId: "triager",
      defaultRepo: "VortexNYC/pile",
    });

    const result = await setDefaultTeam(db, organizationId, eng.id);
    expect(result?.isDefault).toBe(true);
    expect(result?.triageAssigneeId).toBe("triager");
    expect(result?.defaultRepo).toBe("VortexNYC/pile");
    expect(result?.key).toBe("eng");

    const defaults = (await listTeams(db, organizationId)).filter(
      (t) => t.isDefault
    );
    expect(defaults.map((t) => t.id)).toEqual([eng.id]);
    expect((await getDefaultTeam(db, organizationId))?.id).toBe(eng.id);

    const org = await db
      .select({ metadata: organization.metadata })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .get();
    const meta = JSON.parse(org?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta.defaultTeamId).toBe(eng.id);
    expect(meta.key).toBe("WS");
    expect(meta.extra).toBe("keep");
  });

  it("ignores teams from another workspace", async () => {
    const a = await seedWorkspace("user-default-team-a");
    const b = await seedWorkspace("user-default-team-b");
    const foreign = await createTeam(b.db, env, new Headers(), {
      organizationId: b.organizationId,
      key: "foreign",
      name: "Foreign",
      ownerId: "user-default-team-b",
    });
    expect(
      await setDefaultTeam(a.db, a.organizationId, foreign.id)
    ).toBeUndefined();
    expect(
      (await getTeamById(b.db, foreign.id, b.organizationId))?.isDefault
    ).toBe(false);
  });

  it("flags a target whose stored metadata is invalid", async () => {
    const { db, organizationId } = await seedWorkspace("user-default-bad");
    const legacy = await createTeam(db, env, new Headers(), {
      organizationId,
      key: "legacy",
      name: "Legacy",
      ownerId: "user-default-bad",
    });
    await db
      .update(team)
      .set({ metadata: "not json" })
      .where(eq(team.id, legacy.id));

    const result = await setDefaultTeam(db, organizationId, legacy.id);
    expect(result?.isDefault).toBe(true);
    expect((await getDefaultTeam(db, organizationId))?.id).toBe(legacy.id);
    expect(
      (await listTeams(db, organizationId)).filter((t) => t.isDefault)
    ).toHaveLength(1);
  });

  it("flags a target whose stored metadata is valid JSON but not an object", async () => {
    const { db, organizationId } = await seedWorkspace("user-default-array");
    const legacy = await createTeam(db, env, new Headers(), {
      organizationId,
      key: "legacy",
      name: "Legacy",
      ownerId: "user-default-array",
    });
    // parseTeamMetadata schema-validates, so non-object JSON falls into the
    // whole-metadata rewrite path — not a mid-batch json_set error.
    await db
      .update(team)
      .set({ metadata: '["not","an","object"]' })
      .where(eq(team.id, legacy.id));

    const result = await setDefaultTeam(db, organizationId, legacy.id);
    expect(result?.isDefault).toBe(true);
    expect((await getDefaultTeam(db, organizationId))?.id).toBe(legacy.id);
  });
});
