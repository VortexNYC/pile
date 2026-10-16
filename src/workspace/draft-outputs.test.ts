import { env, runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { member, organization, user as userTable } from "../global/schema.js";
import { createDefaultTeam } from "../global/teams.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import type { WorkspaceDO } from "./durable-object.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

const WORKSPACE_ID = "test-workspace-drafts";

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
      id: "draft-user-1",
      name: "Draft Reviewer",
      email: "draft-user-1@test.local",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  await db.insert(organization).values({
    id: WORKSPACE_ID,
    name: "Draft test workspace",
    slug: "test-workspace-drafts",
    metadata: JSON.stringify({ key: "DRF" }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: WORKSPACE_ID,
    userId: "draft-user-1",
    role: "owner",
    createdAt: now,
  });
  const headers = await createAdminHeaders(env, "draft-user-1");
  await createDefaultTeam(
    db,
    env,
    headers,
    WORKSPACE_ID,
    "DRF",
    "draft-user-1"
  );
}

function getStub() {
  const id = env.WORKSPACE_DURABLE_OBJECT.idFromName(WORKSPACE_ID);
  return env.WORKSPACE_DURABLE_OBJECT.get(id);
}

async function withWorkspace<T>(
  stub: ReturnType<typeof getStub>,
  callback: (instance: WorkspaceDO, ctx: DurableObjectState) => T | Promise<T>
): Promise<T> {
  return runInDurableObject(stub, async (instance, ctx) => {
    await instance.setOrganizationId(WORKSPACE_ID);
    return callback(instance, ctx);
  });
}

async function createSession(
  stub: ReturnType<typeof getStub>,
  issueId: string
) {
  return withWorkspace(stub, (instance) =>
    instance.createAgentSession({
      issueId,
      agentId: "courier",
      provider: "mock",
      actorId: "draft-user-1",
      actorType: "user",
      status: "running",
    })
  );
}

describe("draft outputs (PILE-428)", () => {
  beforeAll(ensureWorkspace);

  it("marks issues sensitive through create + patch", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "sensitive deal", sensitive: true })
    );
    expect(issue.sensitive).toBe(true);

    const cleared = await withWorkspace(stub, (instance) =>
      instance.updateIssue(issue.id, { sensitive: false }, "draft-user-1")
    );
    expect(cleared?.sensitive).toBe(false);
  });

  it("drafts a lane's completion comment on a sensitive issue", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "merchant record", sensitive: true })
    );
    const session = await createSession(stub, issue.id);
    await withWorkspace(stub, (instance) =>
      instance.applyAgentSessionResult(session.id, {
        status: "completed",
        result: "Drafted outreach copy",
      })
    );

    const comments = await stub.listComments(issue.id);
    expect(
      comments.filter((comment) => comment.externalId === session.id)
    ).toHaveLength(0);

    const drafts = await stub.listDraftOutputs({ issueId: issue.id });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.kind).toBe("comment");
    expect(drafts[0]?.status).toBe("pending");
    expect(drafts[0]?.createdById).toBe("courier");
    expect(drafts[0]?.sessionId).toBe(session.id);
    const payload = JSON.parse(drafts[0]!.payload) as { body: string };
    expect(payload.body).toContain("Drafted outreach copy");
  });

  it("still posts lane comments directly on ordinary issues", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "ordinary record" })
    );
    const session = await createSession(stub, issue.id);
    await withWorkspace(stub, (instance) =>
      instance.applyAgentSessionResult(session.id, {
        status: "completed",
        result: "all done",
      })
    );
    const comments = await stub.listComments(issue.id);
    expect(comments.some((comment) => comment.externalId === session.id)).toBe(
      true
    );
    expect(await stub.listDraftOutputs({ issueId: issue.id })).toHaveLength(0);
  });

  it("publishes a comment draft through the normal comment path", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "sensitive publish", sensitive: true })
    );
    const session = await createSession(stub, issue.id);
    await withWorkspace(stub, (instance) =>
      instance.applyAgentSessionResult(session.id, {
        status: "completed",
        result: "please review me",
      })
    );
    const [draft] = await stub.listDraftOutputs({ issueId: issue.id });
    expect(draft).toBeDefined();

    const published = await withWorkspace(stub, (instance) =>
      instance.publishDraftOutput(draft!.id, "draft-user-1", "ship it")
    );
    expect(published.status).toBe("published");
    expect(published.reviewedById).toBe("draft-user-1");
    expect(published.reviewNote).toBe("ship it");
    expect(published.publishedCommentId).not.toBeNull();

    const comments = await stub.listComments(issue.id);
    const posted = comments.find(
      (comment) => comment.id === published.publishedCommentId
    );
    expect(posted?.body).toContain("please review me");
    expect(posted?.externalAuthor).toBe("courier");
    // The lane's dedupe key rides along — the published comment is the
    // same write the lane would have posted.
    expect(posted?.externalId).toBe(session.id);

    // Audit records both the producing agent and the publishing human.
    const audit = await stub.listAuditLog({
      entityType: "draft_output",
      entityId: draft!.id,
      action: "draft_output.published",
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe("draft-user-1");
    const changes = JSON.parse(audit[0]!.changes ?? "{}") as Record<
      string,
      { to: unknown }
    >;
    expect(changes.producedBy?.to).toBe("courier");
  });

  it("applies edited payloads on publish", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "edit before publish", sensitive: true })
    );
    const session = await createSession(stub, issue.id);
    await withWorkspace(stub, (instance) =>
      instance.applyAgentSessionResult(session.id, {
        status: "completed",
        result: "first draft",
      })
    );
    const [draft] = await stub.listDraftOutputs({ issueId: issue.id });
    await withWorkspace(stub, (instance) =>
      instance.updateDraftOutputPayload(
        draft!.id,
        { body: "human-edited version" },
        "draft-user-1"
      )
    );
    await withWorkspace(stub, (instance) =>
      instance.publishDraftOutput(draft!.id, "draft-user-1")
    );
    const comments = await stub.listComments(issue.id);
    expect(comments.some((c) => c.body === "human-edited version")).toBe(true);
  });

  it("discards drafts without deleting them", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "discard me", sensitive: true })
    );
    const session = await createSession(stub, issue.id);
    await withWorkspace(stub, (instance) =>
      instance.applyAgentSessionResult(session.id, {
        status: "completed",
        result: "never send this",
      })
    );
    const [draft] = await stub.listDraftOutputs({ issueId: issue.id });
    const discarded = await withWorkspace(stub, (instance) =>
      instance.discardDraftOutput(draft!.id, "draft-user-1", "wrong tone")
    );
    expect(discarded.status).toBe("discarded");
    expect(discarded.reviewNote).toBe("wrong tone");

    // Retained for inspection — the row still lists.
    const all = await stub.listDraftOutputs({ issueId: issue.id });
    expect(all).toHaveLength(1);
    const comments = await stub.listComments(issue.id);
    expect(comments.some((c) => c.externalId === session.id)).toBe(false);

    // Resolved drafts reject further transitions.
    await expect(
      withWorkspace(stub, (instance) =>
        instance.publishDraftOutput(draft!.id, "draft-user-1")
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("replays field_change drafts through updateIssue", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "sensitive fields", sensitive: true })
    );
    const draft = await withWorkspace(stub, (instance) =>
      instance.createDraftOutput({
        entityType: "issue",
        entityId: issue.id,
        issueId: issue.id,
        kind: "field_change",
        payload: { fields: { title: "agent-renamed", priority: "high" } },
        createdById: "quoter",
      })
    );
    expect((await stub.getIssue(issue.id))?.title).toBe("sensitive fields");

    await withWorkspace(stub, (instance) =>
      instance.publishDraftOutput(draft.id, "draft-user-1")
    );
    const updated = await stub.getIssue(issue.id);
    expect(updated?.title).toBe("agent-renamed");
    expect(updated?.priority).toBe("high");
  });

  it("notifies the record's subscribers when a draft lands", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "notify on draft",
        sensitive: true,
        assigneeId: "draft-user-1",
      })
    );
    const session = await createSession(stub, issue.id);
    await withWorkspace(stub, (instance) =>
      instance.applyAgentSessionResult(session.id, {
        status: "completed",
        result: "awaiting review",
      })
    );
    const notifications = await stub.listNotificationsForRecipient(
      "draft-user-1",
      "user",
      {}
    );
    expect(notifications.some((n) => n.type === "draft_pending")).toBe(true);
  });
});
