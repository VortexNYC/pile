import { env, runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { member, organization, user as userTable } from "../global/schema.js";
import { createDefaultTeam, updateTeam } from "../global/teams.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import type { WorkspaceDO } from "./durable-object.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

const WORKSPACE_ID = "test-workspace";
let testHeaders: Headers;

async function ensureWorkspace() {
  const db = createD1(env.D1);
  const existing = await db
    .select()
    .from(organization)
    .where(eq(organization.id, WORKSPACE_ID))
    .get();
  if (existing) return;

  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-1",
      name: "Test",
      email: "user-1@test.local",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  await db.insert(organization).values({
    id: WORKSPACE_ID,
    name: "Test workspace",
    slug: "test-workspace",
    metadata: JSON.stringify({ key: "TEST" }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: WORKSPACE_ID,
    userId: "user-1",
    role: "owner",
    createdAt: now,
  });
  testHeaders = await createAdminHeaders(env, "user-1");
  await createDefaultTeam(db, env, testHeaders, WORKSPACE_ID, "TEST", "user-1");
}

function getStub() {
  const id = env.WORKSPACE_DURABLE_OBJECT.idFromName(WORKSPACE_ID);
  return env.WORKSPACE_DURABLE_OBJECT.get(id);
}

async function withWorkspace<T>(
  stub: ReturnType<typeof getStub>,
  callback: (instance: WorkspaceDO) => T | Promise<T>
): Promise<T> {
  return runInDurableObject(stub, async (instance) => {
    await instance.setOrganizationId(WORKSPACE_ID);
    return callback(instance);
  });
}

describe("WorkspaceDO", () => {
  beforeAll(ensureWorkspace);

  it("creates and lists issues", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Test issue" })
    );
    expect(issue.title).toBe("Test issue");
    expect(issue.status).toBe("backlog");
    expect(issue.priority).toBe("medium");
    expect(issue.resolution).toBeNull();
    expect(issue.parentId).toBeNull();
    expect(issue.subIssueSortOrder).toBeNull();

    const issues = await withWorkspace(stub, (instance) =>
      instance.listIssues()
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].id).toBe(issue.id);
  });

  it("supports triage status and resolution semantics", async () => {
    const stub = getStub();
    const triage = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Triage me", status: "triage" })
    );
    expect(triage.status).toBe("triage");
    expect(triage.resolution).toBeNull();

    const closed = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Done issue",
        status: "done",
        resolution: "resolved",
      })
    );
    expect(closed.status).toBe("done");
    expect(closed.resolution).toBe("resolved");

    await expect(
      withWorkspace(stub, (instance) =>
        instance.createIssue({
          title: "Bad resolution",
          status: "todo",
          resolution: "not_planned",
        })
      )
    ).rejects.toThrow();
  });

  it("clears and validates resolution on status change", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Resolve then reopen",
        status: "canceled",
        resolution: "not_planned",
      })
    );
    expect(issue.resolution).toBe("not_planned");

    const reopened = await withWorkspace(stub, (instance) =>
      instance.updateIssue(issue.id, { status: "todo" })
    );
    expect(reopened?.status).toBe("todo");
    expect(reopened?.resolution).toBeNull();

    const resolved = await withWorkspace(stub, (instance) =>
      instance.updateIssue(issue.id, {
        status: "done",
        resolution: "resolved",
      })
    );
    expect(resolved?.status).toBe("done");
    expect(resolved?.resolution).toBe("resolved");

    await expect(
      withWorkspace(stub, (instance) =>
        instance.updateIssue(issue.id, {
          status: "in_progress",
          resolution: "obsolete",
        })
      )
    ).rejects.toThrow();
  });

  it("gets an issue by id", async () => {
    const stub = getStub();
    const created = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Get me" })
    );
    const got = await withWorkspace(stub, (instance) =>
      instance.getIssue(created.id)
    );
    expect(got?.id).toBe(created.id);
  });

  it("updates an issue", async () => {
    const stub = getStub();
    const created = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Update me" })
    );
    const updated = await withWorkspace(stub, (instance) =>
      instance.updateIssue(created.id, {
        title: "Updated",
        status: "in_progress",
      })
    );
    expect(updated?.title).toBe("Updated");
    expect(updated?.status).toBe("in_progress");
  });

  it("updates PR state", async () => {
    const stub = getStub();
    await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "PR issue",
        repo: "owner/repo",
        branch: "feature",
      })
    );
    const updated = await withWorkspace(stub, (instance) =>
      instance.updatePrState(
        "owner/repo",
        "feature",
        "https://github.com/owner/repo/pull/1",
        "open"
      )
    );
    expect(updated?.prUrl).toBe("https://github.com/owner/repo/pull/1");
    expect(updated?.prState).toBe("open");
  });

  it("rejects two issues with the same repo and branch", async () => {
    const stub = getStub();
    await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "First",
        repo: "owner/collision",
        branch: "collision-branch",
      })
    );
    await expect(
      withWorkspace(stub, (instance) =>
        instance.createIssue({
          title: "Second",
          repo: "owner/collision",
          branch: "collision-branch",
        })
      )
    ).rejects.toThrow();
  });

  it("supports parent/child issue hierarchy", async () => {
    const stub = getStub();
    const parent = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Parent issue" })
    );
    const child = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Child issue", parentId: parent.id })
    );
    expect(child.parentId).toBe(parent.id);
    expect(child.priority).toBe(parent.priority);

    const children = await withWorkspace(stub, (instance) =>
      instance.getIssueChildren(parent.id)
    );
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe(child.id);

    await expect(
      withWorkspace(stub, (instance) =>
        instance.updateIssue(parent.id, { parentId: child.id })
      )
    ).rejects.toThrow();

    const removed = await withWorkspace(stub, (instance) =>
      instance.updateIssue(child.id, { parentId: null })
    );
    expect(removed?.parentId).toBeNull();
  });

  it("filters issues by hasParent and isParent", async () => {
    const stub = getStub();
    const parent = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Filter parent" })
    );
    await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Filter child", parentId: parent.id })
    );

    const withParent = await withWorkspace(stub, (instance) =>
      instance.listIssues({ hasParent: true })
    );
    expect(withParent.every((issue) => issue.parentId !== null)).toBe(true);

    const withoutParent = await withWorkspace(stub, (instance) =>
      instance.listIssues({ hasParent: false })
    );
    expect(withoutParent.some((issue) => issue.parentId !== null)).toBe(false);

    const parents = await withWorkspace(stub, (instance) =>
      instance.listIssues({ isParent: true })
    );
    expect(parents.length).toBeGreaterThan(0);
    expect(parents.some((issue) => issue.id === parent.id)).toBe(true);

    const nonParents = await withWorkspace(stub, (instance) =>
      instance.listIssues({ isParent: false })
    );
    expect(nonParents.some((issue) => issue.id === parent.id)).toBe(false);
  });

  it("auto-closes sub-issues when parent is done and setting is enabled", async () => {
    const stub = getStub();
    const db = createD1(env.D1);
    const team = await createDefaultTeam(
      db,
      env,
      testHeaders,
      WORKSPACE_ID,
      "AUTO",
      "user-1"
    );
    await updateTeam(db, env, testHeaders, team.id, WORKSPACE_ID, {
      subIssueAutoClose: true,
    });

    const parent = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Auto parent", teamId: team.id })
    );
    const child = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Auto child",
        teamId: team.id,
        parentId: parent.id,
      })
    );

    await withWorkspace(stub, (instance) =>
      instance.updateIssue(parent.id, { status: "done" })
    );

    const updatedChild = await withWorkspace(stub, (instance) =>
      instance.getIssue(child.id)
    );
    expect(updatedChild?.status).toBe("done");
    expect(updatedChild?.resolution).toBe("resolved");
  });

  it("auto-closes parent when all sub-issues are done and setting is enabled", async () => {
    const stub = getStub();
    const db = createD1(env.D1);
    const team = await createDefaultTeam(
      db,
      env,
      testHeaders,
      WORKSPACE_ID,
      "AUTO2",
      "user-1"
    );
    await updateTeam(db, env, testHeaders, team.id, WORKSPACE_ID, {
      parentAutoClose: true,
    });

    const parent = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Auto parent 2", teamId: team.id })
    );
    const child1 = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Auto child 1",
        teamId: team.id,
        parentId: parent.id,
      })
    );
    const child2 = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Auto child 2",
        teamId: team.id,
        parentId: parent.id,
      })
    );

    await withWorkspace(stub, (instance) =>
      instance.updateIssue(child1.id, { status: "done" })
    );
    let updatedParent = await withWorkspace(stub, (instance) =>
      instance.getIssue(parent.id)
    );
    expect(updatedParent?.status).toBe("backlog");

    await withWorkspace(stub, (instance) =>
      instance.updateIssue(child2.id, { status: "done" })
    );
    updatedParent = await withWorkspace(stub, (instance) =>
      instance.getIssue(parent.id)
    );
    expect(updatedParent?.status).toBe("done");
    expect(updatedParent?.resolution).toBe("resolved");
  });

  it("enforces Linear two-level sub-issue depth", async () => {
    const stub = getStub();
    const parent = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Depth parent" })
    );
    const child = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Depth child", parentId: parent.id })
    );
    await expect(
      withWorkspace(stub, (instance) =>
        instance.createIssue({ title: "Grandchild", parentId: child.id })
      )
    ).rejects.toThrow(/one level/);
  });

  it("supports estimate, drafts, and snoozed filtering", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Estimated draft",
        estimate: 5,
        isDraft: true,
      })
    );
    expect(issue.estimate).toBe(5);
    expect(issue.isDraft).toBe(true);

    const drafts = await withWorkspace(stub, (instance) =>
      instance.listIssues({ isDraft: true })
    );
    expect(drafts.some((i) => i.id === issue.id)).toBe(true);
    const nonDrafts = await withWorkspace(stub, (instance) =>
      instance.listIssues({ isDraft: false })
    );
    expect(nonDrafts.some((i) => i.id === issue.id)).toBe(false);

    const snoozed = await withWorkspace(stub, (instance) =>
      instance.updateIssue(issue.id, {
        snoozedUntil: new Date(Date.now() + 86400000).toISOString(),
      })
    );
    expect(snoozed?.snoozedUntil).toBeTruthy();

    // Default lists keep snoozed issues visible; triage-style lists hide them.
    const visible = await withWorkspace(stub, (instance) =>
      instance.listIssues({ isDraft: true })
    );
    expect(visible.some((i) => i.id === issue.id)).toBe(true);
    const hidden = await withWorkspace(stub, (instance) =>
      instance.listIssues({ isDraft: true, hideSnoozed: true })
    );
    expect(hidden.some((i) => i.id === issue.id)).toBe(false);
  });

  it("auto-assigns triage issues to the team triage owner", async () => {
    const stub = getStub();
    const db = createD1(env.D1);
    const team = await createDefaultTeam(
      db,
      env,
      testHeaders,
      WORKSPACE_ID,
      "TRI",
      "user-1"
    );
    await updateTeam(db, env, testHeaders, team.id, WORKSPACE_ID, {
      triageAssigneeId: "user-1",
    });
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Triage me",
        teamId: team.id,
        status: "triage",
      })
    );
    expect(issue.assigneeId).toBe("user-1");
  });

  it("rolls unfinished issues to the next cycle and reports capacity", async () => {
    const stub = getStub();
    const db = createD1(env.D1);
    const { createCycle } = await import("../global/workspace-entities.js");
    const past = new Date(Date.now() - 86400000 * 7);
    const ended = await createCycle(db, WORKSPACE_ID, {
      name: "Ended",
      startDate: new Date(past.getTime() - 86400000 * 7).toISOString(),
      endDate: past.toISOString(),
    });
    const next = await createCycle(db, WORKSPACE_ID, {
      name: "Next",
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + 86400000 * 7).toISOString(),
    });
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Carry over", cycleId: ended?.id ?? "" })
    );
    const done = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Done in cycle",
        cycleId: ended?.id ?? "",
        status: "done",
      })
    );

    const result = await withWorkspace(stub, (instance) =>
      instance.rolloverCycles()
    );
    expect(result.completedCycles).toContain(ended?.id);
    expect(result.rolledOver).toBeGreaterThanOrEqual(1);

    const moved = await withWorkspace(stub, (instance) =>
      instance.getIssue(issue.id)
    );
    expect(moved?.cycleId).toBe(next?.id);
    const stayed = await withWorkspace(stub, (instance) =>
      instance.getIssue(done.id)
    );
    expect(stayed?.cycleId).toBe(ended?.id);

    const capacity = await withWorkspace(stub, (instance) =>
      instance.cycleCapacity(next?.id ?? "")
    );
    expect(capacity.issueCount).toBeGreaterThanOrEqual(1);

    const stats = await withWorkspace(stub, (instance) =>
      instance.issueStats("status")
    );
    expect(stats.length).toBeGreaterThan(0);
    expect(stats.reduce((sum, g) => sum + g.count, 0)).toBeGreaterThan(0);
  });

  it("returns the same issue for concurrent createIssue with the same id", async () => {
    const stub = getStub();
    await stub.setOrganizationId(WORKSPACE_ID);
    const id = `repo:github:vortexnyc:issuetracker:race`;
    const [a, b] = await Promise.all([
      stub.createIssue({ id, title: "Race A" }),
      stub.createIssue({ id, title: "Race B" }),
    ]);
    expect(a.id).toBe(id);
    expect(b.id).toBe(id);
    expect(a.id).toBe(b.id);
  });

  it("assigns distinct numbers for concurrent createIssue with different ids", async () => {
    const stub = getStub();
    await stub.setOrganizationId(WORKSPACE_ID);
    const [a, b] = await Promise.all([
      stub.createIssue({
        id: `repo:github:vortexnyc:issuetracker:${crypto.randomUUID()}`,
        title: "Concurrent A",
      }),
      stub.createIssue({
        id: `repo:github:vortexnyc:issuetracker:${crypto.randomUUID()}`,
        title: "Concurrent B",
      }),
    ]);
    expect(a.number).not.toBe(b.number);
    expect(a.identifier).not.toBe(b.identifier);
  });
});
