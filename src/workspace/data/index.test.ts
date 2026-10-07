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
  getAgentSession,
  getEntityAttachment,
  getNotificationPreferences,
  listEntityAttachments,
  reanchorQueuedDependents,
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
      // issue_assigned/mention lives in the DO for users with no row.
      expect(row?.inApp).toBe(true);
      expect(row?.email).toBe(false);
      expect(row?.webhook).toBe(true);

      // Explicit choices persist and mutedTypes round-trips.
      await upsertNotificationPreferences(db, WORKSPACE_ID, "nobody", {
        email: true,
        mutedTypes: ["issue_updated"],
      });
      const updated = getNotificationPreferences(db, WORKSPACE_ID, "nobody");
      expect(updated?.email).toBe(true);
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
