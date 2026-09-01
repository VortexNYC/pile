import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { WorkerEnv } from "../api/middleware.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

describe("WorkspaceDO", () => {
  function getStub() {
    const id = env.WORKSPACE_DURABLE_OBJECT.idFromName("test-workspace");
    return env.WORKSPACE_DURABLE_OBJECT.get(id);
  }

  it("creates and lists issues", async () => {
    const stub = getStub();
    const issue = await runInDurableObject(stub, (instance) =>
      instance.createIssue({ title: "Test issue" })
    );
    expect(issue.title).toBe("Test issue");
    expect(issue.status).toBe("backlog");
    expect(issue.priority).toBe("medium");

    const issues = await runInDurableObject(stub, (instance) =>
      instance.listIssues()
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].id).toBe(issue.id);
  });

  it("gets an issue by id", async () => {
    const stub = getStub();
    const created = await runInDurableObject(stub, (instance) =>
      instance.createIssue({ title: "Get me" })
    );
    const got = await runInDurableObject(stub, (instance) =>
      instance.getIssue(created.id)
    );
    expect(got?.id).toBe(created.id);
  });

  it("updates an issue", async () => {
    const stub = getStub();
    const created = await runInDurableObject(stub, (instance) =>
      instance.createIssue({ title: "Update me" })
    );
    const updated = await runInDurableObject(stub, (instance) =>
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
    await runInDurableObject(stub, (instance) =>
      instance.createIssue({
        title: "PR issue",
        repo: "owner/repo",
        branch: "feature",
      })
    );
    const updated = await runInDurableObject(stub, (instance) =>
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
