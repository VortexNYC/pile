import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { beforeAll, describe, expect, it } from "vitest";

import type { WorkerEnv } from "../../platform/middleware.js";
import type { WorkspaceDO } from "../durable-object.js";
import { workspaceSchema } from "../schema-map.js";
import {
  type AgentSessionInput,
  createAgentSession,
  getAgentSession,
  reanchorQueuedDependents,
  updateAgentSession,
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
