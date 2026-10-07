import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { beforeAll, describe, expect, it } from "vitest";

import type { WorkerEnv } from "../../platform/middleware.js";
import type { WorkspaceDO } from "../durable-object.js";
import { workspaceSchema } from "../schema-map.js";
import {
  type AgentSessionInput,
  createAgentSession,
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
  listEntityAttachments,
  listCustomerIntakeItems,
  listCustomers,
  reanchorQueuedDependents,
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
