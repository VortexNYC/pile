import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { MockAgentProvider } from "./harness.js";
import { dispatchAgent, registerAgentProvider } from "./index.js";

const actor: WorkspaceIdentity = {
  id: "dispatch-test-user",
  organizationId: "",
  type: "user",
  permissions: ["write"],
};

/** A deployment env with no sandbox compute at all: no DAYTONA_API_KEY, no
 *  COMPUTE_PROVIDER, no SANDBOX_* / LANE bindings — computeBackend() throws
 *  CONFIG_ERROR on any of it. Remote API providers never touch compute. */
const noComputeEnv: WorkerEnv = {
  ...env,
  COMPUTE_PROVIDER: undefined,
  DAYTONA_API_KEY: undefined,
  DAYTONA_API_URL: undefined,
  DAYTONA_SNAPSHOT: undefined,
  DAYTONA_VOLUME_ID: undefined,
  SANDBOX: undefined,
  SANDBOX_CURSOR: undefined,
  SANDBOX_DEVIN: undefined,
  SANDBOX_CODEX: undefined,
  SANDBOX_LANE: undefined,
  SANDBOX_LANE_CURSOR: undefined,
  SANDBOX_LANE_DEVIN: undefined,
  SANDBOX_LANE_CODEX: undefined,
  LANE_SDK: undefined,
  LANE_FAILOVER: undefined,
};

function workspaceStub() {
  return env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
  );
}

beforeAll(async () => {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: actor.id,
      name: "Dispatch Test User",
      email: "dispatch-test@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const headers = await createAdminHeaders(env, actor.id);
  const workspace = await createWorkspace(db, env, headers, {
    name: "Dispatch test workspace",
    slug: "dispatch-test-ws",
    ownerId: actor.id,
  });
  if (workspace) {
    actor.organizationId = workspace.id;
  }
});

describe("dispatchAgent lane-cap compute check (PILE-676)", () => {
  it("does not evaluate computeBackend for a remote provider below the cap", async () => {
    const stub = workspaceStub();
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({ title: "No-compute dispatch" });

    const agentId = `mock-nocompute-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(agentId, () => new MockAgentProvider(agentId));

    // Pre-fix this threw CONFIG_ERROR: dispatchBackend was resolved
    // unconditionally ahead of the lane-cap check.
    const session = await dispatchAgent(
      noComputeEnv,
      agentId,
      actor.organizationId,
      issue,
      actor
    );

    expect(session.agentId).toBe(agentId);
    expect(session.status).toBe("created");
  });

  it("treats unconfigured compute as non-cloudflare at the lane cap", async () => {
    const stub = workspaceStub();
    await stub.setOrganizationId(actor.organizationId);

    // Fill the workspace to the 25-lane ceiling with unpinned (legacy)
    // sessions — computeBackend === null rows count against whichever
    // backend the dispatch resolves to.
    const filler = await stub.createIssue({ title: "cap filler" });
    for (let i = 0; i < 25; i++) {
      await stub.createAgentSession({
        issueId: filler.id,
        agentId: "cap-filler-agent",
        provider: "cap-filler-agent",
        actorId: actor.id,
        actorType: "user",
        status: "running",
      });
    }

    const issue = await stub.createIssue({ title: "at-cap dispatch" });
    const agentId = `mock-atcap-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(agentId, () => new MockAgentProvider(agentId));

    // computeBackend() throws CONFIG_ERROR here; that is not "cloudflare",
    // so the CF container pool cap must not block the dispatch.
    const session = await dispatchAgent(
      noComputeEnv,
      agentId,
      actor.organizationId,
      issue,
      actor
    );

    expect(session.agentId).toBe(agentId);
    expect(session.status).toBe("created");
  });
});
