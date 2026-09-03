import { env, runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { workspaces } from "../global/schema.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { WorkspaceDO } from "./durable-object.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

const WORKSPACE_ID = "test-workspace";

async function ensureWorkspace() {
  const db = createD1(env.D1);
  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, WORKSPACE_ID))
    .get();
  if (existing) return;

  const now = new Date().toISOString();
  await db.insert(workspaces).values({
    id: WORKSPACE_ID,
    name: "Test workspace",
    slug: "test-workspace",
    ownerId: "user-1",
    createdAt: now,
    updatedAt: now,
  });
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
    await instance.setWorkspaceId(WORKSPACE_ID);
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

    const issues = await withWorkspace(stub, (instance) =>
      instance.listIssues()
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].id).toBe(issue.id);
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
});
