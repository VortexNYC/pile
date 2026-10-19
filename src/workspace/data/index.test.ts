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
  createGuidancePack,
  buildStepContext,
  createDeal,
  createFieldDefinition,
  createExternalEventMapping,
  createStageTemplate,
  deleteExternalEventMapping,
  deleteStageTemplate,
  evaluateStepCondition,
  getStageTemplate,
  linkEntities,
  listLinkedIssueIds,
  listStageTemplatesForStatus,
  seedStageTemplates,
  setFieldValue,
  setFieldValuesByName,
  customFieldMap,
  listFieldDefinitions,
  FieldValueError,
  importCustomers,
  getImportReceipt,
  listImportReceipts,
  stageKey,
  updateStageTemplate,
  createTriageRule,
  getTriageRule,
  listTriageRules,
  updateTriageRule,
  deleteTriageRule,
  recordTriageEvaluation,
  listTriageEvaluations,
  createDocument,
  createDocumentSpace,
  documentAccessLevel,
  extractEventField,
  getCustomerByExternalId,
  getDealByExternalId,
  getExternalEventDeliveryByDedupeKey,
  getExternalEventMapping,
  insertExternalEventDelivery,
  listExternalEventDeliveries,
  listExternalEventMappings,
  listDeals,
  listDocumentsVisibleTo,
  setDocumentPermission,
  updateDocument,
  updateDocumentSpace,
  createCustomer,
  createEntityAttachment,
  deleteCustomer,
  deleteEntityAttachment,
  deleteGuidancePack,
  getGuidancePack,
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
  listGuidancePackVersions,
  reanchorQueuedDependents,
  replaceDocumentLinks,
  resolveGuidancePacks,
  resolvePayloadPath,
  resolveCustomerForEmail,
  countAgentSessionsSince,
  deleteAgentSpendCap,
  getAgentSpendCap,
  listRunReceipts,
  markAgentSpendCapAlerted,
  resolveAgentSpendCap,
  summarizeRunReceipts,
  sumRunReceipts,
  updateAgentSession,
  createExternalLink,
  getExternalLink,
  updateExternalLink,
  updateExternalEventDelivery,
  updateExternalEventMapping,
  updateGuidancePack,
  upsertAgentSpendCap,
  upsertNotificationPreferences,
  upsertRunReceipt,
  type NotificationType,
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

  it("persists and clears the plan checklist column (PILE-426)", async () => {
    await withDb(async (db) => {
      const session = await createAgentSession(
        db,
        sessionInput({ status: "running" })
      );
      expect(session.plan).toBeNull();

      const plan = JSON.stringify([
        { content: "Read issue", status: "completed" },
        { content: "Write fix", status: "inProgress" },
      ]);
      await updateAgentSession(db, WORKSPACE_ID, session.id, { plan });
      expect((await getAgentSession(db, WORKSPACE_ID, session.id))?.plan).toBe(
        plan
      );

      // Whole-array replace — and null clears a published plan.
      await updateAgentSession(db, WORKSPACE_ID, session.id, {
        plan: JSON.stringify([{ content: "Ship it", status: "pending" }]),
      });
      expect(
        JSON.parse(
          (await getAgentSession(db, WORKSPACE_ID, session.id))?.plan ?? "null"
        )
      ).toEqual([{ content: "Ship it", status: "pending" }]);
      await updateAgentSession(db, WORKSPACE_ID, session.id, { plan: null });
      expect(
        (await getAgentSession(db, WORKSPACE_ID, session.id))?.plan
      ).toBeNull();
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

describe("guidance packs (PILE-423)", () => {
  it("creates, versions, and resolves packs least-specific first", async () => {
    await withDb(async (db) => {
      const org = WORKSPACE_ID;
      const teamId = "team-x";
      const ws = await createGuidancePack(db, {
        organizationId: org,
        name: "Workspace rules",
        scope: "workspace",
        body: "Be terse.",
      });
      expect(ws.version).toBe(1);
      expect(ws.scopeKey).toBeNull();

      const team = await createGuidancePack(db, {
        organizationId: org,
        name: "Team rules",
        scope: "team",
        scopeKey: teamId,
        body: "Prefer pnpm.",
      });
      const status = await createGuidancePack(db, {
        organizationId: org,
        name: "Outreach",
        scope: "status",
        scopeKey: "in_progress",
        body: "No rate numbers.",
      });
      const step = await createGuidancePack(db, {
        organizationId: org,
        name: "Contacted step",
        scope: "step",
        scopeKey: "contacted",
        body: "Human approves.",
      });
      // Non-matching packs stay out of resolution.
      await createGuidancePack(db, {
        organizationId: org,
        name: "Other team",
        scope: "team",
        scopeKey: "team-other",
        body: "irrelevant",
      });
      await createGuidancePack(db, {
        organizationId: org,
        name: "Other status",
        scope: "status",
        scopeKey: "done",
        body: "irrelevant",
      });

      const resolved = await resolveGuidancePacks(db, org, {
        teamId,
        status: "in_progress",
        stepKey: "contacted",
      });
      expect(resolved.map((p) => p.id)).toEqual([
        ws.id,
        team.id,
        status.id,
        step.id,
      ]);

      // Edits bump version and snapshot the revision.
      const updated = await updateGuidancePack(
        db,
        org,
        status.id,
        { body: "No rate or savings numbers." },
        "user-1"
      );
      expect(updated?.version).toBe(2);
      expect(updated?.body).toBe("No rate or savings numbers.");
      const versions = listGuidancePackVersions(db, org, status.id);
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
      expect(versions[0]?.body).toBe("No rate numbers.");
      expect(versions[1]?.body).toBe("No rate or savings numbers.");

      // Delete keeps the version history for sessions that ran with it.
      expect(await deleteGuidancePack(db, org, ws.id)).toBe(true);
      expect(await getGuidancePack(db, org, ws.id)).toBeUndefined();
      expect(listGuidancePackVersions(db, org, ws.id)).toHaveLength(1);
      expect(await deleteGuidancePack(db, org, ws.id)).toBe(false);
    });
  });

  it("persists stepKey and guidance refs on agent sessions", async () => {
    await withDb(async (db) => {
      const org = WORKSPACE_ID;
      const session = await createAgentSession(
        db,
        sessionInput({ stepKey: "contacted" })
      );
      expect(session.stepKey).toBe("contacted");
      const refs = JSON.stringify([
        {
          id: "p1",
          name: "P",
          scope: "step",
          scopeKey: "contacted",
          version: 2,
        },
      ]);
      const updated = await updateAgentSession(db, org, session.id, {
        guidance: refs,
      });
      expect(updated?.guidance).toBe(refs);
    });
  });
});

// ---- PILE-411 — stage templates ----

describe("stageKey", () => {
  it("slug-normalizes stage and step names to one key", () => {
    expect(stageKey("Prospect")).toBe("prospect");
    expect(stageKey(" Application & underwriting ")).toBe(
      "application_underwriting"
    );
    expect(stageKey("Onboarding & go-live")).toBe("onboarding_go_live");
    expect(stageKey("in_progress")).toBe("in_progress");
  });
});

describe("evaluateStepCondition", () => {
  const context = {
    hardwareneeded: "yes",
    plan: "pro",
    empty: "",
    zero: 0,
  };

  it("passes unconditionally when there is no rule", () => {
    expect(evaluateStepCondition(null, context)).toBe(true);
    expect(evaluateStepCondition("", context)).toBe(true);
  });

  it("truthy-checks the field, normalizing the field name", () => {
    expect(
      evaluateStepCondition(
        JSON.stringify({ field: "Hardware needed" }),
        context
      )
    ).toBe(true);
    expect(
      evaluateStepCondition(JSON.stringify({ field: "missing" }), context)
    ).toBe(false);
    expect(
      evaluateStepCondition(JSON.stringify({ field: "empty" }), context)
    ).toBe(false);
    expect(
      evaluateStepCondition(JSON.stringify({ field: "zero" }), context)
    ).toBe(false);
  });

  it("compares `equals` against the stored value", () => {
    expect(
      evaluateStepCondition(
        JSON.stringify({ field: "plan", equals: "pro" }),
        context
      )
    ).toBe(true);
    expect(
      evaluateStepCondition(
        JSON.stringify({ field: "plan", equals: "enterprise" }),
        context
      )
    ).toBe(false);
    expect(
      evaluateStepCondition(
        JSON.stringify({ field: "missing", equals: true }),
        context
      )
    ).toBe(false);
  });

  it("fails closed on malformed rules", () => {
    expect(evaluateStepCondition("not json", context)).toBe(false);
    expect(evaluateStepCondition(JSON.stringify("nope"), context)).toBe(false);
    expect(evaluateStepCondition(JSON.stringify({}), context)).toBe(false);
  });
});

describe("stage template data layer", () => {
  it("CRUDs with normalized status/step keys", async () => {
    await withDb((db) => {
      const template = createStageTemplate(db, {
        organizationId: WORKSPACE_ID,
        entityType: "issue",
        status: "In Progress",
        stepKey: "Design Review",
        title: "Design review",
        required: true,
        ownerAgent: "reviewer",
        condition: { field: "has_design" },
        position: 2,
      });
      expect(template.status).toBe("in_progress");
      expect(template.stepKey).toBe("design_review");
      expect(template.condition).toBe(JSON.stringify({ field: "has_design" }));

      expect(getStageTemplate(db, WORKSPACE_ID, template.id)?.title).toBe(
        "Design review"
      );
      expect(
        listStageTemplatesForStatus(
          db,
          WORKSPACE_ID,
          "issue",
          "in progress"
        ).map((t) => t.id)
      ).toEqual([template.id]);

      const patched = updateStageTemplate(db, WORKSPACE_ID, template.id, {
        title: "Design review v2",
        required: false,
        ownerAgent: null,
      });
      expect(patched?.title).toBe("Design review v2");
      expect(patched?.required).toBe(false);
      expect(patched?.ownerAgent).toBeNull();

      expect(deleteStageTemplate(db, WORKSPACE_ID, template.id)).toBe(true);
      expect(getStageTemplate(db, WORKSPACE_ID, template.id)).toBeUndefined();
      expect(deleteStageTemplate(db, WORKSPACE_ID, template.id)).toBe(false);
    });
  });

  it("enforces unique (org, entity, status, step) pairs", async () => {
    await withDb((db) => {
      createStageTemplate(db, {
        organizationId: WORKSPACE_ID,
        entityType: "issue",
        status: "backlog",
        stepKey: "triage",
        title: "Triage",
      });
      expect(() =>
        createStageTemplate(db, {
          organizationId: WORKSPACE_ID,
          entityType: "issue",
          status: "Backlog",
          stepKey: "Triage",
          title: "Duplicate",
        })
      ).toThrow();
    });
  });

  it("seeds the seven pipeline stages idempotently", async () => {
    await withDb((db) => {
      const first = seedStageTemplates(db, WORKSPACE_ID);
      expect(first.created.length).toBe(22);
      expect(first.skipped).toBe(0);
      const statuses = new Set(first.created.map((t) => t.status));
      expect(statuses.size).toBe(7);
      expect(statuses.has("prospect")).toBe(true);
      expect(statuses.has("onboarding_go_live")).toBe(true);
      // Every seed hangs on the customer record — the merchant's stage is
      // its customer status.
      expect(first.created.every((t) => t.entityType === "customer")).toBe(
        true
      );
      // Hardware shipped is optional and gated on hardware_needed.
      const hardware = first.created.find(
        (t) => t.stepKey === "hardware_shipped"
      );
      expect(hardware?.required).toBe(false);
      expect(hardware?.condition).toBe(
        JSON.stringify({ field: "hardware_needed" })
      );

      // Operator edits survive a re-seed; deleted rows come back.
      const seeded = seedStageTemplates(db, WORKSPACE_ID);
      expect(seeded.created.length).toBe(0);
      expect(seeded.skipped).toBe(22);
      deleteStageTemplate(db, WORKSPACE_ID, first.created[0]!.id);
      const again = seedStageTemplates(db, WORKSPACE_ID);
      expect(again.created.length).toBe(1);
      expect(again.skipped).toBe(21);
    });
  });

  it("buildStepContext folds custom field values in by normalized name", async () => {
    await withDb((db) => {
      const entityId = crypto.randomUUID();
      const field = createFieldDefinition(db, {
        organizationId: WORKSPACE_ID,
        entityType: "customer",
        name: "Hardware needed",
        type: "boolean",
      });
      setFieldValue(db, WORKSPACE_ID, field.id, entityId, "true");
      const context = buildStepContext(db, WORKSPACE_ID, "customer", entityId, {
        name: "Acme",
        statusId: "s1",
      });
      expect(context["name"]).toBe("Acme");
      expect(context["hardwareneeded"]).toBe("true");
      expect(
        evaluateStepCondition(
          JSON.stringify({ field: "hardware_needed" }),
          context
        )
      ).toBe(true);
    });
  });

  it("listLinkedIssueIds finds issues on either side of the link", async () => {
    await withDb((db) => {
      const customerId = crypto.randomUUID();
      const issueId = crypto.randomUUID();
      linkEntities(db, {
        organizationId: WORKSPACE_ID,
        fromType: "customer",
        fromId: customerId,
        toType: "issue",
        toId: issueId,
      });
      expect(
        listLinkedIssueIds(db, WORKSPACE_ID, "customer", customerId)
      ).toEqual([issueId]);
      expect(
        listLinkedIssueIds(db, WORKSPACE_ID, "customer", crypto.randomUUID())
      ).toEqual([]);
    });
  });
});

describe("external event data (PILE-422)", () => {
  it("CRUDs mappings with slug-normalized source and stepKey", async () => {
    await withDb(async (db) => {
      const mapping = createExternalEventMapping(db, {
        organizationId: WORKSPACE_ID,
        source: "Finix",
        eventType: "merchant.approved",
        entityType: "deal",
        matchPath: "data.entity_id",
        stepKey: "Approved",
        secret: "whsec_test",
      });
      expect(mapping.source).toBe("finix");
      expect(mapping.stepKey).toBe("approved");
      // Provider event names are literals — never normalized.
      expect(mapping.eventType).toBe("merchant.approved");
      expect(mapping.enabled).toBe(true);

      const listed = listExternalEventMappings(db, WORKSPACE_ID, {
        source: "finix",
      });
      expect(listed.map((m) => m.id)).toContain(mapping.id);
      expect(
        getExternalEventMapping(db, WORKSPACE_ID, mapping.id)?.matchPath
      ).toBe("data.entity_id");

      const patched = updateExternalEventMapping(db, WORKSPACE_ID, mapping.id, {
        matchPath: "data.merchant.id",
        enabled: false,
      });
      expect(patched?.matchPath).toBe("data.merchant.id");
      expect(
        listExternalEventMappings(db, WORKSPACE_ID, {
          source: "finix",
          enabledOnly: true,
        })
      ).toHaveLength(0);

      expect(deleteExternalEventMapping(db, WORKSPACE_ID, mapping.id)).toBe(
        true
      );
      expect(
        getExternalEventMapping(db, WORKSPACE_ID, mapping.id)
      ).toBeUndefined();
    });
  });

  it("dedupes deliveries on (org, source, dedupeKey) and finalizes rows", async () => {
    await withDb(async (db) => {
      const first = insertExternalEventDelivery(db, {
        organizationId: WORKSPACE_ID,
        source: "finix",
        eventType: "merchant.approved",
        eventId: "evt_1",
        dedupeKey: "evt_1",
        status: "processing",
        payload: "{}",
      });
      expect(first).toBeDefined();
      // Same dedupe key — the insert loses and returns undefined.
      const dupe = insertExternalEventDelivery(db, {
        organizationId: WORKSPACE_ID,
        source: "finix",
        dedupeKey: "evt_1",
        status: "processing",
      });
      expect(dupe).toBeUndefined();
      // A different source can reuse the same event id.
      const otherSource = insertExternalEventDelivery(db, {
        organizationId: WORKSPACE_ID,
        source: "seal",
        dedupeKey: "evt_1",
        status: "processing",
      });
      expect(otherSource).toBeDefined();

      const finalized = updateExternalEventDelivery(
        db,
        WORKSPACE_ID,
        first!.id,
        {
          status: "applied",
          entityType: "deal",
          entityId: "deal-1",
          completedIssueIds: ["i-1", "i-2"],
        }
      );
      expect(finalized?.status).toBe("applied");
      expect(JSON.parse(finalized!.completedIssueIds!)).toEqual(["i-1", "i-2"]);
      expect(
        getExternalEventDeliveryByDedupeKey(db, WORKSPACE_ID, "finix", "evt_1")
          ?.status
      ).toBe("applied");

      const deliveries = listExternalEventDeliveries(db, WORKSPACE_ID, {
        source: "finix",
      });
      expect(deliveries).toHaveLength(1);
      expect(
        listExternalEventDeliveries(db, WORKSPACE_ID, {
          status: "processing",
        }).map((d) => d.source)
      ).toEqual(["seal"]);
    });
  });

  it("resolves payload paths through objects and array indexes", () => {
    const payload = {
      type: "merchant.updated",
      data: {
        entity: { id: "mu_123" },
        transfers: [{ id: "t_1" }],
        count: 3,
      },
    };
    expect(resolvePayloadPath(payload, "data.entity.id")).toBe("mu_123");
    expect(resolvePayloadPath(payload, "data.transfers.0.id")).toBe("t_1");
    expect(resolvePayloadPath(payload, "data.count")).toBe("3");
    expect(resolvePayloadPath(payload, "data.missing")).toBeNull();
    expect(resolvePayloadPath(payload, "data.entity.id.deeper")).toBeNull();
    expect(resolvePayloadPath(null, "data.id")).toBeNull();
    // Non-scalar terminals don't resolve.
    expect(resolvePayloadPath(payload, "data.entity")).toBeNull();
  });

  it("extracts the event type and id across provider envelope spellings", () => {
    expect(
      extractEventField({ type: "merchant.approved" }, ["type", "event_type"])
    ).toBe("merchant.approved");
    expect(
      extractEventField({ event_type: "signed" }, ["type", "event_type"])
    ).toBe("signed");
    expect(extractEventField({ event: "delivered" }, ["type", "event"])).toBe(
      "delivered"
    );
    expect(extractEventField({ id: "evt_9" }, ["id", "event_id"])).toBe(
      "evt_9"
    );
    expect(extractEventField("nope", ["type"])).toBeNull();
    expect(extractEventField({}, ["type"])).toBeNull();
  });
});

describe("spend caps + run receipts (PILE-425)", () => {
  it("resolves the agent's own row before the workspace default", async () => {
    await withDb(async (db) => {
      const org = WORKSPACE_ID;
      const agentId = `caps-${crypto.randomUUID()}`;
      await upsertAgentSpendCap(db, org, "*", {
        maxTokensPerDay: 1_000_000,
      });
      expect((await resolveAgentSpendCap(db, org, agentId))?.agentId).toBe("*");
      await upsertAgentSpendCap(db, org, agentId, {
        maxTokensPerDay: 5_000,
      });
      const resolved = await resolveAgentSpendCap(db, org, agentId);
      expect(resolved?.agentId).toBe(agentId);
      expect(resolved?.maxTokensPerDay).toBe(5_000);
      await deleteAgentSpendCap(db, org, agentId);
      expect(await getAgentSpendCap(db, org, agentId)).toBeUndefined();
    });
  });

  it("upserts caps fields individually — omitted limits keep their value", async () => {
    await withDb(async (db) => {
      const org = WORKSPACE_ID;
      const agentId = `caps-patch-${crypto.randomUUID()}`;
      await upsertAgentSpendCap(db, org, agentId, {
        maxRunsPerDay: 5,
        maxTokensPerDay: 1000,
      });
      await upsertAgentSpendCap(db, org, agentId, {
        maxRunsPerDay: 10,
      });
      let row = await getAgentSpendCap(db, org, agentId);
      expect(row?.maxRunsPerDay).toBe(10);
      expect(row?.maxTokensPerDay).toBe(1000);
      // Explicit null clears a limit.
      await upsertAgentSpendCap(db, org, agentId, {
        maxTokensPerDay: null,
      });
      row = await getAgentSpendCap(db, org, agentId);
      expect(row?.maxTokensPerDay).toBeNull();
      expect(row?.maxRunsPerDay).toBe(10);
    });
  });

  it("stamps the resolved caps row when the alert is claimed", async () => {
    await withDb(async (db) => {
      const org = WORKSPACE_ID;
      const agentId = `caps-alert-${crypto.randomUUID()}`;
      // No row at all → nothing to stamp (fresh org: the suite's shared
      // workspace already has a "*" default from an earlier test).
      expect(
        await markAgentSpendCapAlerted(db, `${org}-nocap`, agentId)
      ).toBeUndefined();
      await upsertAgentSpendCap(db, org, agentId, { maxRunsPerDay: 1 });
      const stamped = await markAgentSpendCapAlerted(db, org, agentId);
      expect(stamped?.lastCapAlertAt).not.toBeNull();
    });
  });

  it("upserts one receipt per session and keeps unwritten fields", async () => {
    await withDb(async (db) => {
      const org = WORKSPACE_ID;
      const sessionId = crypto.randomUUID();
      await upsertRunReceipt(db, org, {
        sessionId,
        issueId: crypto.randomUUID(),
        agentId: "mock",
        status: "running",
        inputTokens: 100,
      });
      const updated = await upsertRunReceipt(db, org, {
        sessionId,
        issueId: crypto.randomUUID(),
        agentId: "mock",
        status: "completed",
        outputTokens: 40,
      });
      expect(updated?.inputTokens).toBe(100);
      expect(updated?.outputTokens).toBe(40);
      expect(updated?.status).toBe("completed");
      const all = listRunReceipts(db, org, { sessionId });
      expect(all).toHaveLength(1);
    });
  });

  it("sums window usage and counts sessions for cap evaluation", async () => {
    await withDb(async (db) => {
      const org = WORKSPACE_ID;
      const agentId = `caps-sums-${crypto.randomUUID()}`;
      const sessionA = await createAgentSession(
        db,
        sessionInput({ agentId, status: "completed" })
      );
      const sessionB = await createAgentSession(
        db,
        sessionInput({ agentId, status: "running" })
      );
      await upsertRunReceipt(db, org, {
        sessionId: sessionA.id,
        issueId: sessionA.issueId,
        agentId,
        inputTokens: 60,
        outputTokens: 40,
        totalTokens: 100,
        costMicros: 500,
        externalSpendMicros: 25,
      });
      await upsertRunReceipt(db, org, {
        sessionId: sessionB.id,
        issueId: sessionB.issueId,
        agentId,
        inputTokens: 30,
        outputTokens: 10,
        totalTokens: 40,
      });
      const since = "2000-01-01T00:00:00.000Z";
      const sums = await sumRunReceipts(db, org, { agentId, since });
      expect(sums.receipts).toBe(2);
      expect(sums.totalTokens).toBe(140);
      expect(sums.costMicros).toBe(500);
      expect(sums.externalSpendMicros).toBe(25);
      expect(await countAgentSessionsSince(db, org, agentId, since)).toBe(2);
      // A future bound excludes everything.
      expect(
        await countAgentSessionsSince(
          db,
          org,
          agentId,
          "2999-01-01T00:00:00.000Z"
        )
      ).toBe(0);
    });
  });

  it("aggregates receipts per agent, step, and deal", async () => {
    await withDb(async (db) => {
      const org = WORKSPACE_ID;
      const agentId = `caps-agg-${crypto.randomUUID()}`;
      const dealId = crypto.randomUUID();
      for (const [i, stepKey] of [
        "sourced",
        "sourced",
        "contacted",
      ].entries()) {
        await upsertRunReceipt(db, org, {
          sessionId: crypto.randomUUID(),
          issueId: crypto.randomUUID(),
          agentId,
          stepKey,
          dealId,
          totalTokens: 10 * (i + 1),
          costMicros: 100 * (i + 1),
          capExceeded: i === 2 ? 1 : 0,
        });
      }
      const byStep = await summarizeRunReceipts(db, org, {
        groupBy: "stepKey",
        agentId,
      });
      expect(byStep).toHaveLength(2);
      const sourced = byStep.find((r) => r.key === "sourced");
      expect(sourced?.runs).toBe(2);
      expect(sourced?.totalTokens).toBe(30);
      const contacted = byStep.find((r) => r.key === "contacted");
      expect(contacted?.capExceededRuns).toBe(1);
      const byDeal = await summarizeRunReceipts(db, org, {
        groupBy: "dealId",
        dealId,
      });
      expect(byDeal).toHaveLength(1);
      expect(byDeal[0]?.runs).toBe(3);
      expect(byDeal[0]?.costMicros).toBe(600);
    });
  });
});

describe("triage rules data (PILE-427)", () => {
  beforeAll(async () => {
    await getStub().listWorkspaceComments();
  });

  it("orders rules by sortOrder then createdAt and logs evaluations", async () => {
    await withDb(async (db) => {
      const second = createTriageRule(db, {
        organizationId: WORKSPACE_ID,
        name: "second",
        recordType: "lead",
        sortOrder: 1,
        conditions: "{}",
        action: "{}",
      });
      const first = createTriageRule(db, {
        organizationId: WORKSPACE_ID,
        name: "first",
        recordType: "lead",
        sortOrder: 0,
        conditions: "{}",
        action: "{}",
      });
      const inactive = createTriageRule(db, {
        organizationId: WORKSPACE_ID,
        name: "inactive",
        recordType: "lead",
        isActive: false,
        sortOrder: 2,
        conditions: "{}",
        action: "{}",
      });
      const other = createTriageRule(db, {
        organizationId: WORKSPACE_ID,
        name: "other type",
        recordType: "deal",
        conditions: "{}",
        action: "{}",
      });

      const all = listTriageRules(db, WORKSPACE_ID, { recordType: "lead" });
      expect(all.map((r) => r.id)).toEqual([first.id, second.id, inactive.id]);
      const active = listTriageRules(db, WORKSPACE_ID, {
        recordType: "lead",
        activeOnly: true,
      });
      expect(active.map((r) => r.id)).toEqual([first.id, second.id]);
      expect(getTriageRule(db, WORKSPACE_ID, other.id)?.name).toBe(
        "other type"
      );

      const renamed = updateTriageRule(db, WORKSPACE_ID, first.id, {
        name: "renamed",
        sortOrder: 9,
      });
      expect(renamed?.name).toBe("renamed");
      expect(
        listTriageRules(db, WORKSPACE_ID, { recordType: "lead" })[0]?.id
      ).toBe(second.id);

      const evalRow = recordTriageEvaluation(db, {
        organizationId: WORKSPACE_ID,
        recordType: "lead",
        recordId: "rec-1",
        ruleId: second.id,
        ruleName: second.name,
        outcome: "matched",
        detail: JSON.stringify({ issueId: "i-1" }),
      });
      expect(evalRow.outcome).toBe("matched");
      recordTriageEvaluation(db, {
        organizationId: WORKSPACE_ID,
        recordType: "lead",
        recordId: "rec-2",
        outcome: "no_match",
      });
      const evals = listTriageEvaluations(db, WORKSPACE_ID, {
        recordType: "lead",
        recordId: "rec-1",
      });
      expect(evals.map((e) => e.id)).toEqual([evalRow.id]);
      expect(
        listTriageEvaluations(db, WORKSPACE_ID, { ruleId: second.id })
      ).toHaveLength(1);

      expect(deleteTriageRule(db, WORKSPACE_ID, inactive.id)).toBe(true);
      expect(getTriageRule(db, WORKSPACE_ID, inactive.id)).toBeUndefined();
    });
  });
});

describe("external link verification (PILE-429)", () => {
  it("persists the probe result on create and re-writes it on update", async () => {
    await withDb(async (db) => {
      const created = await createExternalLink(db, WORKSPACE_ID, {
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
      });
      expect(created?.verificationStatus).toBe("verified");
      expect(created?.resolvedTitle).toBe("The Spec");
      expect(created?.httpStatus).toBe(200);

      // Default when no probe ran.
      const unprobed = await createExternalLink(db, WORKSPACE_ID, {
        entityType: "customer",
        entityId: crypto.randomUUID(),
        url: "ftp://example.com/file",
      });
      expect(unprobed?.verificationStatus).toBe("unchecked");
      expect(unprobed?.verifiedAt).toBeNull();

      const updated = await updateExternalLink(db, WORKSPACE_ID, created!.id, {
        url: "https://example.com/moved",
        verification: {
          status: "failed",
          verifiedAt: "2026-10-20T01:00:00.000Z",
          resolvedUrl: "https://example.com/moved",
          resolvedTitle: null,
          httpStatus: 404,
        },
      });
      expect(updated?.verificationStatus).toBe("failed");
      expect(updated?.httpStatus).toBe(404);
      expect(updated?.resolvedTitle).toBeNull();

      // A label-only update keeps the stored verification.
      const relabeled = await updateExternalLink(
        db,
        WORKSPACE_ID,
        created!.id,
        { label: "spec doc" }
      );
      expect(relabeled?.verificationStatus).toBe("failed");
      expect(relabeled?.httpStatus).toBe(404);

      const fetched = await getExternalLink(db, WORKSPACE_ID, created!.id);
      expect(fetched?.verificationStatus).toBe("failed");
    });
  });
});

describe("notification types (PILE-428)", () => {
  it("accepts draft_pending — the held-write alert the draft queue fires", () => {
    // Compile-time pin: removing "draft_pending" from the union breaks this
    // file, matching the notifyIssueEvent call on draft_output creation.
    const t: NotificationType = "draft_pending";
    expect(t).toBe("draft_pending");
  });
});

describe("custom fields by name + bulk import (PILE-383/403)", () => {
  beforeAll(async () => {
    await getStub().listWorkspaceComments();
  });

  it("setFieldValuesByName auto-creates missing definitions and validates typed ones", async () => {
    await withDb(async (db) => {
      const customer = await createCustomer(db, {
        organizationId: WORKSPACE_ID,
        name: "Field target",
      });
      setFieldValuesByName(db, WORKSPACE_ID, "customer", customer.id, {
        processor: "square",
      });
      expect(customFieldMap(db, WORKSPACE_ID, "customer", customer.id)).toEqual(
        { processor: "square" }
      );
      const defs = listFieldDefinitions(db, WORKSPACE_ID, "customer");
      expect(defs.find((d) => d.name === "processor")?.type).toBe("text");

      // A declared select field rejects out-of-options values.
      createFieldDefinition(db, {
        organizationId: WORKSPACE_ID,
        entityType: "customer",
        name: "size",
        type: "select",
        options: ["s", "m"],
      });
      expect(() =>
        setFieldValuesByName(db, WORKSPACE_ID, "customer", customer.id, {
          size: "xl",
        })
      ).toThrow(FieldValueError);
      setFieldValuesByName(db, WORKSPACE_ID, "customer", customer.id, {
        size: "m",
      });
      expect(
        customFieldMap(db, WORKSPACE_ID, "customer", customer.id).size
      ).toBe("m");

      // null clears a value.
      setFieldValuesByName(db, WORKSPACE_ID, "customer", customer.id, {
        size: null,
      });
      expect(
        customFieldMap(db, WORKSPACE_ID, "customer", customer.id).size
      ).toBeUndefined();
    });
  });

  it("importCustomers dedupes on gplace externalId and writes a receipt", async () => {
    await withDb(async (db) => {
      const first = importCustomers(db, WORKSPACE_ID, {
        source: "scout",
        corridor: "test-corridor",
        rows: [
          { placeId: "imp-1", name: "One", deal: {} },
          { placeId: "imp-2", name: "Two" },
        ],
      });
      expect(first).toMatchObject({
        source: "scout",
        corridor: "test-corridor",
        total: 2,
        created: 2,
        existing: 0,
        failed: 0,
      });
      expect(first.rows[0]?.externalId).toBe("gplace:imp-1");
      expect(first.rows[0]?.dealId).toBeTruthy();

      const replay = importCustomers(db, WORKSPACE_ID, {
        source: "scout",
        rows: [
          { placeId: "imp-1", name: "One", deal: {} },
          { placeId: "imp-2", name: "Two" },
        ],
      });
      expect(replay.created).toBe(0);
      expect(replay.existing).toBe(2);
      expect(replay.rows[0]?.customerId).toBe(first.rows[0]?.customerId);
      expect(replay.rows[0]?.dealId).toBe(first.rows[0]?.dealId);

      const stored = getImportReceipt(db, WORKSPACE_ID, first.id);
      expect(stored?.rows).toHaveLength(2);
      expect(listImportReceipts(db, WORKSPACE_ID).map((r) => r.id)).toContain(
        first.id
      );
    });
  });

  it("failed rows carry a reason and write nothing", async () => {
    await withDb(async (db) => {
      createFieldDefinition(db, {
        organizationId: WORKSPACE_ID,
        entityType: "customer",
        name: "tier_check",
        type: "number",
      });
      const receipt = importCustomers(db, WORKSPACE_ID, {
        rows: [
          { placeId: "good", name: "Fine" },
          {
            placeId: "bad",
            name: "Broken",
            customFields: { tier_check: "not-a-number" },
          },
        ],
      });
      expect(receipt.created).toBe(1);
      expect(receipt.failed).toBe(1);
      expect(receipt.rows[1]?.outcome).toBe("failed");
      expect(receipt.rows[1]?.error).toContain("tier_check");
      // Pre-validation ran before the write — no partial record.
      expect(
        getCustomerByExternalId(db, WORKSPACE_ID, "gplace:bad")
      ).toBeUndefined();
    });
  });
});

describe("CRM intake fns — suppression + market runs", () => {
  it("suppression upsert dedupes on kind+value", async () => {
    await withDb(async (db) => {
      const { upsertSuppression } = await import("./index.js");
      const a = upsertSuppression(db, WORKSPACE_ID, {
        kind: "domain",
        value: "spammy.example",
        reason: "junk lead",
      });
      const b = upsertSuppression(db, WORKSPACE_ID, {
        kind: "domain",
        value: "spammy.example",
      });
      expect(b.id).toBe(a.id);
    });
  });

  it("market run records a scout pull and patches counts", async () => {
    await withDb(async (db) => {
      const { createMarketRun, updateMarketRun } = await import("./index.js");
      const run = createMarketRun(db, WORKSPACE_ID, {
        vertical: "restaurants",
        geo: "nyc",
        source: "socrata",
      });
      expect(run.status).toBe("running");
      const done = updateMarketRun(db, WORKSPACE_ID, run.id, {
        producedCount: 42,
        status: "completed",
      });
      expect(done.producedCount).toBe(42);
      expect(done.completedAt).toBeTruthy();
    });
  });
});
