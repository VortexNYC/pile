import { env, runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import {
  githubUsers,
  member,
  organization,
  user as userTable,
} from "../global/schema.js";
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

  it("notifies a human assignee on create/update and resolves non-user assignee ids", async () => {
    const stub = getStub();
    // A GitHub-login assignee resolves to the mapped workspace user.
    const db = createD1(env.D1);
    await db.insert(githubUsers).values({
      id: crypto.randomUUID(),
      organizationId: WORKSPACE_ID,
      githubLogin: "gh-user-1",
      userId: "user-1",
    });

    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Login-assigned", assigneeId: "gh-user-1" })
    );

    const notes = await withWorkspace(stub, (instance) =>
      instance.listNotificationsForRecipient("user-1", "user")
    );
    const assigned = notes.filter(
      (n) => n.type === "issue_assigned" && n.issueId === issue.id
    );
    // The lane's actor is not a member (no actorId) — machine actors are
    // suppressed, so no issue_assigned on create here.
    expect(assigned).toHaveLength(0);

    // user-1 re-assigning to themselves (raw "user-1" → resolves to user-1;
    // the assignee value changes) stays silent — the self-assign skip.
    const selfAssign = await withWorkspace(stub, (instance) =>
      instance.updateIssue(issue.id, { assigneeId: "user-1" }, "user-1")
    );
    expect(selfAssign?.assigneeId).toBe("user-1");
    const after = await withWorkspace(stub, (instance) =>
      instance.listNotificationsForRecipient("user-1", "user")
    );
    expect(
      after.filter((n) => n.type === "issue_assigned" && n.issueId === issue.id)
    ).toHaveLength(0);

    // A different member assigning user-1 fires it.
    await db
      .insert(userTable)
      .values({
        id: "user-2",
        name: "Other",
        email: "user-2@test.local",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    await db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: WORKSPACE_ID,
      userId: "user-2",
      role: "member",
      createdAt: new Date(),
    });
    await withWorkspace(stub, (instance) =>
      instance.updateIssue(issue.id, { assigneeId: null }, "user-2")
    );
    await withWorkspace(stub, (instance) =>
      instance.updateIssue(issue.id, { assigneeId: "gh-user-1" }, "user-2")
    );
    const finalNotes = await withWorkspace(stub, (instance) =>
      instance.listNotificationsForRecipient("user-1", "user")
    );
    expect(
      finalNotes.filter(
        (n) => n.type === "issue_assigned" && n.issueId === issue.id
      )
    ).toHaveLength(1);
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

  it("rejects updateIssue with a teamId that does not exist", async () => {
    const stub = getStub();
    const created = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Bad team move" })
    );
    const err: unknown = await withWorkspace(stub, (instance) =>
      instance.updateIssue(created.id, { teamId: "nonexistent-team" })
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: unknown }).code).toBe("NOT_FOUND");
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

  it("sets and clears prUrl/prState via updateIssue with history entries", async () => {
    const stub = getStub();
    const created = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Link a PR manually" })
    );
    expect(created.prUrl).toBeNull();
    expect(created.prState).toBeNull();

    const linked = await withWorkspace(stub, (instance) =>
      instance.updateIssue(
        created.id,
        {
          prUrl: "https://github.com/owner/repo/pull/7",
          prState: "open",
        },
        "user-1"
      )
    );
    expect(linked?.prUrl).toBe("https://github.com/owner/repo/pull/7");
    expect(linked?.prState).toBe("open");

    const linkHistory = await withWorkspace(stub, (instance) =>
      instance.listIssueHistory(created.id)
    );
    expect(linkHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "pr_url",
          fromValue: null,
          toValue: "https://github.com/owner/repo/pull/7",
        }),
        expect.objectContaining({
          field: "pr_state",
          fromValue: null,
          toValue: "open",
        }),
      ])
    );

    const cleared = await withWorkspace(stub, (instance) =>
      instance.updateIssue(created.id, { prUrl: null, prState: null }, "user-1")
    );
    expect(cleared?.prUrl).toBeNull();
    expect(cleared?.prState).toBeNull();

    const clearHistory = await withWorkspace(stub, (instance) =>
      instance.listIssueHistory(created.id)
    );
    expect(clearHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "pr_url",
          fromValue: "https://github.com/owner/repo/pull/7",
          toValue: null,
        }),
        expect.objectContaining({
          field: "pr_state",
          fromValue: "open",
          toValue: null,
        }),
      ])
    );
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
    const id = `repo:github:vortexnyc:pile:race`;
    const [a, b] = await Promise.all([
      stub.createIssue({ id, title: "Race A" }),
      stub.createIssue({ id, title: "Race B" }),
    ]);
    expect(a.id).toBe(id);
    expect(b.id).toBe(id);
    expect(a.id).toBe(b.id);
  });

  it("returns the same issue for createIssue with the same externalRef", async () => {
    const stub = getStub();
    await stub.setOrganizationId(WORKSPACE_ID);
    const externalRef = `test:${crypto.randomUUID()}`;
    const first = await stub.createIssue({
      title: "External ref first",
      externalRef,
    });
    const second = await stub.createIssue({
      title: "External ref second",
      externalRef,
    });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe(first.title);
    expect(second.externalRef).toBe(externalRef);
  });

  it("assigns distinct numbers for concurrent createIssue with different ids", async () => {
    const stub = getStub();
    await stub.setOrganizationId(WORKSPACE_ID);
    const [a, b] = await Promise.all([
      stub.createIssue({
        id: `repo:github:vortexnyc:pile:${crypto.randomUUID()}`,
        title: "Concurrent A",
      }),
      stub.createIssue({
        id: `repo:github:vortexnyc:pile:${crypto.randomUUID()}`,
        title: "Concurrent B",
      }),
    ]);
    expect(a.number).not.toBe(b.number);
    expect(a.identifier).not.toBe(b.identifier);
  });

  it("does not let updatePrByIdentifier overwrite an issue with a different branch", async () => {
    const stub = getStub();
    await stub.setOrganizationId(WORKSPACE_ID);
    const owner = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Owner issue",
        repo: "VortexNYC/pile",
        branch: "ISS-42-mcp-registry",
      })
    );
    const referenced = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Referenced issue",
        repo: "VortexNYC/pile",
        branch: "ISS-36-webhook-branch-unique",
      })
    );

    await withWorkspace(stub, (instance) =>
      instance.updatePrByIdentifier(
        owner.identifier,
        "https://github.com/VortexNYC/pile/pull/112",
        "open",
        "VortexNYC/pile",
        "ISS-42-mcp-registry"
      )
    );

    await withWorkspace(stub, (instance) =>
      instance.updatePrByIdentifier(
        referenced.identifier,
        "https://github.com/VortexNYC/pile/pull/112",
        "open",
        "VortexNYC/pile",
        "ISS-42-mcp-registry"
      )
    );

    const after = await withWorkspace(stub, (instance) =>
      instance.getIssue(referenced.id)
    );
    expect(after?.prUrl).toBeNull();
    expect(after?.prState).toBeNull();

    const ownerAfter = await withWorkspace(stub, (instance) =>
      instance.getIssue(owner.id)
    );
    expect(ownerAfter?.prUrl).toBe(
      "https://github.com/VortexNYC/pile/pull/112"
    );
    expect(ownerAfter?.prState).toBe("open");
  });

  it("creates a document with 50+ issue-key references without error", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Many-refs link target" })
    );
    const refs = Array.from({ length: 60 }, (_, i) => `FAKE-${i + 1}`);
    const doc = await withWorkspace(stub, (instance) =>
      instance.createDocument({
        title: "Doc with many refs",
        content: [issue.identifier, ...refs].join(" "),
        contentFormat: "markdown",
        createdById: "user-1",
      })
    );
    const links = await withWorkspace(stub, (instance) =>
      instance.listDocumentLinks({ documentId: doc.id })
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      targetType: "issue",
      targetId: issue.id,
    });
  });

  it("deduplicates repeated issue references into a single link", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Deduped link target" })
    );
    const doc = await withWorkspace(stub, (instance) =>
      instance.createDocument({
        title: "Doc with duplicate refs",
        content: Array(10).fill(issue.identifier).join(" "),
        contentFormat: "markdown",
        createdById: "user-1",
      })
    );
    const links = await withWorkspace(stub, (instance) =>
      instance.listDocumentLinks({ documentId: doc.id })
    );
    expect(links).toHaveLength(1);
    expect(links[0].targetId).toBe(issue.id);
  });

  it("links [[slug]] references once and clears stale links on update", async () => {
    const stub = getStub();
    const slug = `linked-${crypto.randomUUID()}`;
    const target = await withWorkspace(stub, (instance) =>
      instance.createDocument({
        title: "Link target doc",
        slug,
        contentFormat: "markdown",
        createdById: "user-1",
      })
    );
    const doc = await withWorkspace(stub, (instance) =>
      instance.createDocument({
        title: "Linker doc",
        content: `see [[${slug}]] and again [[${slug}]]`,
        contentFormat: "markdown",
        createdById: "user-1",
      })
    );
    let links = await withWorkspace(stub, (instance) =>
      instance.listDocumentLinks({ documentId: doc.id })
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      targetType: "document",
      targetId: target.id,
    });

    await withWorkspace(stub, (instance) =>
      instance.updateDocument(
        doc.id,
        { content: "no references left", contentFormat: "markdown" },
        "user-1"
      )
    );
    links = await withWorkspace(stub, (instance) =>
      instance.listDocumentLinks({ documentId: doc.id })
    );
    expect(links).toHaveLength(0);
  });

  it("reports and optionally blocks possible duplicates on create", async () => {
    const stub = getStub();
    const title = `Dedupe probe ${crypto.randomUUID().slice(0, 8)} flaky checkout totals`;
    const first = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title })
    );

    const hidden = await withWorkspace(stub, (instance) =>
      instance.createIssueWithDuplicates(
        { title: `${title} again` },
        undefined,
        {
          teamIds: ["some-other-team"],
          block: true,
        }
      )
    );
    expect(hidden.possibleDuplicates).toEqual([]);
    expect(hidden.issue).not.toBeNull();

    const blocked = await withWorkspace(stub, (instance) =>
      instance.createIssueWithDuplicates({ title }, undefined, {
        teamIds: [first.teamId],
        block: true,
      })
    );
    expect(blocked.issue).toBeNull();
    expect(blocked.possibleDuplicates[0]?.issue.id).toBe(first.id);
    expect(blocked.possibleDuplicates[0]?.score).toBe(1);

    const warned = await withWorkspace(stub, (instance) =>
      instance.createIssueWithDuplicates({ title }, undefined, {
        teamIds: [first.teamId],
        block: false,
      })
    );
    expect(warned.issue?.title).toBe(title);
    expect(warned.possibleDuplicates.map((hit) => hit.issue.id)).toContain(
      first.id
    );
  });

  it("re-anchors waiting dependents of a dead session onto its retry", async () => {
    const stub = getStub();
    const sessionBase = {
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user" as const,
    };

    const deadIssue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Reanchor dead" })
    );
    const dead = await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        ...sessionBase,
        issueId: deadIssue.id,
        status: "failed",
      })
    );
    const retry = await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        ...sessionBase,
        issueId: deadIssue.id,
        status: "waiting",
      })
    );
    const depIssue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Reanchor dependent" })
    );
    const dependent = await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        ...sessionBase,
        issueId: depIssue.id,
        status: "waiting",
        queuedAfter: dead.id,
      })
    );
    const otherIssue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Reanchor unrelated" })
    );
    const unrelated = await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        ...sessionBase,
        issueId: otherIssue.id,
        status: "waiting",
      })
    );

    // PILE-260 — a queuedAfter chain survives redispatch: lanes parked on the
    // corpse re-point at its replacement; other parked lanes are untouched.
    await withWorkspace(stub, (instance) =>
      instance.reanchorQueuedDependents(dead.id, retry.id)
    );

    const after = await withWorkspace(stub, (instance) =>
      instance.getAgentSession(dependent.id)
    );
    expect(after?.queuedAfter).toBe(retry.id);
    const unrelatedAfter = await withWorkspace(stub, (instance) =>
      instance.getAgentSession(unrelated.id)
    );
    expect(unrelatedAfter?.queuedAfter).toBeNull();
  });
});
