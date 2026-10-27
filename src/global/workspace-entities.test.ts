import { env } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createD1 } from "./db.js";
import {
  labels,
  member,
  organization,
  states,
  supportCustomers,
  supportTicketLabels,
  supportTickets,
  team,
  teamMember,
  user as userTable,
} from "./schema.js";
import {
  createLabel,
  createState,
  deleteMembership,
  listLabels,
  listStates,
  mergeDuplicateLabels,
  mergeDuplicateStates,
  updateLabel,
  updateMembershipRole,
  updateState,
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

describe("label/state dedupe (VTX-752)", () => {
  it("createLabel returns the existing row on a repeated (name, kind)", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const db = await seedMembers(orgId, []);
    const first = await createLabel(db, orgId, { name: "daytona" });
    const second = await createLabel(db, orgId, { name: "daytona" });
    expect(second?.id).toBe(first?.id);
    expect((await listLabels(db, orgId)).length).toBe(1);
    // kind participates in the uniqueness key — a support label of the
    // same name is a different row, not a collision.
    const support = await createLabel(db, orgId, {
      name: "daytona",
      kind: "support",
    });
    expect(support?.id).not.toBe(first?.id);
    expect((await listLabels(db, orgId)).length).toBe(2);
  });

  it("updateLabel rejects a rename onto an existing (name, kind)", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const db = await seedMembers(orgId, []);
    const a = await createLabel(db, orgId, { name: "a" });
    await createLabel(db, orgId, { name: "b" });
    await expect(
      updateLabel(db, orgId, a!.id, { name: "b" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("createState returns the existing row on a repeated name", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const db = await seedMembers(orgId, []);
    const first = await createState(db, orgId, {
      linearId: "lin-1",
      name: "Backlog",
      type: "backlog",
    });
    const second = await createState(db, orgId, {
      linearId: "lin-2",
      name: "Backlog",
      type: "backlog",
    });
    expect(second?.id).toBe(first?.id);
    expect((await listStates(db, orgId)).length).toBe(1);
    await expect(
      updateState(db, orgId, first!.id, { name: "Backlog" })
    ).resolves.toMatchObject({ id: first!.id });
    await createState(db, orgId, {
      linearId: "lin-3",
      name: "In Progress",
      type: "started",
    });
    await expect(
      updateState(db, orgId, first!.id, { name: "In Progress" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("mergeDuplicateLabels repoints ticket joins before deleting dups", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const db = await seedMembers(orgId, []);
    const ts = new Date().toISOString();
    // Raw inserts reproduce the pre-migration prod state — the unique
    // index already exists in the test database, so it comes down first
    // and goes back up at the end (exactly what the migration does).
    await db.run(sql`DROP INDEX IF EXISTS labels_unique_name_kind_idx`);
    await db.insert(labels).values([
      {
        id: "lbl-keep",
        organizationId: orgId,
        name: "daytona",
        kind: "issue",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "lbl-dup",
        organizationId: orgId,
        name: "daytona",
        kind: "issue",
        createdAt: "2026-02-01T00:00:00Z",
      },
      {
        id: "lbl-solo",
        organizationId: orgId,
        name: "other",
        kind: "issue",
        createdAt: ts,
      },
    ]);
    await db.insert(supportCustomers).values({
      id: "cust-1",
      organizationId: orgId,
      email: "c@example.com",
      createdAt: ts,
      updatedAt: ts,
    });
    await db.insert(supportTickets).values([
      {
        id: "t-1",
        organizationId: orgId,
        customerId: "cust-1",
        number: 1,
        title: "one",
        sourceChannel: "api",
        createdAt: ts,
        updatedAt: ts,
      },
      {
        id: "t-2",
        organizationId: orgId,
        customerId: "cust-1",
        number: 2,
        title: "two",
        sourceChannel: "api",
        createdAt: ts,
        updatedAt: ts,
      },
    ]);
    await db.insert(supportTicketLabels).values([
      { id: "j-1", ticketId: "t-1", labelId: "lbl-keep" },
      { id: "j-2", ticketId: "t-1", labelId: "lbl-dup" },
      { id: "j-3", ticketId: "t-2", labelId: "lbl-dup" },
    ]);
    const result = await mergeDuplicateLabels(db, orgId);
    expect(result.merged).toBe(1);
    expect(result.idMap["lbl-dup"]).toBe("lbl-keep");
    const joins = await db.select().from(supportTicketLabels).all();
    // j-2 collided with j-1 on (ticket, canonical) and was dropped; j-3
    // re-pointed.
    expect(joins.map((j) => j.labelId).toSorted()).toEqual([
      "lbl-keep",
      "lbl-keep",
    ]);
    expect(joins.map((j) => j.ticketId).toSorted()).toEqual(["t-1", "t-2"]);
    expect((await listLabels(db, orgId)).map((l) => l.id).toSorted()).toEqual([
      "lbl-keep",
      "lbl-solo",
    ]);
    // Idempotent — a second pass merges nothing.
    expect((await mergeDuplicateLabels(db, orgId)).merged).toBe(0);
    await db.run(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS labels_unique_name_kind_idx ON labels (organization_id, name, kind)`
    );
  });

  it("mergeDuplicateStates keeps the oldest row and deletes the rest", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const db = await seedMembers(orgId, []);
    await db.run(sql`DROP INDEX IF EXISTS states_unique_name_idx`);
    await db.insert(states).values([
      {
        id: "st-keep",
        organizationId: orgId,
        linearId: "l1",
        name: "Backlog",
        type: "backlog",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "st-dup",
        organizationId: orgId,
        linearId: "l2",
        name: "Backlog",
        type: "backlog",
        createdAt: "2026-02-01T00:00:00Z",
      },
    ]);
    const result = await mergeDuplicateStates(db, orgId);
    expect(result.merged).toBe(1);
    expect(result.idMap["st-dup"]).toBe("st-keep");
    expect((await listStates(db, orgId)).map((s) => s.id)).toEqual(["st-keep"]);
    await db.run(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS states_unique_name_idx ON states (organization_id, name)`
    );
  });
});

describe("legacy timestamp normalization (VTX-751)", () => {
  it("normalizes SQLite-format state timestamps to ISO-8601 UTC", async () => {
    const db = createD1(env.D1);
    const organizationId = `org-${crypto.randomUUID()}`;
    await db.insert(organization).values({
      id: organizationId,
      name: organizationId,
      slug: organizationId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(states).values({
      id: `st-${crypto.randomUUID()}`,
      organizationId,
      linearId: "legacy",
      name: "Legacy",
      type: "unstarted",
      createdAt: "2026-09-07 20:14:42",
    });
    const rows = await listStates(db, organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdAt).toBe("2026-09-07T20:14:42.000Z");
  });
});
