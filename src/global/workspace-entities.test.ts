import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createD1 } from "./db.js";
import {
  member,
  organization,
  team,
  teamMember,
  user as userTable,
} from "./schema.js";
import {
  deleteMembership,
  updateMembershipRole,
} from "./workspace-entities.js";

async function seedMembers(
  organizationId: string,
  members: Array<{ id: string; userId: string; role: string }>
) {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(organization)
    .values({
      id: organizationId,
      name: organizationId,
      slug: organizationId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  for (const m of members) {
    await db
      .insert(userTable)
      .values({
        id: m.userId,
        name: m.userId,
        email: `${m.userId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    await db.insert(member).values({
      id: m.id,
      organizationId,
      userId: m.userId,
      role: m.role,
      createdAt: now,
    });
  }
  return db;
}

describe("updateMembershipRole / deleteMembership (PILE-623)", () => {
  it("updates a member role and returns null for unknown ids", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const m1 = `m-${crypto.randomUUID()}`;
    const db = await seedMembers(orgId, [
      { id: m1, userId: `u-${crypto.randomUUID()}`, role: "member" },
      {
        id: `m-${crypto.randomUUID()}`,
        userId: `u-${crypto.randomUUID()}`,
        role: "owner",
      },
    ]);
    const updated = await updateMembershipRole(db, orgId, m1, "admin");
    expect(updated?.role).toBe("admin");
    expect(await updateMembershipRole(db, orgId, "nope", "admin")).toBeNull();
  });

  it("refuses to downgrade the last owner but allows it with a second owner", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const own1 = `m-${crypto.randomUUID()}`;
    const own2 = `m-${crypto.randomUUID()}`;
    const db = await seedMembers(orgId, [
      { id: own1, userId: `u-${crypto.randomUUID()}`, role: "owner" },
      { id: own2, userId: `u-${crypto.randomUUID()}`, role: "owner" },
    ]);
    // Two owners: demoting one is fine.
    const demoted = await updateMembershipRole(db, orgId, own1, "admin");
    expect(demoted?.role).toBe("admin");
    // Now only one owner remains — the last-owner guard fires.
    await expect(
      updateMembershipRole(db, orgId, own2, "member")
    ).rejects.toThrow("Cannot downgrade the last workspace owner");
    await expect(deleteMembership(db, orgId, own2)).rejects.toThrow(
      "Cannot remove the last workspace owner"
    );
  });

  it("deletes a member and cascades its org team_member rows", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const otherOrg = `org-${crypto.randomUUID()}`;
    const m1 = `m-${crypto.randomUUID()}`;
    const u1 = `u-${crypto.randomUUID()}`;
    const db = await seedMembers(orgId, [
      { id: m1, userId: u1, role: "member" },
      {
        id: `m-${crypto.randomUUID()}`,
        userId: `u-${crypto.randomUUID()}`,
        role: "owner",
      },
    ]);
    await db.insert(organization).values({
      id: otherOrg,
      name: otherOrg,
      slug: otherOrg,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const tOrg = `t-${crypto.randomUUID()}`;
    const tOther = `t-${crypto.randomUUID()}`;
    await db.insert(team).values({
      id: tOrg,
      name: "Org team",
      organizationId: orgId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(team).values({
      id: tOther,
      name: "Other team",
      organizationId: otherOrg,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const tm2 = `tm-${crypto.randomUUID()}`;
    await db.insert(teamMember).values([
      {
        id: `tm-${crypto.randomUUID()}`,
        teamId: tOrg,
        userId: u1,
        role: "member",
      },
      { id: tm2, teamId: tOther, userId: u1, role: "member" },
    ]);
    const res = await deleteMembership(db, orgId, m1);
    expect(res).toEqual({ deleted: true, userId: u1 });
    expect(
      await db.select().from(member).where(eq(member.id, m1)).get()
    ).toBeUndefined();
    // Org-scoped team row removed; the other org's row is untouched.
    const tmRows = await db
      .select({ id: teamMember.id })
      .from(teamMember)
      .where(eq(teamMember.userId, u1))
      .all();
    expect(tmRows.map((r) => r.id)).toEqual([tm2]);
    expect(await deleteMembership(db, orgId, m1)).toEqual({
      deleted: false,
      userId: null,
    });
  });
});
