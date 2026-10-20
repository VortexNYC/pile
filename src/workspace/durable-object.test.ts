import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { hmacSha256Hex } from "../global/crypto.js";
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
  callback: (instance: WorkspaceDO, ctx: DurableObjectState) => T | Promise<T>
): Promise<T> {
  return runInDurableObject(stub, async (instance, ctx) => {
    await instance.setOrganizationId(WORKSPACE_ID);
    return callback(instance, ctx);
  });
}

// mimetext may base64-encode the body — decode it back to plain text so
// assertions don't depend on the transfer encoding.
function mimeBodyText(raw: string): string {
  const body = raw
    .split(/\r?\n\r?\n/)
    .slice(1)
    .join("\n\n");
  const compact = body.replace(/\s+/g, "");
  return compact.length > 0 && /^[A-Za-z0-9+/=]+$/.test(compact)
    ? Buffer.from(compact, "base64").toString("utf8")
    : body;
}

// Email sends ride ctx.waitUntil (PILE-330) — the RPC returns before
// they run; flushNotificationEmails is the deterministic test seam.
function flushEmails() {
  return withWorkspace(getStub(), (instance) =>
    instance.flushNotificationEmails()
  );
}

describe("WorkspaceDO", () => {
  beforeAll(ensureWorkspace);

  // Capturing EMAIL binding — the DO reads the same env object the test
  // holds, so swapping env.EMAIL intercepts real sends. Restore after
  // each leg.
  const sent: Array<{ from: string; to: string; raw?: string }> = [];
  const fakeEmail: SendEmail = {
    send: async (message) => {
      const msg = message as EmailMessage;
      // workerd keeps the MIME payload under a hidden internal key.
      const raw = (msg as unknown as Record<string, unknown>)[
        "EmailMessage::raw"
      ];
      sent.push({
        from: msg.from,
        to: msg.to,
        raw:
          typeof raw === "string"
            ? raw
            : raw instanceof Uint8Array
              ? new TextDecoder().decode(raw)
              : undefined,
      });
      return { messageId: "" };
    },
  };
  const withEmail = <T>(run: () => Promise<T>): Promise<T> => {
    const prevEmail = env.EMAIL;
    const prevFrom = env.EMAIL_FROM;
    env.EMAIL = fakeEmail;
    env.EMAIL_FROM = "notifications@example.com";
    return run().finally(() => {
      env.EMAIL = prevEmail;
      env.EMAIL_FROM = prevFrom;
    });
  };
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

  it("keeps the generic broadcast for machine-actor assignments", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Webhook-assigned" }, "github")
    );
    await withWorkspace(stub, (instance) =>
      instance.updateIssue(issue.id, { assigneeId: "user-1" }, "github")
    );
    const notes = await withWorkspace(stub, (instance) =>
      instance.listNotificationsForRecipient("user-1", "user")
    );
    // Machine actors never emit the directed notification…
    expect(
      notes.filter((n) => n.type === "issue_assigned" && n.issueId === issue.id)
    ).toHaveLength(0);
    // …but the assignee still hears the generic update — suppressing both
    // would leave webhook-synced assignments totally silent.
    expect(
      notes.filter((n) => n.type === "issue_updated" && n.issueId === issue.id)
    ).toHaveLength(1);
  });

  it("suppresses the directed emit when writes pass notify:false (imports)", async () => {
    const stub = getStub();
    const imported = await withWorkspace(stub, (instance) =>
      instance.createIssue(
        { title: "Imported issue", assigneeId: "user-1" },
        "user-2",
        { notify: false }
      )
    );
    let notes = await withWorkspace(stub, (instance) =>
      instance.listNotificationsForRecipient("user-1", "user")
    );
    // Even though user-2 is a member actor, notify:false suppresses the
    // directed emit (and its default-on email); the generic broadcast row
    // still lands.
    expect(
      notes.filter(
        (n) => n.type === "issue_assigned" && n.issueId === imported.id
      )
    ).toHaveLength(0);
    expect(
      notes.filter(
        (n) => n.type === "issue_created" && n.issueId === imported.id
      )
    ).toHaveLength(1);

    await withWorkspace(stub, (instance) =>
      instance.updateIssue(imported.id, { assigneeId: "user-2" }, "user-1", {
        notify: false,
      })
    );
    notes = await withWorkspace(stub, (instance) =>
      instance.listNotificationsForRecipient("user-2", "user")
    );
    expect(
      notes.filter(
        (n) => n.type === "issue_assigned" && n.issueId === imported.id
      )
    ).toHaveLength(0);
    expect(
      notes.filter(
        (n) => n.type === "issue_updated" && n.issueId === imported.id
      )
    ).toHaveLength(1);
  });

  it("emails directed notifications by default and honors the email opt-out", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Email me" })
    );
    // No prefs row: issue_assigned defaults to email on.
    await withWorkspace(stub, (instance) =>
      withEmail(() =>
        instance.updateIssue(issue.id, { assigneeId: "gh-user-1" }, "user-2")
      )
    );
    await flushEmails();
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe("notifications@example.com");
    expect(sent[0].to).toBe("user-1@test.local");
    // The email identifies the issue — mimetext may base64-encode the
    // header/body, so accept the identifier in either form.
    const raw = sent[0].raw ?? "";
    const encoded = issue.identifier
      ? Buffer.from(issue.identifier).toString("base64")
      : "";
    expect(
      issue.identifier !== null &&
        (raw.includes(issue.identifier) || raw.includes(encoded))
    ).toBe(true);

    // Touching an unrelated pref field must not opt the member out of the
    // directed-email default — email stays unset (tri-state).
    await withWorkspace(stub, (instance) =>
      instance.upsertNotificationPreferences("user-1", {
        mutedTypes: ["issue_updated"],
      })
    );
    sent.length = 0;
    await withWorkspace(stub, (instance) =>
      withEmail(async () => {
        await instance.updateIssue(issue.id, { assigneeId: null }, "user-2");
        await instance.updateIssue(
          issue.id,
          { assigneeId: "gh-user-1" },
          "user-2"
        );
      })
    );
    await flushEmails();
    expect(sent).toHaveLength(1);

    // An explicit email opt-out wins: no send, but the in-app row lands.
    await withWorkspace(stub, (instance) =>
      instance.upsertNotificationPreferences("user-1", { email: false })
    );
    sent.length = 0;
    await withWorkspace(stub, (instance) =>
      withEmail(async () => {
        await instance.updateIssue(issue.id, { assigneeId: null }, "user-2");
        await instance.updateIssue(
          issue.id,
          { assigneeId: "gh-user-1" },
          "user-2"
        );
      })
    );
    await flushEmails();
    expect(sent).toHaveLength(0);
    const notes = await withWorkspace(stub, (instance) =>
      instance.listNotificationsForRecipient("user-1", "user")
    );
    expect(
      notes.filter((n) => n.type === "issue_assigned" && n.issueId === issue.id)
        .length
    ).toBeGreaterThanOrEqual(2);
  });

  it("emails a batch assignee once and links the issue in the body", async () => {
    const stub = getStub();
    // user-2 needs a user + member row to receive mail — create them
    // idempotently so this test also passes under a focused -t run.
    const db = createD1(env.D1);
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
    await db
      .insert(member)
      .values({
        id: crypto.randomUUID(),
        organizationId: WORKSPACE_ID,
        userId: "user-2",
        role: "member",
        createdAt: new Date(),
      })
      .onConflictDoNothing();
    const [first, second] = await withWorkspace(stub, async (instance) => {
      const a = await instance.createIssue({ title: "Batch one" });
      const b = await instance.createIssue({ title: "Batch two" });
      return [a, b];
    });
    sent.length = 0;
    const updated = await withWorkspace(stub, (instance) =>
      withEmail(() =>
        instance.batchUpdateIssues(
          [first.id, second.id],
          { assigneeId: "user-2" },
          "user-1"
        )
      )
    );
    expect(updated).toHaveLength(2);
    await flushEmails();
    // One email for the whole batch, not one per issue…
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("user-2@test.local");
    // …and it carries a link back to the issue plus the batch size —
    // one email covers the whole assignment, so it has to say so.
    const body = mimeBodyText(sent[0].raw ?? "");
    expect(body).toContain(`/${WORKSPACE_ID}/issues/${first.identifier}`);
    expect(body).toContain("+1 more issue assigned in this update");
    // Every issue still writes its directed in-app row.
    const notes = await withWorkspace(stub, (instance) =>
      instance.listNotificationsForRecipient("user-2", "user")
    );
    for (const id of [first.id, second.id]) {
      expect(
        notes.filter((n) => n.type === "issue_assigned" && n.issueId === id)
      ).toHaveLength(1);
    }
  });

  it("still emails opted-in subscribers for every issue in a batch", async () => {
    const stub = getStub();
    const db = createD1(env.D1);
    await db
      .insert(userTable)
      .values({
        id: "user-3",
        name: "Watcher",
        email: "user-3@test.local",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
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
    await db
      .insert(member)
      .values({
        id: crypto.randomUUID(),
        organizationId: WORKSPACE_ID,
        userId: "user-2",
        role: "member",
        createdAt: new Date(),
      })
      .onConflictDoNothing();
    const [first, second] = await withWorkspace(stub, async (instance, ctx) => {
      const a = await instance.createIssue({ title: "Watch one" });
      const b = await instance.createIssue({ title: "Watch two" });
      // Subscriber fan-out resolves linear_ids → linear_users.email →
      // global user. No DO method writes linear_users, so seed the row
      // straight into DO storage.
      ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO linear_users (id, organization_id, linear_id, name, email, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        "linrow-user-3",
        WORKSPACE_ID,
        "lin-user-3",
        "Watcher",
        "user-3@test.local",
        new Date().toISOString()
      );
      for (const issueId of [a.id, b.id]) {
        await instance.createIssueSubscriber({
          issueId,
          linearUserId: "lin-user-3",
        });
      }
      // Explicit opt-in — issue_updated is not an email-by-default type.
      await instance.upsertNotificationPreferences("user-3", {
        email: true,
      });
      return [a, b];
    });
    sent.length = 0;
    await withWorkspace(stub, (instance) =>
      withEmail(() =>
        instance.batchUpdateIssues(
          [first.id, second.id],
          { assigneeId: "user-2" },
          "user-1"
        )
      )
    );
    await flushEmails();
    // The new assignee still gets exactly one directed email.
    expect(sent.filter((m) => m.to === "user-2@test.local")).toHaveLength(1);
    // The opted-in subscriber hears about every issue — the batch email
    // dedupe covers the directed assignee ping, not the broadcast.
    expect(sent.filter((m) => m.to === "user-3@test.local")).toHaveLength(2);
  });

  it("links the document in document-scoped notification emails", async () => {
    const stub = getStub();
    const db = createD1(env.D1);
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
    await db
      .insert(member)
      .values({
        id: crypto.randomUUID(),
        organizationId: WORKSPACE_ID,
        userId: "user-2",
        role: "member",
        createdAt: new Date(),
      })
      .onConflictDoNothing();
    const doc = await withWorkspace(stub, async (instance) => {
      // A linked issue — document_updated used to resolve and link the
      // issue instead of the document.
      const issue = await instance.createIssue({ title: "Spec host" });
      const created = await instance.createDocument({
        title: "Spec doc",
        issueId: issue.id,
        createdById: "user-1",
      });
      // document_updated is not an email-by-default type — opt in, and
      // watch the doc so the watcher fan-out reaches user-2.
      await instance.upsertNotificationPreferences("user-2", { email: true });
      await instance.watchDocument(created.id, "user-2");
      return created;
    });
    sent.length = 0;
    await withWorkspace(stub, (instance) =>
      withEmail(async () => {
        await instance.updateDocument(
          doc.id,
          { title: "Spec doc v2" },
          "user-1"
        );
        // mention is email-by-default — no pref needed.
        await instance.createComment({
          documentId: doc.id,
          body: "Take a look @user-2",
          mentions: ["user-2"],
          authorId: "user-1",
        });
      })
    );
    await flushEmails();
    const mails = sent.filter((m) => m.to === "user-2@test.local");
    expect(mails).toHaveLength(2);
    for (const mail of mails) {
      const body = mimeBodyText(mail.raw ?? "");
      expect(body).toContain(`/${WORKSPACE_ID}/documents/${doc.id}`);
      expect(body).not.toContain("/issues/");
    }
  });

  it("drops the issue link in issue_deleted emails", async () => {
    const stub = getStub();
    const db = createD1(env.D1);
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
    await db
      .insert(member)
      .values({
        id: crypto.randomUUID(),
        organizationId: WORKSPACE_ID,
        userId: "user-2",
        role: "member",
        createdAt: new Date(),
      })
      .onConflictDoNothing();
    const issue = await withWorkspace(stub, async (instance) => {
      // issue_deleted isn't an email-by-default type — opt in explicitly.
      await instance.upsertNotificationPreferences("user-2", { email: true });
      return instance.createIssue(
        { title: "Delete me", assigneeId: "user-2" },
        "user-1"
      );
    });
    sent.length = 0;
    await withWorkspace(stub, (instance) =>
      withEmail(() => instance.deleteIssue(issue.id, "user-1"))
    );
    await flushEmails();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("user-2@test.local");
    const body = mimeBodyText(sent[0].raw ?? "");
    // The email keeps the title for context but no link — the issue is
    // gone, so it would 404.
    expect(body).toContain("Delete me");
    expect(body).not.toContain("/issues/");
  });

  it("does not block or lose a write when the email send stalls (PILE-330)", async () => {
    const stub = getStub();
    // issue_assigned defaults to email-on; a provider send that never
    // resolves used to sit inline in updateIssue and hang the PATCH until
    // the request aborted — rolling the write back with it.
    const hangingEmail: SendEmail = {
      send: () => new Promise(() => undefined),
    };
    const prevEmail = env.EMAIL;
    const prevFrom = env.EMAIL_FROM;
    env.EMAIL = hangingEmail;
    env.EMAIL_FROM = "notifications@example.com";
    try {
      const issue = await withWorkspace(stub, (instance) =>
        instance.createIssue({ title: "Stalled email write" })
      );
      await withWorkspace(stub, (instance) =>
        instance.updateIssue(issue.id, { assigneeId: "gh-user-1" }, "user-2")
      );
      const updated = await withWorkspace(stub, (instance) =>
        instance.getIssue(issue.id)
      );
      expect(updated?.assigneeId).toBe("gh-user-1");
    } finally {
      env.EMAIL = prevEmail;
      env.EMAIL_FROM = prevFrom;
    }
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

  it("tracks delegateId independently of assigneeId and records history", async () => {
    const stub = getStub();
    const created = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Delegated issue",
        assigneeId: "user-1",
        delegateId: "mock-agent",
      })
    );
    expect(created.assigneeId).toBe("user-1");
    expect(created.delegateId).toBe("mock-agent");

    // Setting one leaves the other unchanged.
    const redelegated = await withWorkspace(stub, (instance) =>
      instance.updateIssue(created.id, { delegateId: "other-agent" }, "user-1")
    );
    expect(redelegated?.delegateId).toBe("other-agent");
    expect(redelegated?.assigneeId).toBe("user-1");

    const reassigned = await withWorkspace(stub, (instance) =>
      instance.updateIssue(created.id, { assigneeId: "user-2" }, "user-1")
    );
    expect(reassigned?.assigneeId).toBe("user-2");
    expect(reassigned?.delegateId).toBe("other-agent");

    const history = await withWorkspace(stub, (instance) =>
      instance.listIssueHistory(created.id)
    );
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "delegate_id",
          fromValue: "mock-agent",
          toValue: "other-agent",
        }),
      ])
    );

    // The delegateId list filter matches only delegated issues.
    const delegated = await withWorkspace(stub, (instance) =>
      instance.listIssues({ delegateId: "other-agent" })
    );
    expect(delegated.map((i) => i.id)).toContain(created.id);
    const undelegeted = await withWorkspace(stub, (instance) =>
      instance.listIssues({ delegateId: "no-such-agent" })
    );
    expect(undelegeted.map((i) => i.id)).not.toContain(created.id);

    const cleared = await withWorkspace(stub, (instance) =>
      instance.updateIssue(created.id, { delegateId: null }, "user-1")
    );
    expect(cleared?.delegateId).toBeNull();
    expect(cleared?.assigneeId).toBe("user-2");
  });

  it("delegates to the session's agent without touching the assignee", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Agent does the work",
        assigneeId: "user-1",
      })
    );
    const session = await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        issueId: issue.id,
        agentId: "mock",
        provider: "mock",
        actorId: "user-1",
        actorType: "user",
        status: "running",
      })
    );

    const running = await withWorkspace(stub, (instance) =>
      instance.getIssue(issue.id)
    );
    expect(running?.delegateId).toBe("mock");
    expect(running?.assigneeId).toBe("user-1");

    await withWorkspace(stub, (instance) =>
      instance.applyAgentSessionResult(
        session.id,
        { status: "completed" },
        "user-1"
      )
    );
    const done = await withWorkspace(stub, (instance) =>
      instance.getIssue(issue.id)
    );
    // The agent stays delegate-of-record after the run ends.
    expect(done?.delegateId).toBe("mock");
    expect(done?.assigneeId).toBe("user-1");
  });

  it("claims, renews with an epoch bump, conflicts, and releases (PILE-430)", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Claim me" })
    );
    expect(issue.claimedBy).toBeNull();
    expect(issue.claimEpoch).toBe(0);

    const first = await withWorkspace(stub, (instance) =>
      instance.claimIssue(issue.id, "agent-a", 120, "user-1")
    );
    expect(first.issueId).toBe(issue.id);
    expect(first.claimedBy).toBe("agent-a");
    expect(first.epoch).toBe(1);
    const claimed = await withWorkspace(stub, (instance) =>
      instance.getIssue(issue.id)
    );
    expect(claimed?.claimedBy).toBe("agent-a");
    expect(claimed?.claimedLeaseExpiresAt).toBe(first.leaseExpiresAt);
    expect(claimed?.claimEpoch).toBe(1);

    // Renew (heartbeat): same claimant extends the expiry and bumps epoch.
    const renewed = await withWorkspace(stub, (instance) =>
      instance.claimIssue(issue.id, "agent-a", 300, "user-1")
    );
    expect(renewed.epoch).toBe(2);
    expect(renewed.leaseExpiresAt > first.leaseExpiresAt).toBe(true);

    // Conflict: another claimant gets a CONFLICT-coded error carrying the
    // live holder — the caller must not steal.
    const conflict: unknown = await withWorkspace(stub, (instance) =>
      instance.claimIssue(issue.id, "agent-b", 300)
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(conflict).toBeInstanceOf(Error);
    expect((conflict as { code?: unknown }).code).toBe("CONFLICT");
    const conflictDetails = (
      conflict as { details?: { claimedBy?: string; leaseExpiresAt?: string } }
    ).details;
    expect(conflictDetails?.claimedBy).toBe("agent-a");
    expect(conflictDetails?.leaseExpiresAt).toBe(renewed.leaseExpiresAt);

    // A non-holder cannot release a live claim.
    const forbidden: unknown = await withWorkspace(stub, (instance) =>
      instance.releaseClaim(issue.id, "agent-b")
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(forbidden).toBeInstanceOf(Error);
    expect((forbidden as { code?: unknown }).code).toBe("FORBIDDEN");

    // The holder releases; the epoch keeps fencing.
    await withWorkspace(stub, (instance) =>
      instance.releaseClaim(issue.id, "agent-a", "user-1")
    );
    const freed = await withWorkspace(stub, (instance) =>
      instance.getIssue(issue.id)
    );
    expect(freed?.claimedBy).toBeNull();
    expect(freed?.claimedLeaseExpiresAt).toBeNull();
    expect(freed?.claimEpoch).toBe(3);

    // Releasing an unclaimed issue is a no-op.
    await withWorkspace(stub, (instance) =>
      instance.releaseClaim(issue.id, "agent-b")
    );

    const history = await withWorkspace(stub, (instance) =>
      instance.listIssueHistory(issue.id)
    );
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "claimed_by",
          fromValue: null,
          toValue: "agent-a",
        }),
        expect.objectContaining({
          field: "claimed_by",
          fromValue: "agent-a",
          toValue: null,
        }),
      ])
    );
    // The renew must NOT add a history row — heartbeats stay silent.
    expect(history.filter((h) => h.field === "claimed_by")).toHaveLength(2);
  });

  it("lets anyone reclaim or clear an expired lease", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, async (instance, ctx) => {
      const created = await instance.createIssue({ title: "Lease lapses" });
      await instance.claimIssue(created.id, "agent-a", 60);
      // Backdate the lease — the holder never heartbeated. DO storage is
      // the same SQLite the drizzle schema maps, so a raw write lands.
      ctx.storage.sql.exec(
        "UPDATE issues SET claimed_lease_expires_at = ? WHERE id = ?",
        new Date(Date.now() - 1000).toISOString(),
        created.id
      );
      return created;
    });

    // An expired lease clears on release by any actor, not just the holder.
    await withWorkspace(stub, (instance) =>
      instance.releaseClaim(issue.id, "cleanup")
    );
    const cleared = await withWorkspace(stub, (instance) =>
      instance.getIssue(issue.id)
    );
    expect(cleared?.claimedBy).toBeNull();

    // Reclaim while expired: the new holder wins the check-and-set.
    const claim = await withWorkspace(stub, async (instance, ctx) => {
      const result = await instance.claimIssue(issue.id, "agent-b", 60);
      ctx.storage.sql.exec(
        "UPDATE issues SET claimed_lease_expires_at = ? WHERE id = ?",
        new Date(Date.now() - 1000).toISOString(),
        issue.id
      );
      return result;
    });
    expect(claim.claimedBy).toBe("agent-b");

    const stolen = await withWorkspace(stub, (instance) =>
      instance.claimIssue(issue.id, "agent-c", 60)
    );
    expect(stolen.claimedBy).toBe("agent-c");
    expect(stolen.epoch).toBe(claim.epoch + 1);

    // The stale holder's release can no longer clear a live claim.
    const staleRelease: unknown = await withWorkspace(stub, (instance) =>
      instance.releaseClaim(issue.id, "agent-b")
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    expect((staleRelease as { code?: unknown }).code).toBe("FORBIDDEN");
  });

  it("clamps lease seconds to the 60..3600 window", async () => {
    const stub = getStub();
    const before = Date.now();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Clamp lease" })
    );
    const low = await withWorkspace(stub, (instance) =>
      instance.claimIssue(issue.id, "agent-a", 1)
    );
    const lowExpiry = new Date(low.leaseExpiresAt).getTime();
    expect(lowExpiry - before).toBeGreaterThanOrEqual(60_000);
    await withWorkspace(stub, (instance) =>
      instance.releaseClaim(issue.id, "agent-a")
    );
    const high = await withWorkspace(stub, (instance) =>
      instance.claimIssue(issue.id, "agent-a", 999_999)
    );
    const highExpiry = new Date(high.leaseExpiresAt).getTime();
    expect(highExpiry - Date.now()).toBeLessThanOrEqual(3_600_000);
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

  it("clears stale prState/prCheckState when prUrl is re-pointed alone", async () => {
    const stub = getStub();
    const created = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Re-point a PR link" })
    );
    await withWorkspace(stub, (instance) =>
      instance.reconcileIssuePr(
        created.id,
        "https://github.com/owner/repo/pull/801",
        "closed",
        "success"
      )
    );

    const repointed = await withWorkspace(stub, (instance) =>
      instance.updateIssue(
        created.id,
        { prUrl: "https://github.com/owner/repo/pull/802" },
        "user-1"
      )
    );
    expect(repointed?.prUrl).toBe("https://github.com/owner/repo/pull/802");
    expect(repointed?.prState).toBeNull();
    expect(repointed?.prCheckState).toBeNull();

    const history = await withWorkspace(stub, (instance) =>
      instance.listIssueHistory(created.id)
    );
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "pr_state",
          fromValue: "closed",
          toValue: null,
        }),
        expect.objectContaining({
          field: "pr_check_state",
          fromValue: "success",
          toValue: null,
        }),
      ])
    );
  });

  it("maps a manual prState PATCH through the canonical status map", async () => {
    const stub = getStub();
    const created = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Merged PR closes issue" })
    );
    expect(created.status).toBe("backlog");

    const merged = await withWorkspace(stub, (instance) =>
      instance.updateIssue(
        created.id,
        { prUrl: "https://github.com/owner/repo/pull/9", prState: "merged" },
        "user-1"
      )
    );
    expect(merged?.prState).toBe("merged");
    expect(merged?.status).toBe("done");

    const reopened = await withWorkspace(stub, (instance) =>
      instance.updateIssue(
        created.id,
        { prState: "open", status: "backlog" },
        "user-1"
      )
    );
    expect(reopened?.prState).toBe("open");
    expect(reopened?.status).toBe("backlog");
  });

  it("keeps a triage issue in triage on a non-terminal prState PATCH", async () => {
    const stub = getStub();
    const created = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Escalation with a PR" })
    );
    await withWorkspace(stub, (instance) =>
      instance.updateIssue(created.id, { status: "triage" }, "user-1")
    );

    const opened = await withWorkspace(stub, (instance) =>
      instance.updateIssue(
        created.id,
        { prUrl: "https://github.com/owner/repo/pull/11", prState: "open" },
        "user-1"
      )
    );
    expect(opened?.status).toBe("triage");

    const closed = await withWorkspace(stub, (instance) =>
      instance.updateIssue(created.id, { prState: "closed" }, "user-1")
    );
    expect(closed?.status).toBe("canceled");
  });

  it("rejects a prUrl already linked to another issue", async () => {
    const stub = getStub();
    const owner = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Owns the PR link" })
    );
    const claimant = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Wants the same PR link" })
    );
    await withWorkspace(stub, (instance) =>
      instance.updateIssue(
        owner.id,
        { prUrl: "https://github.com/owner/repo/pull/42" },
        "user-1"
      )
    );

    await expect(
      withWorkspace(stub, (instance) =>
        instance.updateIssue(
          claimant.id,
          { prUrl: "https://github.com/owner/repo/pull/42" },
          "user-1"
        )
      )
    ).rejects.toThrow(/Conflict/);
  });

  it("emits pr.updated on prUrl/prState change and stays silent otherwise", async () => {
    const stub = getStub();
    const created = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Emit coverage" })
    );

    const linkedEvents = await withWorkspace(stub, async (instance) => {
      const emitted: string[] = [];
      const spy = vi
        .spyOn(instance, "emit")
        .mockImplementation(async (event) => {
          emitted.push(event.type);
        });
      try {
        await instance.updateIssue(
          created.id,
          { prUrl: "https://github.com/owner/repo/pull/5", prState: "open" },
          "user-1"
        );
      } finally {
        spy.mockRestore();
      }
      return emitted;
    });
    expect(linkedEvents).toEqual(
      expect.arrayContaining(["issue.updated", "pr.updated"])
    );

    const renamedEvents = await withWorkspace(stub, async (instance) => {
      const emitted: string[] = [];
      const spy = vi
        .spyOn(instance, "emit")
        .mockImplementation(async (event) => {
          emitted.push(event.type);
        });
      try {
        await instance.updateIssue(created.id, { title: "Renamed" }, "user-1");
      } finally {
        spy.mockRestore();
      }
      return emitted;
    });
    expect(renamedEvents).toContain("issue.updated");
    expect(renamedEvents).not.toContain("pr.updated");
  });

  it("rejects a multi-issue batch patch that sets prUrl", async () => {
    const stub = getStub();
    const first = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Batch first" })
    );
    const second = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Batch second" })
    );

    await expect(
      withWorkspace(stub, (instance) =>
        instance.batchUpdateIssues(
          [first.id, second.id],
          { prUrl: "https://github.com/owner/repo/pull/50" },
          "user-1"
        )
      )
    ).rejects.toThrow(/Invalid request/);

    // The batch is refused before any write — no partial application.
    const after = await withWorkspace(stub, (instance) =>
      instance.getIssue(first.id)
    );
    expect(after?.prUrl).toBeNull();
  });

  it("rejects reconcileIssuePr for a prUrl claimed by another issue", async () => {
    const stub = getStub();
    const owner = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Reconcile owner" })
    );
    const claimant = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Reconcile claimant" })
    );
    await withWorkspace(stub, (instance) =>
      instance.reconcileIssuePr(
        owner.id,
        "https://github.com/owner/repo/pull/60",
        "open",
        null
      )
    );

    await expect(
      withWorkspace(stub, (instance) =>
        instance.reconcileIssuePr(
          claimant.id,
          "https://github.com/owner/repo/pull/60",
          "open",
          null
        )
      )
    ).rejects.toThrow(/Conflict/);
  });

  it("drops a lane-reported prUrl claimed by another issue", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Lane issue" })
    );
    const other = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Holds the link" })
    );
    await withWorkspace(stub, (instance) =>
      instance.updateIssue(
        other.id,
        { prUrl: "https://github.com/owner/repo/pull/70" },
        "user-1"
      )
    );
    const session = await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        issueId: issue.id,
        agentId: "mock",
        provider: "mock",
        actorId: "user-1",
        actorType: "user",
        status: "running",
      })
    );

    await withWorkspace(stub, (instance) =>
      instance.applyAgentSessionResult(
        session.id,
        {
          status: "running",
          prUrl: "https://github.com/owner/repo/pull/70",
          prState: "open",
        },
        "user-1"
      )
    );

    const after = await withWorkspace(stub, (instance) =>
      instance.getIssue(issue.id)
    );
    expect(after?.prUrl).toBeNull();
    expect(after?.prState).toBeNull();
  });

  it("clears stale pr state when a lane result re-points the issue prUrl", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Lane re-point issue" })
    );
    await withWorkspace(stub, (instance) =>
      instance.reconcileIssuePr(
        issue.id,
        "https://github.com/owner/repo/pull/80",
        "open",
        "success"
      )
    );
    const session = await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        issueId: issue.id,
        agentId: "mock",
        provider: "mock",
        actorId: "user-1",
        actorType: "user",
        status: "running",
      })
    );

    await withWorkspace(stub, (instance) =>
      instance.applyAgentSessionResult(
        session.id,
        {
          status: "running",
          prUrl: "https://github.com/owner/repo/pull/81",
        },
        "user-1"
      )
    );

    const after = await withWorkspace(stub, (instance) =>
      instance.getIssue(issue.id)
    );
    expect(after?.prUrl).toBe("https://github.com/owner/repo/pull/81");
    expect(after?.prState).toBeNull();
    expect(after?.prCheckState).toBeNull();
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

  it("throws a CONFLICT-coded error when updateIssue claims a taken branch", async () => {
    // PILE-313 — this throw crosses the DO RPC boundary; the API relies on
    // its serialized code/status to answer 409 instead of a 500.
    const stub = getStub();
    await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Branch owner",
        repo: "owner/taken",
        branch: "taken-branch",
      })
    );
    const claimant = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Branch claimant",
        repo: "owner/taken",
        branch: `issue-${crypto.randomUUID()}`,
      })
    );
    const err: unknown = await withWorkspace(stub, (instance) =>
      instance.updateIssue(claimant.id, { branch: "taken-branch" })
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: unknown }).code).toBe("CONFLICT");
    expect((err as { status?: unknown }).status).toBe(409);
  });

  it("lets an issue keep its own repo and branch on update", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Self claim",
        repo: "owner/self",
        branch: "self-branch",
      })
    );
    const updated = await withWorkspace(stub, (instance) =>
      instance.updateIssue(issue.id, { title: "Self claim renamed" })
    );
    expect(updated?.repo).toBe("owner/self");
    expect(updated?.branch).toBe("self-branch");
  });

  it("throws a CONFLICT-coded error when updateIssue claims a taken prUrl", async () => {
    const stub = getStub();
    const prUrl = `https://github.com/owner/repo/pull/${crypto.randomUUID().slice(0, 8)}`;
    const owner = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "PR owner" })
    );
    await withWorkspace(stub, (instance) =>
      instance.updateIssue(owner.id, { prUrl })
    );

    const claimant = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "PR claimant" })
    );
    const err: unknown = await withWorkspace(stub, (instance) =>
      instance.updateIssue(claimant.id, { prUrl })
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: unknown }).code).toBe("CONFLICT");

    // Re-linking the same PR to its owner and clearing with null both work.
    const relinked = await withWorkspace(stub, (instance) =>
      instance.updateIssue(owner.id, { prUrl })
    );
    expect(relinked?.prUrl).toBe(prUrl);
    const cleared = await withWorkspace(stub, (instance) =>
      instance.updateIssue(owner.id, { prUrl: null })
    );
    expect(cleared?.prUrl).toBeNull();
  });

  it("lists agent sessions filtered by retryOf", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Retry chain issue" })
    );
    const dead = await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        issueId: issue.id,
        agentId: "mock",
        provider: "mock",
        actorId: "user-1",
        actorType: "user",
        status: "failed",
      })
    );
    const retry = await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        issueId: issue.id,
        agentId: "mock",
        provider: "mock",
        actorId: "user-1",
        actorType: "user",
        status: "running",
      })
    );
    await stub.updateAgentSession(retry.id, { retryOf: dead.id });
    await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        issueId: issue.id,
        agentId: "mock",
        provider: "mock",
        actorId: "user-1",
        actorType: "user",
        status: "running",
      })
    );

    const retries = await stub.listAgentSessions({ retryOf: dead.id });
    expect(retries.map((s: { id: string }) => s.id)).toEqual([retry.id]);
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

  it("links 17+ resolved issue references — insert rows chunk under the variable cap", async () => {
    const stub = getStub();
    // DO SQLite binds ~100 vars/statement; each link row binds 6, so >16
    // resolved refs used to throw inside the create transaction and 500.
    const issues = await withWorkspace(stub, async (instance) =>
      Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          instance.createIssue({ title: `link target ${i}` })
        )
      )
    );
    const doc = await withWorkspace(stub, (instance) =>
      instance.createDocument({
        title: "Doc with many resolved refs",
        content: issues.map((i) => i.identifier).join(" "),
        contentFormat: "markdown",
        createdById: "user-1",
      })
    );
    const links = await withWorkspace(stub, (instance) =>
      instance.listDocumentLinks({ documentId: doc.id })
    );
    expect(links).toHaveLength(20);
  });

  it("subStepProgressFor answers a 100-parent page — ids ride one JSON param (PILE-448)", async () => {
    const stub = getStub();
    const parents = await withWorkspace(stub, (instance) =>
      Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          instance.createIssue({ title: `Chip parent ${i}` })
        )
      )
    );
    await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Required gate",
        parentId: parents[0].id,
        stepKey: "gate",
        required: true,
      })
    );
    // 100 parent ids + org + required used to bind 102 vars and throw.
    const progress = await withWorkspace(stub, (instance) =>
      instance.subStepProgressFor(parents.map((parent) => parent.id))
    );
    expect(progress[parents[0].id]).toMatchObject({
      total: 1,
      done: 0,
      blocked: 1,
    });
    expect(progress[parents[1].id]).toBeUndefined();
  });

  it("listIssues search survives >95 hit ids — one JSON param, not one ? per id", async () => {
    const stub = getStub();
    const needle = `capneedle${crypto.randomUUID().slice(0, 8)}`;
    await withWorkspace(stub, (instance) =>
      Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          instance.createIssue({ title: `${needle} hit ${i}` })
        )
      )
    );
    const rows = await withWorkspace(stub, (instance) =>
      instance.listIssues({ search: needle, limit: 100 })
    );
    expect(rows).toHaveLength(100);
  });

  it("listIssues applies an `in` filter past the ~100 value cap", async () => {
    const stub = getStub();
    const issues = await withWorkspace(stub, (instance) =>
      Promise.all([
        instance.createIssue({ title: "Filter in probe one" }),
        instance.createIssue({ title: "Filter in probe two" }),
        instance.createIssue({ title: "Filter in probe three" }),
      ])
    );
    // Saved-view `in` filters carry caller-sized value lists — a 100-entry
    // list used to bind one ? per value and throw.
    const values = [
      issues[0].identifier!,
      issues[2].identifier!,
      ...Array.from({ length: 120 }, (_, i) => `NOPE-${i}`),
    ];
    const rows = await withWorkspace(stub, (instance) =>
      instance.listIssues({
        filter: { op: "in", field: "identifier", values },
      })
    );
    expect(rows.map((row) => row.id).toSorted()).toEqual(
      [issues[0].id, issues[2].id].toSorted()
    );
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

  it("skips a cold index build for warn dedupe and warms it in the background", async () => {
    const stub = getStub();
    const title = `Cold index probe ${crypto.randomUUID().slice(0, 8)} deploy receipts`;
    // Seed, then evict — the next RPC lands on a fresh DO with no search
    // index in memory, mirroring production post-deploy state.
    const seeded = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title })
    );
    await evictDurableObject(stub);

    const cold = await withWorkspace(stub, (instance) =>
      instance.createIssueWithDuplicates({ title: `${title} v2` }, undefined, {
        teamIds: [seeded.teamId],
        block: false,
      })
    );
    // Cold index → warn dedupe skipped, but the create itself succeeds —
    // the 42s cold build used to sit on this path and 500 the request.
    expect(cold.issue).not.toBeNull();
    expect(cold.possibleDuplicates).toEqual([]);

    // The skip kicks an off-path build — once it lands, dedupe works again.
    await withWorkspace(stub, (instance) => instance.flushSearchIndex());
    const warm = await withWorkspace(stub, (instance) =>
      instance.createIssueWithDuplicates({ title: `${title} v3` }, undefined, {
        teamIds: [seeded.teamId],
        block: false,
      })
    );
    expect(warm.possibleDuplicates.length).toBeGreaterThan(0);
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

  it("suspends on elicitation, escalates once, resumes on respond (PILE-419)", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({
        title: "Elicitation roundtrip",
        assigneeId: "user-1",
      })
    );
    const session = await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        issueId: issue.id,
        agentId: "mock",
        provider: "mock",
        actorId: "user-1",
        actorType: "user",
        status: "running",
      })
    );

    // Ask → the session parks in `waiting` holding the open question id.
    const elicitation = await withWorkspace(stub, (instance) =>
      instance.addAgentActivity({
        sessionId: session.id,
        type: "elicitation",
        message: "Deploy where?",
      })
    );
    const parked = await withWorkspace(stub, (instance) =>
      instance.getAgentSession(session.id)
    );
    expect(parked?.status).toBe("waiting");
    expect(parked?.awaitingActivityId).toBe(elicitation.id);
    expect(elicitation.startedAt).toBeTruthy();

    // Escalation stamps the marker and fires its fanout exactly once.
    await withWorkspace(stub, (instance) =>
      instance.escalateElicitation(session.id)
    );
    const escalated = await withWorkspace(stub, (instance) =>
      instance.getAgentSession(session.id)
    );
    expect(escalated?.awaitingEscalatedAt).toBeTruthy();
    await withWorkspace(stub, (instance) =>
      instance.escalateElicitation(session.id)
    );
    const escalatedEvents = await withWorkspace(stub, (instance) =>
      instance.listAgentSessionEvents(session.id, { limit: 100 })
    );
    expect(
      escalatedEvents.filter((e) => e.type === "session.elicitation_escalated")
    ).toHaveLength(1);
    const notifications = await withWorkspace(stub, (instance) =>
      instance.listNotificationsForRecipient("user-1", "user", {})
    );
    expect(
      notifications.some((n) => n.type === "lane_elicitation_escalated")
    ).toBe(true);

    // Answer → response activity parented to the question, span closed,
    // session running again with the marker cleared.
    const resumed = await withWorkspace(stub, (instance) =>
      instance.respondToElicitation(session.id, {
        answer: "staging",
        actorId: "user-1",
        delivery: "queued",
      })
    );
    expect(resumed?.status).toBe("running");
    expect(resumed?.awaitingActivityId).toBeNull();
    const activities = await withWorkspace(stub, (instance) =>
      instance.listAgentActivities(session.id)
    );
    const response = activities.find((a) => a.type === "response");
    expect(response?.parentId).toBe(elicitation.id);
    expect(response?.actorId).toBe("user-1");
    const closedQuestion = activities.find((a) => a.id === elicitation.id);
    expect(closedQuestion?.endedAt).toBeTruthy();

    // No open question → respond is a conflict, not a stray activity.
    await expect(
      withWorkspace(stub, (instance) =>
        instance.respondToElicitation(session.id, {
          answer: "again",
          actorId: "user-1",
          delivery: "queued",
        })
      )
    ).rejects.toMatchObject({ status: 409 });
  });

  it("publishes and replaces the session plan checklist (PILE-426)", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Plan checklist" })
    );
    const session = await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        issueId: issue.id,
        agentId: "mock",
        provider: "mock",
        actorId: "user-1",
        actorType: "user",
        status: "running",
      })
    );
    expect(session.plan).toBeNull();

    const plan = [
      { content: "Read the issue", status: "completed" as const },
      { content: "Write the fix", status: "inProgress" as const },
      { content: "Open a PR", status: "pending" as const },
    ];
    const updated = await withWorkspace(stub, (instance) =>
      instance.setAgentSessionPlan(session.id, plan)
    );
    expect(JSON.parse(updated?.plan ?? "null")).toEqual(plan);

    // A publish emits session.plan on the event stream and renders into
    // the lane's live progress comment on the issue.
    const events = await withWorkspace(stub, (instance) =>
      instance.listAgentSessionEvents(session.id, { limit: 100 })
    );
    const planEvents = events.filter((e) => e.type === "session.plan");
    expect(planEvents).toHaveLength(1);
    expect(planEvents[0]?.message).toContain("1/3 done");
    const comments = await withWorkspace(stub, (instance) =>
      instance.listComments(issue.id)
    );
    const progress = comments.find(
      (c) => c.externalId === `${session.id}:progress`
    );
    expect(progress?.body).toContain("**Plan**");
    expect(progress?.body).toContain("- [x] Read the issue");
    expect(progress?.body).toContain("- [ ] Write the fix _(in progress)_");

    // Re-publishing the identical plan is a no-op on the event stream.
    await withWorkspace(stub, (instance) =>
      instance.setAgentSessionPlan(session.id, plan)
    );
    const afterSame = await withWorkspace(stub, (instance) =>
      instance.listAgentSessionEvents(session.id, { limit: 100 })
    );
    expect(afterSame.filter((e) => e.type === "session.plan")).toHaveLength(1);

    // Whole-array replace: statuses move forward, a dropped item is gone,
    // and a canceled item renders struck-through.
    const replaced = await withWorkspace(stub, (instance) =>
      instance.setAgentSessionPlan(session.id, [
        { content: "Write the fix", status: "completed" },
        { content: "Open a PR", status: "inProgress" },
        { content: "Extra polish", status: "canceled" },
      ])
    );
    expect(JSON.parse(replaced?.plan ?? "null")).toEqual([
      { content: "Write the fix", status: "completed" },
      { content: "Open a PR", status: "inProgress" },
      { content: "Extra polish", status: "canceled" },
    ]);
    const progressAfter = (
      await withWorkspace(stub, (instance) => instance.listComments(issue.id))
    ).find((c) => c.externalId === `${session.id}:progress`);
    expect(progressAfter?.body).toContain("- [x] Write the fix");
    expect(progressAfter?.body).toContain("- [ ] Open a PR _(in progress)_");
    expect(progressAfter?.body).toContain(
      "- [ ] ~~Extra polish~~ _(canceled)_"
    );
    expect(progressAfter?.body).not.toContain("Read the issue");

    // Unknown sessions report cleanly instead of throwing.
    expect(
      await withWorkspace(stub, (instance) =>
        instance.setAgentSessionPlan(crypto.randomUUID(), plan)
      )
    ).toBeNull();
  });

  it("stores entity attachments in R2 and cascades them on customer delete", async () => {
    const stub = getStub();
    const customer = await withWorkspace(stub, (instance) =>
      instance.createCustomer({ name: "Attachment customer" })
    );

    const stored = await withWorkspace(stub, (instance) =>
      instance.storeEntityAttachment({
        entityType: "customer",
        entityId: customer.id,
        fileName: "statement.pdf",
        contentType: "application/pdf",
        dataBase64: btoa("statement-bytes"),
        createdById: "user-1",
      })
    );
    expect(stored.entityType).toBe("customer");
    expect(stored.entityId).toBe(customer.id);
    expect(stored.organizationId).toBe(WORKSPACE_ID);
    expect(stored.size).toBe("statement-bytes".length);
    expect(stored.r2Key).toContain(
      `attachments/${WORKSPACE_ID}/customer/${customer.id}/`
    );
    const object = await env.ATTACHMENTS_BUCKET.get(stored.r2Key);
    expect(object).not.toBeNull();
    expect(await object!.text()).toBe("statement-bytes");

    const listed = await withWorkspace(stub, (instance) =>
      instance.listEntityAttachments("customer", customer.id)
    );
    expect(listed.map((a) => a.id)).toEqual([stored.id]);
    const otherScope = await withWorkspace(stub, (instance) =>
      instance.listEntityAttachments("issue", customer.id)
    );
    expect(otherScope).toHaveLength(0);

    const deleted = await withWorkspace(stub, (instance) =>
      instance.deleteCustomer(customer.id, "user-1")
    );
    expect(deleted).toBe(true);
    const orphans = await withWorkspace(stub, (instance) =>
      instance.listEntityAttachments("customer", customer.id)
    );
    expect(orphans).toHaveLength(0);
    expect(await env.ATTACHMENTS_BUCKET.get(stored.r2Key)).toBeNull();
  });

  it("deletes a single entity attachment row and its R2 object", async () => {
    const stub = getStub();
    const customer = await withWorkspace(stub, (instance) =>
      instance.createCustomer({ name: "Detach customer" })
    );
    const stored = await withWorkspace(stub, (instance) =>
      instance.storeEntityAttachment({
        entityType: "customer",
        entityId: customer.id,
        fileName: "doc.txt",
        dataBase64: btoa("doc"),
      })
    );

    const removed = await withWorkspace(stub, (instance) =>
      instance.deleteEntityAttachment(stored.id)
    );
    expect(removed?.id).toBe(stored.id);
    expect(await env.ATTACHMENTS_BUCKET.get(stored.r2Key)).toBeNull();
    const missing = await withWorkspace(stub, (instance) =>
      instance.deleteEntityAttachment(stored.id)
    );
    expect(missing).toBeUndefined();
  });

  // PILE-331 — a cold DO used to rebuild the full search index inline on
  // the first write; writes now leave the build to the first search.
  it("keeps the search index lazy on writes and current once built", async () => {
    const id = env.WORKSPACE_DURABLE_OBJECT.idFromName("pile-331-cold-index");
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(id);
    const result = await withWorkspace(stub, async (instance) => {
      const issue = await instance.createIssue({ title: "Quokka telemetry" });
      await instance.updateIssue(issue.id, { title: "Wombat telemetry" });
      const builtByWrite = Reflect.get(instance, "searchIndex") !== null;

      const cold = await instance.searchAll("wombat", [issue.teamId]);
      const stale = await instance.searchAll("quokka", [issue.teamId]);

      // Index already built: writes apply directly.
      await instance.updateIssue(issue.id, { title: "Numbat telemetry" });
      const warm = await instance.searchAll("numbat", [issue.teamId]);
      return { issueId: issue.id, builtByWrite, cold, stale, warm };
    });
    expect(result.builtByWrite).toBe(false);
    expect(result.cold.issueIds).toContain(result.issueId);
    expect(result.stale.issueIds).not.toContain(result.issueId);
    expect(result.warm.issueIds).toContain(result.issueId);
  });

  it("applies a write that lands while the search index is building", async () => {
    const id = env.WORKSPACE_DURABLE_OBJECT.idFromName("pile-331-racing-index");
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(id);
    const result = await withWorkspace(stub, async (instance) => {
      const issue = await instance.createIssue({ title: "Axolotl ingest" });
      await Promise.all([
        instance.searchAll("axolotl", [issue.teamId]),
        instance.updateIssue(issue.id, { title: "Pangolin ingest" }),
      ]);
      const renamed = await instance.searchAll("pangolin", [issue.teamId]);
      const stale = await instance.searchAll("axolotl", [issue.teamId]);
      return { issueId: issue.id, renamed, stale };
    });
    expect(result.renamed.issueIds).toContain(result.issueId);
    expect(result.stale.issueIds).not.toContain(result.issueId);
  });

  it("logs a phase breakdown only for slow issue updates", async () => {
    const stub = getStub();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const issue = await withWorkspace(stub, (instance) =>
        instance.createIssue({ title: "Fast update" })
      );
      await withWorkspace(stub, (instance) =>
        instance.updateIssue(issue.id, { status: "in_progress" }, "user-1")
      );
      const slowLines = warn.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("issue.update.slow"));
      expect(slowLines).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("listDocumentsVisibleTo", () => {
  it("excludes restricted docs for ungranted actors", async () => {
    await withWorkspace(getStub(), async (instance) => {
      await instance.createDocument({
        title: "open-doc",
        createdById: "owner",
      });
      const restricted = await instance.createDocument({
        title: "restricted-doc",
        createdById: "owner",
      });
      await instance.setDocumentPermission(
        restricted.id,
        "someone-else",
        "user",
        "edit"
      );

      const titles = (
        await instance.listDocumentsVisibleTo("ungranted-member", [])
      ).map((d: { title: string }) => d.title);
      expect(titles).toContain("open-doc");
      expect(titles).not.toContain("restricted-doc");
    });
  });
});

describe("comment mentions", () => {
  beforeAll(ensureWorkspace);
  it("notifies each mentioned user once, excluding the author", async () => {
    await withWorkspace(getStub(), async (instance) => {
      const issue = await instance.createIssue({ title: "mention target" });
      await instance.createComment({
        issueId: issue.id,
        authorId: "author-1",
        body: "cc @mentioned @second",
        mentions: ["author-1", "mentioned-user", "second-user"],
      });
      const mentioned = await instance.listNotificationsForRecipient(
        "mentioned-user",
        "user"
      );
      expect(
        mentioned.some((n) => n.type === "mention" && n.issueId === issue.id)
      ).toBe(true);
      const second = await instance.listNotificationsForRecipient(
        "second-user",
        "user"
      );
      expect(second.some((n) => n.type === "mention")).toBe(true);
      const authorNotes = await instance.listNotificationsForRecipient(
        "author-1",
        "user"
      );
      expect(
        authorNotes.filter(
          (n) => n.type === "mention" && n.issueId === issue.id
        )
      ).toHaveLength(0);
    });
  });

  it("notifies the issue assignee on a new comment", async () => {
    await withWorkspace(getStub(), async (instance) => {
      const issue = await instance.createIssue({
        title: "assignee target",
        assigneeId: "user-1",
      });
      const comment = await instance.createComment({
        issueId: issue.id,
        authorId: "author-2",
        body: "assignee ping",
      });
      if (!comment) throw new Error("comment was not created");
      // createComment itself only notifies watchers/mentions — the API
      // route follows with emitCommentCreated, the single comment_created
      // delivery path to issue assignee/subscribers.
      await instance.emitCommentCreated(comment, issue, "author-2");
      const notes = await instance.listNotificationsForRecipient(
        "user-1",
        "user"
      );
      expect(
        notes.some(
          (n) => n.type === "comment_created" && n.issueId === issue.id
        )
      ).toBe(true);
    });
  });
});

describe("grantedOnly issue visibility", () => {
  beforeAll(ensureWorkspace);
  it("hides ungranted issues from default-deny viewers", async () => {
    await withWorkspace(getStub(), async (instance) => {
      const open = await instance.createIssue({ title: "open-issue" });
      const mine = await instance.createIssue({ title: "mine" });
      await instance.setIssuePermission(mine.id, "c-1", "user");

      const viewer = {
        actorId: "c-1",
        teamIds: [],
        grantedOnly: true,
      };
      const hidden = new Set(await instance.hiddenIssueIdsFor(viewer));
      expect(hidden.has(open.id)).toBe(true);
      expect(hidden.has(mine.id)).toBe(false);

      // Direct access mirrors it.
      expect(await instance.issueVisibleTo(open.id, "c-1", [], true)).toBe(
        false
      );
      expect(await instance.issueVisibleTo(mine.id, "c-1", [], true)).toBe(
        true
      );
      // Without the flag, open issues stay open.
      expect(await instance.issueVisibleTo(open.id, "c-1", [])).toBe(true);

      // The SQL-side exclusion (hiddenIssueConditionFor) drives
      // listIssues — under grantedOnly it returns only `mine`. This is
      // the path that previously overflowed SQLite's variable cap by
      // enumerating every issue id into notInArray.
      const listed = await instance.listIssues({ viewer });
      const listedIds = new Set(listed.map((i) => i.id));
      expect(listedIds.has(mine.id)).toBe(true);
      expect(listedIds.has(open.id)).toBe(false);
    });
  });
});

describe("pipeline hygiene via DO RPC", () => {
  it("createCustomer/createDeal dedupe on externalId inside the DO", async () => {
    const stub = getStub();
    const first = await withWorkspace(stub, (instance) =>
      instance.createCustomer({
        name: "RPC customer",
        externalId: "rpc-c-1",
        priorityScore: 7,
      })
    );
    const replay = await withWorkspace(stub, (instance) =>
      instance.createCustomer({ name: "Replay", externalId: "rpc-c-1" })
    );
    expect(replay.id).toBe(first.id);
    expect(
      await withWorkspace(stub, (instance) =>
        instance.getCustomerByExternalId("rpc-c-1")
      )
    ).toMatchObject({ id: first.id, priorityScore: 7 });

    const deal = await withWorkspace(stub, (instance) =>
      instance.createDeal({
        customerId: first.id,
        name: "RPC deal",
        stage: "lead",
        externalId: "rpc-d-1",
        nextStepDueAt: "2026-10-20T00:00:00.000Z",
      })
    );
    const dealReplay = await withWorkspace(stub, (instance) =>
      instance.createDeal({
        customerId: first.id,
        name: "Dup",
        stage: "won",
        externalId: "rpc-d-1",
      })
    );
    expect(dealReplay.id).toBe(deal.id);
    expect(dealReplay.stage).toBe("lead");
    expect(
      await withWorkspace(stub, (instance) =>
        instance.getDealByExternalId("rpc-d-1")
      )
    ).toMatchObject({ id: deal.id });

    const cold = await withWorkspace(stub, (instance) =>
      instance.listDeals({ cold: true })
    );
    expect(cold.map((d) => d.id)).not.toContain(deal.id);
    const due = await withWorkspace(stub, (instance) =>
      instance.listDeals({ dueBefore: "2026-10-25T00:00:00.000Z" })
    );
    expect(due.map((d) => d.id)).toContain(deal.id);
  });

  it("manages guidance packs with audit + version history", async () => {
    const stub = getStub();
    const pack = await stub.createGuidancePack(
      {
        name: "Outreach rules",
        scope: "status",
        scopeKey: "in_progress",
        body: "No rate or savings numbers.",
      },
      { actorId: "user-1", actorType: "user" }
    );
    expect(pack.version).toBe(1);

    const updated = await stub.updateGuidancePack(
      pack.id,
      { body: "No rate, savings, or ROI numbers." },
      { actorId: "user-1" }
    );
    expect(updated?.version).toBe(2);
    const versions = await stub.listGuidancePackVersions(pack.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);

    const resolved = await stub.resolveGuidancePacks({
      status: "in_progress",
    });
    expect(resolved.some((p) => p.id === pack.id)).toBe(true);
    const other = await stub.resolveGuidancePacks({ status: "done" });
    expect(other.some((p) => p.id === pack.id)).toBe(false);

    expect(await stub.deleteGuidancePack(pack.id, { actorId: "user-1" })).toBe(
      true
    );
    // Deleted pack still resolves its recorded version history.
    expect((await stub.listGuidancePackVersions(pack.id)).length).toBe(2);
  });
});

describe("stage templates (PILE-411)", () => {
  const ACTOR = "user-1";

  it("materializes sub-issues when an issue enters a templated status", async () => {
    const stub = getStub();
    await withWorkspace(stub, (instance) =>
      instance.createStageTemplate(
        {
          entityType: "issue",
          status: "in progress",
          stepKey: "kickoff",
          title: "Kickoff",
          required: true,
          ownerAgent: "scout",
          position: 0,
        },
        { actorId: ACTOR }
      )
    );
    await withWorkspace(stub, (instance) =>
      instance.createStageTemplate(
        {
          entityType: "issue",
          status: "in progress",
          stepKey: "audit",
          title: "Audit",
          required: false,
          ownerAgent: null,
          position: 1,
        },
        { actorId: ACTOR }
      )
    );

    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Stage parent" }, ACTOR)
    );
    await withWorkspace(stub, (instance) =>
      instance.updateIssue(issue.id, { status: "in_progress" }, ACTOR)
    );

    const children = await withWorkspace(stub, (instance) =>
      instance.getIssueChildren(issue.id)
    );
    const byStep = new Map(children.map((c) => [c.stepKey, c]));
    expect([...byStep.keys()].toSorted()).toEqual(["audit", "kickoff"]);
    expect(byStep.get("kickoff")).toMatchObject({
      title: "Kickoff",
      required: true,
      ownerAgent: "scout",
      status: "todo",
      parentId: issue.id,
      teamId: issue.teamId,
    });
    expect(byStep.get("audit")?.required).toBe(false);

    // Re-entering the stage is idempotent — no duplicate step_keys. The
    // stage gate (PILE-412) holds the parent until required steps resolve,
    // so close kickoff before leaving the status.
    await withWorkspace(stub, (instance) =>
      instance.updateIssue(byStep.get("kickoff")!.id, { status: "done" }, ACTOR)
    );
    await withWorkspace(stub, (instance) =>
      instance.updateIssue(issue.id, { status: "todo" }, ACTOR)
    );
    await withWorkspace(stub, (instance) =>
      instance.updateIssue(issue.id, { status: "in_progress" }, ACTOR)
    );
    const after = await withWorkspace(stub, (instance) =>
      instance.getIssueChildren(issue.id)
    );
    expect(after.length).toBe(2);
  });

  it("skips conditional steps whose rule fails, and fires them when the field is set", async () => {
    const stub = getStub();
    await withWorkspace(stub, (instance) =>
      instance.createStageTemplate(
        {
          entityType: "issue",
          status: "backlog",
          stepKey: "ship_hardware",
          title: "Ship hardware",
          required: false,
          ownerAgent: "outfitter",
          condition: { field: "hardware_needed" },
        },
        { actorId: ACTOR }
      )
    );
    const field = await withWorkspace(stub, (instance) =>
      instance.createFieldDefinition({
        entityType: "issue",
        name: "hardware_needed",
        type: "boolean",
      })
    );
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "No hardware" }, ACTOR)
    );
    expect(
      await withWorkspace(stub, (instance) =>
        instance.getIssueChildren(issue.id)
      )
    ).toEqual([]);

    // Set the field and re-enter the stage — the gated step now appears.
    await withWorkspace(stub, (instance) =>
      instance.setFieldValue(field.id, issue.id, "true")
    );
    await withWorkspace(stub, (instance) =>
      instance.updateIssue(issue.id, { status: "todo" }, ACTOR)
    );
    await withWorkspace(stub, (instance) =>
      instance.updateIssue(issue.id, { status: "backlog" }, ACTOR)
    );
    const children = await withWorkspace(stub, (instance) =>
      instance.getIssueChildren(issue.id)
    );
    expect(children.map((c) => c.stepKey)).toEqual(["ship_hardware"]);
  });

  it("materializes sub-steps on a linked deal issue when the customer's status enters a stage", async () => {
    const stub = getStub();
    const seeded = await withWorkspace(stub, (instance) =>
      instance.seedStageTemplates({ actorId: ACTOR })
    );
    expect(seeded.created.length).toBe(22);

    const status = await withWorkspace(stub, (instance) =>
      instance.createCustomerStatus({ name: "Prospect" })
    );
    const customer = await withWorkspace(stub, (instance) =>
      instance.createCustomer({ name: "Acme Pizza" })
    );
    const deal = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Deal — Acme Pizza" }, ACTOR)
    );
    await withWorkspace(stub, (instance) =>
      instance.linkEntities({
        fromType: "customer",
        fromId: customer.id,
        toType: "issue",
        toId: deal.id,
      })
    );

    await withWorkspace(stub, (instance) =>
      instance.updateCustomer(customer.id, { statusId: status.id }, ACTOR)
    );
    const children = await withWorkspace(stub, (instance) =>
      instance.getIssueChildren(deal.id)
    );
    const steps = children.map((c) => c.stepKey).toSorted();
    expect(steps).toEqual(
      [
        "contact_found",
        "field_visit",
        "profiled",
        "ready_for_outreach",
        "sourced",
      ].toSorted()
    );

    // A customer with no linked issue creates nothing.
    const orphan = await withWorkspace(stub, (instance) =>
      instance.createCustomer({ name: "No deal" })
    );
    await withWorkspace(stub, (instance) =>
      instance.updateCustomer(orphan.id, { statusId: status.id }, ACTOR)
    );
    const all = await withWorkspace(stub, (instance) =>
      instance.listIssues({})
    );
    expect(all.filter((i) => i.title.startsWith("Deal — No deal")).length).toBe(
      0
    );
  });

  it("does not cascade templates onto sub-issues", async () => {
    const stub = getStub();
    // "todo" is the status materialized sub-steps are created in — a
    // template on it must not create grandchildren (sub-issues only nest
    // one level).
    await withWorkspace(stub, (instance) =>
      instance.createStageTemplate(
        {
          entityType: "issue",
          status: "todo",
          stepKey: "nested",
          title: "Nested",
          required: true,
        },
        { actorId: ACTOR }
      )
    );
    const parent = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Cascade parent", status: "todo" }, ACTOR)
    );
    const children = await withWorkspace(stub, (instance) =>
      instance.getIssueChildren(parent.id)
    );
    expect(children.map((c) => c.stepKey)).toEqual(["nested"]);
    // The materialized child itself entered "todo" but got no children.
    for (const child of children) {
      expect(
        await withWorkspace(stub, (instance) =>
          instance.getIssueChildren(child.id)
        )
      ).toEqual([]);
    }
  });
});

function deliveries(instance: WorkspaceDO, source: string) {
  return instance.listExternalEventDeliveries({ source });
}

describe("external event ingest (PILE-422)", () => {
  beforeAll(ensureWorkspace);
  const SECRET = "whsec_test_secret";

  async function signed(
    instance: WorkspaceDO,
    input: {
      source: string;
      eventId?: string | null;
      body: unknown;
      secret?: string;
      signaturePrefix?: string;
    }
  ) {
    const body =
      typeof input.body === "string" ? input.body : JSON.stringify(input.body);
    const hex = await hmacSha256Hex(input.secret ?? SECRET, body);
    return instance.ingestExternalEvent({
      source: input.source,
      signatures: [`${input.signaturePrefix ?? "sha256="}${hex}`],
      eventId: input.eventId ?? null,
      body,
    });
  }

  it("completes the mapped sub-step under the matched issue's parent", async () => {
    const stub = getStub();
    await withWorkspace(stub, async (instance) => {
      await instance.createExternalEventMapping(
        {
          source: "finix",
          eventType: "merchant.approved",
          entityType: "issue",
          matchPath: "data.merchant_id",
          stepKey: "approved",
          secret: SECRET,
        },
        {}
      );
      const parent = await instance.createIssue({
        title: "Deal — Acme",
        externalRef: "finix-mu-1",
      });
      const child = await instance.createIssue({
        title: "Approved",
        parentId: parent.id,
        stepKey: "approved",
      });
      const sibling = await instance.createIssue({
        title: "Submitted to Finix",
        parentId: parent.id,
        stepKey: "submitted_to_finix",
      });

      const result = await signed(instance, {
        source: "finix",
        eventId: "evt_approved_1",
        body: {
          id: "evt_approved_1",
          type: "merchant.approved",
          data: { merchant_id: "finix-mu-1" },
        },
      });
      expect(result.status).toBe("applied");
      expect(result.completedIssueIds).toEqual([child.id]);

      const updated = await instance.getIssue(child.id);
      expect(updated?.status).toBe("done");
      expect(updated?.resolution).toBe("resolved");
      // Sibling steps are untouched.
      expect((await instance.getIssue(sibling.id))?.status).toBe("backlog");

      // The payload lands as evidence on the completed sub-step.
      const comments = await instance.listComments(child.id);
      const evidence = comments.find(
        (c) => c.externalSource === "external-event:finix"
      );
      expect(evidence?.externalId).toBe("evt_approved_1");
      expect(evidence?.body).toContain("merchant.approved");
      expect(evidence?.body).toContain("finix-mu-1");

      const rows = await deliveries(instance, "finix");
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("applied");
      expect(rows[0].entityId).toBe(parent.id);
      expect(JSON.parse(rows[0].completedIssueIds!)).toEqual([child.id]);
      expect(rows[0].payload).toContain("finix-mu-1");
    });
  });

  it("resolves through a deal's externalId to its linked parent issue", async () => {
    const stub = getStub();
    await withWorkspace(stub, async (instance) => {
      await instance.createExternalEventMapping(
        {
          source: "seal",
          eventType: "agreement.signed",
          entityType: "deal",
          matchPath: "agreement.deal_ref",
          stepKey: "agreement_signed",
          secret: SECRET,
        },
        {}
      );
      const customer = await instance.createCustomer({ name: "Seal Corp" });
      const deal = await instance.createDeal({
        customerId: customer.id,
        name: "Seal deal",
        externalId: "deal-ext-7",
        stage: "negotiation",
      });
      const parent = await instance.createIssue({ title: "Deal — Seal" });
      await instance.linkDealIssue(deal.id, parent.id);
      const child = await instance.createIssue({
        title: "Agreement signed",
        parentId: parent.id,
        stepKey: "agreement_signed",
      });

      const result = await signed(instance, {
        source: "seal",
        body: {
          id: "seal-evt-1",
          type: "agreement.signed",
          agreement: { deal_ref: "deal-ext-7" },
        },
      });
      expect(result.status).toBe("applied");
      expect(result.completedIssueIds).toEqual([child.id]);
      expect((await instance.getIssue(child.id))?.status).toBe("done");
    });
  });

  it("completes the matched issue directly when it carries the stepKey", async () => {
    const stub = getStub();
    await withWorkspace(stub, async (instance) => {
      await instance.createExternalEventMapping(
        {
          source: "shipping",
          eventType: "package.delivered",
          entityType: "issue",
          matchPath: "tracking.ticket",
          stepKey: "hardware_shipped",
          secret: SECRET,
        },
        {}
      );
      const parent = await instance.createIssue({ title: "Onboard Acme" });
      const step = await instance.createIssue({
        title: "Hardware shipped",
        parentId: parent.id,
        stepKey: "hardware_shipped",
        externalRef: "tracking-77",
      });

      const result = await signed(instance, {
        source: "shipping",
        body: {
          id: "ship-1",
          type: "package.delivered",
          tracking: { ticket: "tracking-77" },
        },
      });
      expect(result.status).toBe("applied");
      expect(result.completedIssueIds).toEqual([step.id]);
      expect((await instance.getIssue(step.id))?.status).toBe("done");
    });
  });

  it("rejects a bad signature without touching state", async () => {
    const stub = getStub();
    await withWorkspace(stub, async (instance) => {
      const parent = await instance.createIssue({
        title: "Deal — BadSig",
        externalRef: "finix-mu-bad",
      });
      const child = await instance.createIssue({
        title: "Approved",
        parentId: parent.id,
        stepKey: "approved",
      });

      const result = await signed(instance, {
        source: "finix",
        secret: "wrong-secret",
        body: {
          id: "evt_bad_sig",
          type: "merchant.approved",
          data: { merchant_id: "finix-mu-bad" },
        },
      });
      expect(result.status).toBe("invalid_signature");
      expect((await instance.getIssue(child.id))?.status).toBe("backlog");

      const rows = await deliveries(instance, "finix");
      const row = rows.find((r) => r.eventId === "evt_bad_sig");
      expect(row?.status).toBe("invalid_signature");
    });
  });

  it("makes replays a no-op — no second write, no second comment", async () => {
    const stub = getStub();
    await withWorkspace(stub, async (instance) => {
      const parent = await instance.createIssue({
        title: "Deal — Replay",
        externalRef: "finix-mu-replay",
      });
      const child = await instance.createIssue({
        title: "Approved",
        parentId: parent.id,
        stepKey: "approved",
      });
      const body = JSON.stringify({
        id: "evt_replay",
        type: "merchant.approved",
        data: { merchant_id: "finix-mu-replay" },
      });

      const first = await signed(instance, {
        source: "finix",
        body,
      });
      expect(first.status).toBe("applied");
      const second = await signed(instance, {
        source: "finix",
        body,
      });
      expect(second.status).toBe("replay");
      expect(second.outcome).toBe("applied");
      expect(second.deliveryId).toBe(first.deliveryId);

      const rows = (await deliveries(instance, "finix")).filter(
        (r) => r.eventId === "evt_replay"
      );
      expect(rows).toHaveLength(1);
      const comments = (await instance.listComments(child.id)).filter(
        (c) => c.externalId === "evt_replay"
      );
      expect(comments).toHaveLength(1);
    });
  });

  it("logs unmapped and unmatched events without changing state", async () => {
    const stub = getStub();
    await withWorkspace(stub, async (instance) => {
      const parent = await instance.createIssue({
        title: "Deal — Unmatched",
        externalRef: "finix-mu-unknown",
      });
      const child = await instance.createIssue({
        title: "Approved",
        parentId: parent.id,
        stepKey: "approved",
      });

      // Verified signature, but no mapping for this event type.
      const unmapped = await signed(instance, {
        source: "finix",
        body: {
          id: "evt_unmapped",
          type: "merchant.declined",
          data: { merchant_id: "finix-mu-unknown" },
        },
      });
      expect(unmapped.status).toBe("unmapped");

      // Mapped event type, but the payload resolves to no record.
      const noRecord = await signed(instance, {
        source: "finix",
        body: {
          id: "evt_no_record",
          type: "merchant.approved",
          data: { merchant_id: "finix-mu-ghost" },
        },
      });
      expect(noRecord.status).toBe("no_record");

      // Mapped event and record, but no sub-step carries the key.
      const noStepParent = await instance.createIssue({
        title: "Deal — NoStep",
        externalRef: "finix-mu-nostep",
      });
      await instance.createIssue({
        title: "Other step",
        parentId: noStepParent.id,
        stepKey: "sourced",
      });
      const noStep = await signed(instance, {
        source: "finix",
        body: {
          id: "evt_no_step",
          type: "merchant.approved",
          data: { merchant_id: "finix-mu-nostep" },
        },
      });
      expect(noStep.status).toBe("no_step");

      // The step exists but is already terminal — a second event (e.g. the
      // provider's own correction event with a fresh id) changes nothing.
      const doneParent = await instance.createIssue({
        title: "Deal — Done",
        externalRef: "finix-mu-done",
      });
      await instance.createIssue({
        title: "Approved",
        parentId: doneParent.id,
        stepKey: "approved",
        status: "done",
        resolution: "resolved",
      });
      const alreadyDone = await signed(instance, {
        source: "finix",
        body: {
          id: "evt_already_done",
          type: "merchant.approved",
          data: { merchant_id: "finix-mu-done" },
        },
      });
      expect(alreadyDone.status).toBe("already_done");

      expect((await instance.getIssue(child.id))?.status).toBe("backlog");
      const rows = await deliveries(instance, "finix");
      const byEvent = new Map(rows.map((r) => [r.eventId, r.status]));
      expect(byEvent.get("evt_unmapped")).toBe("unmapped");
      expect(byEvent.get("evt_no_record")).toBe("no_record");
      expect(byEvent.get("evt_no_step")).toBe("no_step");
      expect(byEvent.get("evt_already_done")).toBe("already_done");
    });
  });

  it("dedupes id-less events on a body hash", async () => {
    const stub = getStub();
    await withWorkspace(stub, async (instance) => {
      const body = JSON.stringify({
        type: "merchant.approved",
        data: { merchant_id: "finix-mu-idless" },
      });
      const first = await signed(instance, { source: "finix", body });
      expect(first.status).toBe("no_record");
      const second = await signed(instance, { source: "finix", body });
      expect(second.status).toBe("replay");
      expect(second.outcome).toBe("no_record");
    });
  });

  it("reports unknown_source when no mapping exists for the source", async () => {
    const stub = getStub();
    await withWorkspace(stub, async (instance) => {
      const result = await signed(instance, {
        source: "nonexistent-source",
        body: { id: "x", type: "anything" },
      });
      expect(result.status).toBe("unknown_source");
    });
  });
});

describe("spend caps + run receipts (PILE-425)", () => {
  beforeAll(async () => {
    await ensureWorkspace();
  });

  it("records a usage snapshot and computes cost from the rate map", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "receipt test" })
    );
    const session = await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        issueId: issue.id,
        agentId: "mock",
        provider: "mock",
        actorId: "user-1",
        actorType: "user",
        status: "running",
      })
    );
    const receipt = await stub.recordSessionUsage(session.id, {
      model: "claude-sonnet-4-5",
      inputTokens: 100_000,
      outputTokens: 10_000,
      toolCalls: 7,
    });
    expect(receipt?.sessionId).toBe(session.id);
    expect(receipt?.issueId).toBe(issue.id);
    expect(receipt?.totalTokens).toBe(110_000);
    // 100k in @3/MTok + 10k out @15/MTok = 450_000 micros ($0.45).
    expect(receipt?.costMicros).toBe(450_000);
    expect(receipt?.costSource).toBe("rate_map");
    // Reported cost wins over the rate map.
    const reported = await stub.recordSessionUsage(session.id, {
      costMicros: 999,
    });
    expect(reported?.costMicros).toBe(999);
    expect(reported?.costSource).toBe("reported");
  });

  it("finalizes the receipt on the terminal transition even without usage", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "terminal receipt" })
    );
    const session = await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        issueId: issue.id,
        agentId: "mock",
        provider: "mock",
        actorId: "user-1",
        actorType: "user",
        status: "running",
      })
    );
    await withWorkspace(stub, (instance) =>
      instance.applyAgentSessionResult(session.id, { status: "completed" })
    );
    const receipt = await stub.getRunReceipt(session.id);
    expect(receipt).not.toBeUndefined();
    expect(receipt?.status).toBe("completed");
    expect(receipt?.endedAt).not.toBeNull();
    expect(receipt?.durationMs).not.toBeNull();
    // No usage reported — token/cost fields stay null, not zero.
    expect(receipt?.totalTokens).toBeNull();
    expect(receipt?.costMicros).toBeNull();
  });

  it("carries usage on the result into the finalized receipt", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "usage result" })
    );
    const session = await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        issueId: issue.id,
        agentId: "mock",
        provider: "mock",
        actorId: "user-1",
        actorType: "user",
        status: "running",
      })
    );
    await withWorkspace(stub, (instance) =>
      instance.applyAgentSessionResult(session.id, {
        status: "failed",
        usage: {
          model: "gpt-5",
          inputTokens: 1_000_000,
          outputTokens: 0,
          externalSpendMicros: 50,
        },
      })
    );
    const receipt = await stub.getRunReceipt(session.id);
    expect(receipt?.status).toBe("failed");
    expect(receipt?.totalTokens).toBe(1_000_000);
    expect(receipt?.costMicros).toBe(1_250_000);
    expect(receipt?.externalSpendMicros).toBe(50);
  });

  it("evaluates window caps against runs and receipts", async () => {
    const stub = getStub();
    const agentId = `caps-do-${crypto.randomUUID()}`;
    await stub.upsertAgentSpendCap(agentId, { maxRunsPerDay: 1 });
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "cap eval" })
    );
    await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        issueId: issue.id,
        agentId,
        provider: "mock",
        actorId: "user-1",
        actorType: "user",
        status: "running",
      })
    );
    const verdict = await stub.evaluateAgentSpendCaps(agentId);
    expect(verdict.breaches).toEqual([
      { scope: "day", dimension: "runs", limit: 1, observed: 1 },
    ]);
    // Unknown agent → uncapped.
    const none = await stub.evaluateAgentSpendCaps(
      `no-caps-${crypto.randomUUID()}`
    );
    expect(none.breaches).toEqual([]);
    expect(none.caps).toBeUndefined();
  });

  it("claims the cap alert once per day", async () => {
    const stub = getStub();
    const agentId = `caps-claim-${crypto.randomUUID()}`;
    await stub.upsertAgentSpendCap(agentId, { maxRunsPerDay: 1 });
    expect(await stub.claimSpendCapAlert(agentId)).toBe(true);
    expect(await stub.claimSpendCapAlert(agentId)).toBe(false);
  });

  it("marks a receipt stopped by a per-run cap", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "cap stop" })
    );
    const session = await withWorkspace(stub, (instance) =>
      instance.createAgentSession({
        issueId: issue.id,
        agentId: "mock",
        provider: "mock",
        actorId: "user-1",
        actorType: "user",
        status: "running",
      })
    );
    const receipt = await stub.markRunReceiptStopped(
      session.id,
      "per-run tokens cap exceeded (51000/50000)"
    );
    expect(receipt?.capExceeded).toBe(1);
    expect(receipt?.stopReason).toContain("per-run tokens cap");
  });
});

describe("triage rules via DO RPC (PILE-427)", () => {
  beforeAll(ensureWorkspace);

  it("manages rules and the evaluation log through the stub", async () => {
    const stub = getStub();
    const rule = await stub.createTriageRule(
      {
        name: "leads to scout",
        recordType: "lead",
        sortOrder: 0,
        conditions: JSON.stringify({ sources: ["form"] }),
        action: JSON.stringify({ type: "delegate", agentId: "scout" }),
      },
      { actorId: "user-1", actorType: "user" }
    );
    expect(rule.id).toBeTruthy();

    const listed = await stub.listTriageRules({ recordType: "lead" });
    expect(listed.some((r) => r.id === rule.id)).toBe(true);
    const inactive = await stub.updateTriageRule(
      rule.id,
      { isActive: false },
      { actorId: "user-1" }
    );
    expect(inactive?.isActive).toBe(false);
    expect(
      (
        await stub.listTriageRules({ recordType: "lead", activeOnly: true })
      ).some((r) => r.id === rule.id)
    ).toBe(false);

    const evalRow = await stub.recordTriageEvaluation({
      recordType: "lead",
      recordId: "lead-1",
      ruleId: rule.id,
      ruleName: rule.name,
      outcome: "matched",
      detail: JSON.stringify({ issueId: "i-1" }),
    });
    const evals = await stub.listTriageEvaluations({ recordId: "lead-1" });
    expect(evals.map((e) => e.id)).toEqual([evalRow.id]);

    expect(await stub.deleteTriageRule(rule.id, { actorId: "user-1" })).toBe(
      true
    );
    expect(await stub.getTriageRule(rule.id)).toBeUndefined();
  });
});

describe("external link verification (PILE-429)", () => {
  beforeAll(ensureWorkspace);

  it("round-trips the probe result through the DO RPC surface", async () => {
    const stub = getStub();
    const created = await withWorkspace(stub, (instance) =>
      instance.createExternalLink(
        {
          entityType: "customer",
          entityId: crypto.randomUUID(),
          url: "https://example.com/spec",
          verification: {
            status: "verified",
            verifiedAt: "2026-10-20T00:00:00.000Z",
            resolvedUrl: "https://example.com/spec",
            resolvedTitle: "The Spec",
            httpStatus: 200,
          },
        },
        "user-1"
      )
    );
    expect(created?.verificationStatus).toBe("verified");
    expect(created?.resolvedTitle).toBe("The Spec");

    const updated = await withWorkspace(stub, (instance) =>
      instance.updateExternalLink(
        created!.id,
        {
          url: "https://example.com/moved",
          verification: {
            status: "unreachable",
            verifiedAt: "2026-10-20T01:00:00.000Z",
            resolvedUrl: null,
            resolvedTitle: null,
            httpStatus: null,
          },
        },
        "user-1"
      )
    );
    expect(updated?.verificationStatus).toBe("unreachable");
    expect(updated?.resolvedUrl).toBeNull();
  });
});

describe("draft outputs (PILE-428)", () => {
  it("holds a comment draft, publishes it as a real comment, then locks the row", async () => {
    const stub = getStub();
    await withWorkspace(stub, async (instance) => {
      const issue = await instance.createIssue({ title: "Sensitive record" });
      const draft = await instance.createDraftOutput({
        entityType: "issue",
        entityId: issue.id,
        issueId: issue.id,
        kind: "comment",
        payload: { body: "agent-held comment" },
        createdById: "agent-1",
      });
      expect(draft.status).toBe("pending");

      // The held write is not live yet — no comment on the issue.
      expect(await instance.listComments(issue.id)).toHaveLength(0);

      const pending = await instance.listDraftOutputs({ issueId: issue.id });
      expect(pending.map((d) => d.id)).toEqual([draft.id]);

      const published = await instance.publishDraftOutput(
        draft.id,
        "user-1",
        "looks right"
      );
      expect(published.status).toBe("published");
      expect(published.reviewedById).toBe("user-1");
      expect(published.reviewNote).toBe("looks right");
      expect(published.publishedCommentId).toBeTruthy();

      const comment = await instance.getComment(published.publishedCommentId!);
      expect(comment?.body).toBe("agent-held comment");

      // Resolved rows reject further transitions.
      await expect(
        instance.discardDraftOutput(draft.id, "user-1")
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        instance.publishDraftOutput("draft-missing", "user-1")
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  it("replays a field_change draft through updateIssue on publish", async () => {
    const stub = getStub();
    await withWorkspace(stub, async (instance) => {
      const issue = await instance.createIssue({ title: "before" });
      const draft = await instance.createDraftOutput({
        entityType: "issue",
        entityId: issue.id,
        issueId: issue.id,
        kind: "field_change",
        payload: { fields: { title: "after review" } },
        createdById: "agent-1",
      });

      // A human can edit the held payload before publishing.
      await instance.updateDraftOutputPayload(
        draft.id,
        { fields: { title: "edited then approved" } },
        "user-1"
      );

      const published = await instance.publishDraftOutput(draft.id, "user-1");
      expect(published.status).toBe("published");
      const updated = await instance.getIssue(issue.id);
      expect(updated?.title).toBe("edited then approved");
    });
  });

  it("retains discarded drafts for inspection", async () => {
    const stub = getStub();
    await withWorkspace(stub, async (instance) => {
      const draft = await instance.createDraftOutput({
        entityType: "issue",
        entityId: "issue-discard",
        kind: "comment",
        payload: { body: "off-brand" },
        createdById: "agent-1",
      });
      const discarded = await instance.discardDraftOutput(
        draft.id,
        "user-1",
        "not our voice"
      );
      expect(discarded.status).toBe("discarded");
      expect(discarded.reviewNote).toBe("not our voice");

      // The row is review history — still queryable by status.
      const rows = await instance.listDraftOutputs({ status: "discarded" });
      expect(rows.map((d) => d.id)).toContain(draft.id);
    });
  });
});

describe("customer contacts (CRM)", () => {
  it("upsertContact dedupes on customer+channel+value", async () => {
    const stub = getStub();
    const out = await withWorkspace(stub, async (instance) => {
      const customer = instance.createCustomer({
        name: "Contact Co",
      });
      const a = instance.upsertContact({
        customerId: customer.id,
        channel: "email",
        value: "owner@contactco.example",
      });
      const b = instance.upsertContact({
        customerId: customer.id,
        channel: "email",
        value: "owner@contactco.example",
      });
      const different = instance.upsertContact({
        customerId: customer.id,
        channel: "phone",
        value: "+15551234567",
      });
      return { a, b, different };
    });
    expect(out.b.id).toBe(out.a.id);
    expect(out.different.id).not.toBe(out.a.id);
  });
});

describe("merchant sources (feed registry)", () => {
  it("upserts + cursors a source through the DO", async () => {
    const stub = getStub();
    const out = await withWorkspace(stub, async (instance) => {
      const src = instance.upsertMerchantSource({
        name: "nys-sla-pending",
        kind: "socrata",
        config: { domain: "data.ny.gov", dataset: "f8i8-k2gm" },
        cursorField: "received_date",
        signal: "license_pending",
      });
      const dupe = instance.upsertMerchantSource({
        name: "nys-sla-pending",
        kind: "socrata",
      });
      instance.updateMerchantSource(src.id, {
        cursorValue: "2026-10-19",
      });
      const list = instance.listMerchantSources({ enabledOnly: true });
      return { src, dupe, list };
    });
    expect(out.dupe.id).toBe(out.src.id);
    expect(out.list.find((r) => r.id === out.src.id)?.cursorValue).toBe(
      "2026-10-19"
    );
  });
});

describe("space permissions via DO (PILE-447)", () => {
  it("setSpacePermission + revokeSpacePermission round-trip", async () => {
    const stub = getStub();
    const out = await withWorkspace(stub, async (instance) => {
      const space = instance.createDocumentSpace({
        name: "Leadership",
        restricted: true,
        createdById: WORKSPACE_ID,
      });
      const perm = instance.setSpacePermission(
        WORKSPACE_ID,
        space.id,
        "member-1",
        "user",
        "view"
      );
      const list = instance.listSpacePermissions(space.id);
      const revoked = instance.revokeSpacePermission(space.id, "member-1");
      return { perm, list, revoked };
    });
    expect(out.perm.level).toBe("view");
    expect(out.list).toHaveLength(1);
    expect(out.revoked).toBe(true);
  });
});
