import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

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
