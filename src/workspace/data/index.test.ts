import { env, runInDurableObject } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { beforeAll, describe, expect, it } from "vitest";

import type { WorkerEnv } from "../../platform/middleware.js";
import type { WorkspaceDO } from "../durable-object.js";
import { workspaceSchema } from "../schema-map.js";
import { workspaceIssues } from "../schema.js";
import {
  hiddenIssueCondition,
  type AgentSessionInput,
  createAgentSession,
  createDeal,
  createDocument,
  createDocumentSpace,
  documentAccessLevel,
  getCustomerByExternalId,
  getDealByExternalId,
  listDeals,
  listDocumentsVisibleTo,
  setDocumentPermission,
  updateDocument,
  updateDocumentSpace,
  createCustomer,
  createEntityAttachment,
  deleteCustomer,
  deleteEntityAttachment,
  customerUrlHost,
  fileCustomerIntakeItem,
  getAgentSession,
  getEntityAttachment,
  getNotificationPreferences,
  hasIssueAccess,
  hiddenIssueIds,
  listIssuePermissions,
  setIssuePermission,
  revokeIssuePermission,
  listAgentSessions,
  listDocumentLinks,
  listEntityAttachments,
  listCustomerIntakeItems,
  listCustomers,
  reanchorQueuedDependents,
  replaceDocumentLinks,
  resolveCustomerForEmail,
  updateAgentSession,
  upsertNotificationPreferences,
  type WorkspaceDb,
} from "./index.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

const WORKSPACE_ID = "test-data-layer";

function getStub() {
  const id = env.WORKSPACE_DURABLE_OBJECT.idFromName(WORKSPACE_ID);
  return env.WORKSPACE_DURABLE_OBJECT.get(id);
}

function withDb<T>(callback: (db: WorkspaceDb) => T | Promise<T>): Promise<T> {
  return runInDurableObject(getStub(), (_instance: WorkspaceDO, state) =>
    callback(drizzle(state.storage, { schema: workspaceSchema }))
  );
}

function sessionInput(
  overrides: Partial<AgentSessionInput>
): AgentSessionInput {
  return {
    organizationId: WORKSPACE_ID,
    issueId: crypto.randomUUID(),
    agentId: "mock",
    provider: "mock",
    actorId: "user-1",
    actorType: "user",
    ...overrides,
  };
}

describe("workspace agent session data", () => {
  beforeAll(async () => {
    // Force the DO through init (migrations) before raw-storage access.
    await getStub().listWorkspaceComments();
  });

  it("re-anchors waiting dependents from a dead session onto its retry", async () => {
    await withDb(async (db) => {
      const dead = await createAgentSession(
        db,
        sessionInput({ status: "failed" })
      );
      const retry = await createAgentSession(
        db,
        sessionInput({ status: "waiting" })
      );
      const dependent = await createAgentSession(
        db,
        sessionInput({ status: "waiting", queuedAfter: dead.id })
      );
      const otherBlocker = await createAgentSession(db, sessionInput({}));
      const unrelated = await createAgentSession(
        db,
        sessionInput({ status: "waiting", queuedAfter: otherBlocker.id })
      );
      const dispatchedDependent = await createAgentSession(
        db,
        sessionInput({ status: "running", queuedAfter: dead.id })
      );

      await reanchorQueuedDependents(db, WORKSPACE_ID, dead.id, retry.id);

      // PILE-260 — only still-waiting rows parked on the dead session move
      // onto the retry; other edges and already-dispatched lanes keep theirs.
      expect(
        (await getAgentSession(db, WORKSPACE_ID, dependent.id))?.queuedAfter
      ).toBe(retry.id);
      expect(
        (await getAgentSession(db, WORKSPACE_ID, unrelated.id))?.queuedAfter
      ).toBe(otherBlocker.id);
      expect(
        (await getAgentSession(db, WORKSPACE_ID, dispatchedDependent.id))
          ?.queuedAfter
      ).toBe(dead.id);
    });
  });

  it("does not leak re-anchors across workspaces", async () => {
    await withDb(async (db) => {
      const dead = await createAgentSession(
        db,
        sessionInput({ status: "failed" })
      );
      const foreign = await createAgentSession(
        db,
        sessionInput({
          organizationId: "other-workspace",
          status: "waiting",
          queuedAfter: dead.id,
        })
      );

      await reanchorQueuedDependents(db, WORKSPACE_ID, dead.id, "retry-id");

      expect(
        (await getAgentSession(db, "other-workspace", foreign.id))?.queuedAfter
      ).toBe(dead.id);
    });
  });

  it("rewinds createdAt on update so queue dwell does not count as runtime", async () => {
    await withDb(async (db) => {
      const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const session = await createAgentSession(
        db,
        sessionInput({ status: "waiting", createdAt: stale })
      );

      const rewound = new Date().toISOString();
      const updated = await updateAgentSession(db, WORKSPACE_ID, session.id, {
        status: "created",
        createdAt: rewound,
      });

      expect(updated?.status).toBe("created");
      expect(updated?.createdAt).toBe(rewound);
      // createdAt stays put when the update does not mention it.
      const untouched = await updateAgentSession(db, WORKSPACE_ID, session.id, {
        status: "running",
      });
      expect(untouched?.createdAt).toBe(rewound);
    });
  });

  it("filters sessions by retryOf so the retry walk finds every successor", async () => {
    await withDb(async (db) => {
      const dead = await createAgentSession(
        db,
        sessionInput({ status: "failed" })
      );
      const retryA = await createAgentSession(
        db,
        sessionInput({ status: "running" })
      );
      const retryB = await createAgentSession(
        db,
        sessionInput({ status: "waiting" })
      );
      await updateAgentSession(db, WORKSPACE_ID, retryA.id, {
        retryOf: dead.id,
      });
      await updateAgentSession(db, WORKSPACE_ID, retryB.id, {
        retryOf: dead.id,
      });
      await createAgentSession(db, sessionInput({ status: "running" }));

      const retries = listAgentSessions(db, WORKSPACE_ID, {
        retryOf: dead.id,
      });
      expect(retries.map((s) => s.id).toSorted()).toEqual(
        [retryA.id, retryB.id].toSorted()
      );
      // No filter: retries surface alongside everything else.
      expect(
        listAgentSessions(db, WORKSPACE_ID, {}).length
      ).toBeGreaterThanOrEqual(4);
    });
  });
});

describe("notification preferences", () => {
  it("defaults email off at the row level; the DO applies its own high-signal default", async () => {
    await withDb(async (db) => {
      expect(
        getNotificationPreferences(db, WORKSPACE_ID, "nobody")
      ).toBeUndefined();

      await upsertNotificationPreferences(db, WORKSPACE_ID, "nobody", {});
      const row = getNotificationPreferences(db, WORKSPACE_ID, "nobody");
      // Rows only record explicit choices — the default-on email for
      // issue_assigned/mention lives in the DO while email stays unset.
      expect(row?.inApp).toBe(true);
      expect(row?.email).toBe(false);
      expect(row?.emailExplicit).toBe(false);
      expect(row?.webhook).toBe(true);

      // Writing an unrelated field does not mark email as chosen.
      await upsertNotificationPreferences(db, WORKSPACE_ID, "nobody", {
        mutedTypes: ["issue_updated"],
      });
      expect(
        getNotificationPreferences(db, WORKSPACE_ID, "nobody")?.emailExplicit
      ).toBe(false);

      // Explicit choices persist and mutedTypes round-trips.
      await upsertNotificationPreferences(db, WORKSPACE_ID, "nobody", {
        email: true,
        mutedTypes: ["issue_updated"],
      });
      const updated = getNotificationPreferences(db, WORKSPACE_ID, "nobody");
      expect(updated?.email).toBe(true);
      expect(updated?.emailExplicit).toBe(true);
      expect(updated?.mutedTypes).toBe("issue_updated");
    });
  });
});

describe("entity attachment data", () => {
  it("creates, lists, gets, and deletes rows within an entity scope", async () => {
    await withDb(async (db) => {
      const customer = await createCustomer(db, {
        organizationId: WORKSPACE_ID,
        name: "Attachment subject",
      });
      const row = await createEntityAttachment(db, WORKSPACE_ID, {
        entityType: "customer",
        entityId: customer.id,
        fileName: "statement.pdf",
        contentType: "application/pdf",
        size: 42,
        r2Key: `attachments/${WORKSPACE_ID}/customer/${customer.id}/a1`,
        createdById: "user-1",
      });
      expect(row.organizationId).toBe(WORKSPACE_ID);
      expect(row.entityType).toBe("customer");
      expect(row.createdById).toBe("user-1");

      expect(
        await listEntityAttachments(db, WORKSPACE_ID, "customer", customer.id)
      ).toHaveLength(1);
      // The scope is (organizationId, entityType, entityId): a different
      // entity type or org on the same entity id sees nothing.
      expect(
        await listEntityAttachments(db, WORKSPACE_ID, "issue", customer.id)
      ).toHaveLength(0);
      expect(
        await listEntityAttachments(db, "other-org", "customer", customer.id)
      ).toHaveLength(0);

      expect((await getEntityAttachment(db, WORKSPACE_ID, row.id))?.r2Key).toBe(
        row.r2Key
      );
      expect(
        await getEntityAttachment(db, "other-org", row.id)
      ).toBeUndefined();

      const removed = await deleteEntityAttachment(db, WORKSPACE_ID, row.id);
      expect(removed?.id).toBe(row.id);
      expect(
        await deleteEntityAttachment(db, WORKSPACE_ID, row.id)
      ).toBeUndefined();
    });
  });

  it("cascades only customer-scoped rows when the customer is deleted", async () => {
    await withDb(async (db) => {
      const doomed = await createCustomer(db, {
        organizationId: WORKSPACE_ID,
        name: "Doomed",
      });
      const kept = await createCustomer(db, {
        organizationId: WORKSPACE_ID,
        name: "Kept",
      });
      const onDoomed = await createEntityAttachment(db, WORKSPACE_ID, {
        entityType: "customer",
        entityId: doomed.id,
        fileName: "a.pdf",
        contentType: "application/pdf",
        size: 1,
        r2Key: `attachments/${WORKSPACE_ID}/customer/${doomed.id}/a`,
      });
      // Same entity id under a different type, and another customer's row,
      // must survive the cascade.
      const sameIdOtherType = await createEntityAttachment(db, WORKSPACE_ID, {
        entityType: "issue",
        entityId: doomed.id,
        fileName: "b.pdf",
        contentType: "application/pdf",
        size: 1,
        r2Key: `attachments/${WORKSPACE_ID}/issue/${doomed.id}/b`,
      });
      const onKept = await createEntityAttachment(db, WORKSPACE_ID, {
        entityType: "customer",
        entityId: kept.id,
        fileName: "c.pdf",
        contentType: "application/pdf",
        size: 1,
        r2Key: `attachments/${WORKSPACE_ID}/customer/${kept.id}/c`,
      });

      const deleted = await deleteCustomer(db, WORKSPACE_ID, doomed.id);
      expect(deleted).toBe(true);

      expect(
        await getEntityAttachment(db, WORKSPACE_ID, onDoomed.id)
      ).toBeUndefined();
      expect(
        (await getEntityAttachment(db, WORKSPACE_ID, sameIdOtherType.id))?.id
      ).toBe(sameIdOtherType.id);
      expect((await getEntityAttachment(db, WORKSPACE_ID, onKept.id))?.id).toBe(
        onKept.id
      );
    });
  });
});

describe("customer email intake resolution", () => {
  it("creates a customer from the sender domain when nothing matches", async () => {
    await withDb(async (db) => {
      const { customer, created } = resolveCustomerForEmail(db, WORKSPACE_ID, {
        email: "rep@merchant-one.example",
        name: "Rep One",
      });
      expect(created).toBe(true);
      expect(customer.name).toBe("merchant-one.example");
      expect(customer.url).toBe("https://merchant-one.example");
    });
  });

  it("matches an existing customer by URL host, including subdomains", async () => {
    await withDb(async (db) => {
      createCustomer(db, {
        organizationId: WORKSPACE_ID,
        name: "Acme",
        url: "https://www.acme-match.example/about",
      });
      for (const email of [
        "ap@acme-match.example",
        "ap@mail.acme-match.example",
      ]) {
        const { customer, created } = resolveCustomerForEmail(
          db,
          WORKSPACE_ID,
          { email }
        );
        expect(created).toBe(false);
        expect(customer.name).toBe("Acme");
      }
    });
  });

  it("matches scheme-less and path-bearing customer URLs", async () => {
    await withDb(async (db) => {
      createCustomer(db, {
        organizationId: WORKSPACE_ID,
        name: "Bare",
        url: "bare-host.example/docs",
      });
      const { customer, created } = resolveCustomerForEmail(db, WORKSPACE_ID, {
        email: "x@bare-host.example",
      });
      expect(created).toBe(false);
      expect(customer.name).toBe("Bare");
    });
  });

  it("does not match lookalike domains", async () => {
    await withDb(async (db) => {
      createCustomer(db, {
        organizationId: WORKSPACE_ID,
        name: "Lookalike",
        url: "https://lookalike.example",
      });
      for (const email of [
        "x@evil-lookalike.example",
        "x@lookalike.example.evil.org",
        "x@other-lookalike.example",
      ]) {
        const { customer, created } = resolveCustomerForEmail(
          db,
          WORKSPACE_ID,
          { email }
        );
        expect(created).toBe(true);
        expect(customer.name).not.toBe("Lookalike");
      }
    });
  });

  it("names freemail senders by display name and never by domain", async () => {
    await withDb(async (db) => {
      createCustomer(db, {
        organizationId: WORKSPACE_ID,
        name: "Traps",
        url: "https://gmail.com",
      });
      const { customer, created } = resolveCustomerForEmail(db, WORKSPACE_ID, {
        email: "jane.doe@gmail.com",
        name: "Jane Doe",
      });
      expect(created).toBe(true);
      expect(customer.name).toBe("Jane Doe");
      expect(customer.url).toBeNull();

      // Repeat mail from the same freemail mailbox reuses the record.
      const again = resolveCustomerForEmail(db, WORKSPACE_ID, {
        email: "jane.doe@gmail.com",
        name: "Jane D.",
      });
      expect(again.created).toBe(false);
      expect(again.customer.id).toBe(customer.id);
    });
  });

  it("picks the oldest record deterministically when several match", async () => {
    await withDb(async (db) => {
      const older = createCustomer(db, {
        organizationId: WORKSPACE_ID,
        name: "Older",
        url: "https://dupe.example",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      createCustomer(db, {
        organizationId: WORKSPACE_ID,
        name: "Newer",
        url: "https://mail.dupe.example",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      // Force distinct createdAt so the ordering is exercised, not insertion
      // order luck.
      const { customer } = resolveCustomerForEmail(db, WORKSPACE_ID, {
        email: "x@dupe.example",
      });
      expect(customer.id).toBe(older.id);
    });
  });

  it("dedupes intake items on externalId", async () => {
    await withDb(async (db) => {
      const input = {
        customerId: "cust-1",
        fromAddress: "rep@acme.example",
        toAddress: "intake@vortex.example",
        subject: "Dedup me",
        externalId: "dedup-msg@acme.example",
        attachments: [
          {
            key: null,
            filename: "a.pdf",
            contentType: "application/pdf",
            size: 3,
          },
        ],
      };
      const first = fileCustomerIntakeItem(db, WORKSPACE_ID, input);
      const second = fileCustomerIntakeItem(db, WORKSPACE_ID, input);
      expect(first.isNew).toBe(true);
      expect(second.isNew).toBe(false);
      expect(second.item?.id).toBe(first.item?.id);
      expect(listCustomerIntakeItems(db, WORKSPACE_ID, "cust-1")).toHaveLength(
        1
      );
      const customers = listCustomers(db, WORKSPACE_ID);
      expect(customers.every((c) => c.id !== undefined)).toBe(true);
    });
  });
});

describe("customerUrlHost", () => {
  it("normalizes schemes, www, and paths", () => {
    expect(customerUrlHost("https://www.acme.example/path")).toBe(
      "acme.example"
    );
    expect(customerUrlHost("acme.example")).toBe("acme.example");
    expect(customerUrlHost("http://acme.example:8080/x")).toBe("acme.example");
    expect(customerUrlHost("")).toBeNull();
    expect(customerUrlHost("   ")).toBeNull();
  });
});

describe("issue permission grants", () => {
  it("defaults open, restricts on first grant, covers teams, and reopens on revoke", async () => {
    await withDb(async (db) => {
      const issueId = crypto.randomUUID();
      const otherIssueId = crypto.randomUUID();

      // No rows = open to everyone.
      expect(hasIssueAccess(db, issueId, "user-x", [])).toBe(true);
      expect(hiddenIssueIds(db, "user-x", [])).toEqual([]);

      // A direct grant restricts the issue to the listed actor.
      setIssuePermission(db, WORKSPACE_ID, issueId, "user-a", "user");
      expect(hasIssueAccess(db, issueId, "user-a", [])).toBe(true);
      expect(hasIssueAccess(db, issueId, "user-x", [])).toBe(false);
      expect(hiddenIssueIds(db, "user-x", [])).toEqual([issueId]);
      expect(hiddenIssueIds(db, "user-a", [])).toEqual([]);

      // A team grant covers every member of that team.
      setIssuePermission(db, WORKSPACE_ID, issueId, "team-1", "team");
      expect(hasIssueAccess(db, issueId, "user-x", ["team-1"])).toBe(true);
      expect(hasIssueAccess(db, issueId, "user-x", ["team-2"])).toBe(false);
      expect(hiddenIssueIds(db, "user-x", ["team-1"])).toEqual([]);

      // Grants on one issue don't leak to another.
      expect(hasIssueAccess(db, otherIssueId, "user-x", [])).toBe(true);

      // setIssuePermission upserts on (issue, actor) — no duplicate rows.
      setIssuePermission(db, WORKSPACE_ID, issueId, "user-a", "user");
      expect(listIssuePermissions(db, issueId)).toHaveLength(2);

      // Revoking all grants reopens the issue.
      expect(revokeIssuePermission(db, issueId, "user-a")).toBe(true);
      expect(revokeIssuePermission(db, issueId, "team-1")).toBe(true);
      expect(revokeIssuePermission(db, issueId, "user-a")).toBe(false);
      expect(hasIssueAccess(db, issueId, "user-x", [])).toBe(true);
      expect(hiddenIssueIds(db, "user-x", [])).toEqual([]);
    });
  });
});

describe("document links", () => {
  it("replaceDocumentLinks chunks inserts past the ~100 variable cap", () => {
    return withDb((db) => {
      const documentId = crypto.randomUUID();
      // 40 links × 6 params = 240 binds — a single insert throws over ~100.
      const links = Array.from({ length: 40 }, (_, i) => ({
        targetType: "issue",
        targetId: `issue-${i}`,
      }));
      replaceDocumentLinks(db, WORKSPACE_ID, documentId, links);
      expect(listDocumentLinks(db, WORKSPACE_ID, { documentId })).toHaveLength(
        40
      );
    });
  });
});

describe("listDocumentsVisibleTo", () => {
  it("returns open docs plus docs the actor is granted on", async () => {
    await withDb(async (db) => {
      const org = `vis-${crypto.randomUUID()}`;
      createDocument(db, {
        organizationId: org,
        title: "open",
        createdById: "owner-1",
      });
      const restricted = createDocument(db, {
        organizationId: org,
        title: "restricted",
        createdById: "owner-1",
      });
      setDocumentPermission(
        db,
        org,
        restricted.id,
        "someone-else",
        "user",
        "edit"
      );

      const rows = listDocumentsVisibleTo(db, org, "member-1", []);
      const titles = rows.map((d) => d.title);
      expect(titles).toContain("open");
      expect(titles).not.toContain("restricted");

      // granted actor sees it
      setDocumentPermission(db, org, restricted.id, "member-1", "user", "view");
      const granted = listDocumentsVisibleTo(db, org, "member-1", []);
      expect(granted.map((d) => d.title)).toContain("restricted");
    });
  });
});

describe("restricted document spaces (PILE-409)", () => {
  it("hides restricted-space docs from ungranted actors in list + access check", async () => {
    await withDb(async (db) => {
      const org = `space-${crypto.randomUUID()}`;
      const space = createDocumentSpace(db, org, {
        name: "Leadership",
        restricted: true,
        createdById: "owner-1",
      });
      const hidden = createDocument(db, {
        organizationId: org,
        title: "ceo-notes",
        createdById: "owner-1",
      });
      updateDocument(db, org, hidden.id, { spaceId: space.id }, "owner-1");
      createDocument(db, {
        organizationId: org,
        title: "open-doc",
        createdById: "owner-1",
      });

      // Ungranted member: restricted-space doc invisible, no access level.
      const rows = listDocumentsVisibleTo(db, org, "member-1", []);
      expect(rows.map((d) => d.title)).toContain("open-doc");
      expect(rows.map((d) => d.title)).not.toContain("ceo-notes");
      expect(documentAccessLevel(db, hidden.id, "member-1", [])).toBeNull();

      // Granted actor sees it.
      setDocumentPermission(db, org, hidden.id, "member-1", "user", "view");
      expect(
        listDocumentsVisibleTo(db, org, "member-1", []).map((d) => d.title)
      ).toContain("ceo-notes");
      expect(documentAccessLevel(db, hidden.id, "member-1", [])).toBe("view");

      // Unrestricting the space reopens the doc.
      updateDocumentSpace(db, org, space.id, { restricted: false });
      expect(documentAccessLevel(db, hidden.id, "member-1", [])).not.toBeNull();
    });
  });
});

describe("grantedOnly issue visibility", () => {
  it("hides ungranted issues from default-deny actors", async () => {
    await withDb(async (db) => {
      const org = `go-${crypto.randomUUID()}`;
      const mk = (title: string) => {
        const id = crypto.randomUUID();
        db.insert(workspaceIssues)
          .values({
            id,
            organizationId: org,
            teamId: "team-1",
            title,
            status: "triage",
            priority: "medium",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .run();
        return { id };
      };
      const open = mk("open issue");
      const restricted = mk("restricted issue");
      setIssuePermission(db, org, restricted.id, "someone-else", "user");
      const mine = mk("my issue");
      setIssuePermission(db, org, mine.id, "contractor-1", "user");

      // grantedOnly: only `mine` is visible — open issues are hidden too.
      const hidden = new Set(hiddenIssueIds(db, "contractor-1", [], true));
      expect(hidden.has(open.id)).toBe(true);
      expect(hidden.has(restricted.id)).toBe(true);
      expect(hidden.has(mine.id)).toBe(false);

      // non-grantedOnly (normal member): only the restricted one is hidden.
      const memberHidden = new Set(hiddenIssueIds(db, "member-1", []));
      expect(memberHidden.has(restricted.id)).toBe(true);
      expect(memberHidden.has(open.id)).toBe(false);

      // direct access — unrestricted issue stays open for members but
      // not for default-deny actors.
      expect(hasIssueAccess(db, open.id, "member-1")).toBe(true);
      expect(hasIssueAccess(db, open.id, "contractor-1", [], true)).toBe(false);
      expect(hasIssueAccess(db, mine.id, "contractor-1", [], true)).toBe(true);
    });
  });
});

describe("hiddenIssueCondition", () => {
  it("grantedOnly keeps only grant-matched issues", async () => {
    await withDb(async (db) => {
      const org = `hc-${crypto.randomUUID()}`;
      const mk = (title: string) => {
        const id = crypto.randomUUID();
        db.insert(workspaceIssues)
          .values({
            id,
            organizationId: org,
            teamId: "team-1",
            title,
            status: "triage",
            priority: "medium",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .run();
        return { id };
      };
      const open = mk("open");
      const mine = mk("mine");
      setIssuePermission(db, org, mine.id, "u-9", "user");

      // hiddenIssueCondition returns a visibility predicate only — callers
      // still scope by org. These manual queries must do the same or they
      // see sibling tests' rows in the shared DO store.
      const cond = hiddenIssueCondition(
        db,
        workspaceIssues.id,
        "u-9",
        [],
        true
      );
      const visible = await db
        .select({ id: workspaceIssues.id })
        .from(workspaceIssues)
        .where(and(cond, eq(workspaceIssues.organizationId, org)))
        .all();
      expect(visible.map((r) => r.id)).toEqual([mine.id]);

      const cond2 = hiddenIssueCondition(
        db,
        workspaceIssues.id,
        "u-9",
        [],
        false
      );
      const visible2 = await db
        .select({ id: workspaceIssues.id })
        .from(workspaceIssues)
        .where(and(cond2, eq(workspaceIssues.organizationId, org)))
        .all();
      expect(new Set(visible2.map((r) => r.id))).toEqual(
        new Set([open.id, mine.id])
      );
    });
  });
});

describe("pipeline record hygiene + externalId dedupe", () => {
  beforeAll(async () => {
    await getStub().listWorkspaceComments();
  });

  it("createCustomer is idempotent on externalId", async () => {
    await withDb(async (db) => {
      const first = await createCustomer(db, {
        organizationId: WORKSPACE_ID,
        name: "First",
        externalId: "gplace:c-1",
        nextStepText: "visit",
        needsHuman: true,
        priorityScore: 55,
      });
      const replay = await createCustomer(db, {
        organizationId: WORKSPACE_ID,
        name: "Second name ignored",
        externalId: "gplace:c-1",
      });
      expect(replay.id).toBe(first.id);
      expect(replay.name).toBe("First");
      expect(
        await getCustomerByExternalId(db, WORKSPACE_ID, "gplace:c-1")
      ).toMatchObject({ id: first.id });
      // externalId is scoped per workspace — the same key in another org
      // must not collide.
      const other = await createCustomer(db, {
        organizationId: "other-workspace",
        name: "Other org same key",
        externalId: "gplace:c-1",
      });
      expect(other.id).not.toBe(first.id);
    });
  });

  it("createDeal is idempotent on externalId and stores hygiene fields", async () => {
    await withDb(async (db) => {
      const customer = await createCustomer(db, {
        organizationId: WORKSPACE_ID,
        name: "Deal holder",
      });
      const first = await createDeal(db, {
        organizationId: WORKSPACE_ID,
        customerId: customer.id,
        name: "Import deal",
        stage: "lead",
        externalId: "gplace:d-1",
        nextStepText: "pitch",
        nextStepDueAt: "2026-10-20T00:00:00.000Z",
        priorityScore: 12.5,
      });
      const replay = await createDeal(db, {
        organizationId: WORKSPACE_ID,
        customerId: customer.id,
        name: "Duplicate name",
        stage: "proposal",
        externalId: "gplace:d-1",
      });
      expect(replay.id).toBe(first.id);
      expect(replay.stage).toBe("lead");
      expect(
        await getDealByExternalId(db, WORKSPACE_ID, "gplace:d-1")
      ).toMatchObject({ id: first.id, nextStepText: "pitch" });
    });
  });

  it("cold/dueBefore/needsHuman filters drive the sweep views", async () => {
    await withDb(async (db) => {
      const org = "filter-org";
      await createCustomer(db, {
        organizationId: org,
        name: "Cold one",
      });
      const warm = await createCustomer(db, {
        organizationId: org,
        name: "Warm",
        nextStepDueAt: "2026-10-18T00:00:00.000Z",
      });
      const escalated = await createCustomer(db, {
        organizationId: org,
        name: "Escalated",
        needsHuman: true,
        nextStepText: "x",
      });

      const coldIds = (await listCustomers(db, org, { cold: true })).map(
        (c) => c.id
      );
      expect(coldIds).not.toContain(warm.id);
      expect(coldIds).not.toContain(escalated.id);

      const due = (
        await listCustomers(db, org, { dueBefore: "2026-10-25T00:00:00.000Z" })
      ).map((c) => c.id);
      expect(due).toEqual([warm.id]);

      const human = (await listCustomers(db, org, { needsHuman: true })).map(
        (c) => c.id
      );
      expect(human).toEqual([escalated.id]);

      const customer = await createCustomer(db, {
        organizationId: org,
        name: "Holder",
      });
      const open = await createDeal(db, {
        organizationId: org,
        customerId: customer.id,
        name: "Open no step",
        stage: "lead",
      });
      const won = await createDeal(db, {
        organizationId: org,
        customerId: customer.id,
        name: "Won no step",
        stage: "won",
      });
      const working = await createDeal(db, {
        organizationId: org,
        customerId: customer.id,
        name: "Working",
        stage: "qualified",
        nextStepDueAt: "2026-10-19T00:00:00.000Z",
      });

      const coldDeals = (await listDeals(db, org, { cold: true })).map(
        (d) => d.id
      );
      expect(coldDeals).toContain(open.id);
      // A closed deal without a next step is not a cold lead.
      expect(coldDeals).not.toContain(won.id);
      expect(coldDeals).not.toContain(working.id);

      const dueDeals = (
        await listDeals(db, org, {
          stage: "qualified",
          dueBefore: "2026-10-25T00:00:00.000Z",
        })
      ).map((d) => d.id);
      expect(dueDeals).toEqual([working.id]);
    });
  });
});
