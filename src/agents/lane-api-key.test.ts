import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { apikey, user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { MockAgentProvider } from "./harness.js";
import { dispatchAgent, registerAgentProvider } from "./index.js";
import { laneApiPermissions, reapLaneApiKeys } from "./lane-api-key.js";

const actor: WorkspaceIdentity = {
  id: "user-lane-key",
  organizationId: "",
  type: "user",
  permissions: ["write"],
};

async function req(
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };
  return app.fetch(
    new Request(`https://example.com${path}`, { ...init, headers }),
    env
  );
}

describe("laneApiPermissions", () => {
  it("defaults to read-only for absent and unknown tiers", () => {
    expect(laneApiPermissions({})).toEqual(["read"]);
    expect(laneApiPermissions({ permissionsTier: "bogus" })).toEqual(["read"]);
  });

  it("gives research-tier lanes write-back on pipeline records", () => {
    const grants = laneApiPermissions({
      permissionsTier: "research",
      toolScope: "read:web,write:pile-customers",
    });
    for (const p of [
      "read",
      "issue:create",
      "comment:create",
      "document:create",
      "document:edit",
      "customer:create",
      "customer:edit",
    ]) {
      expect(grants).toContain(p);
    }
    expect(grants).not.toContain("write");
    expect(grants).not.toContain("admin");
  });

  it("toolScope widens the tier per domain", () => {
    const grants = laneApiPermissions({
      permissionsTier: "read",
      toolScope: "write:pile-documents",
    });
    expect(grants).toContain("document:create");
    expect(grants).not.toContain("customer:create");
  });
});

describe("lane API keys (PILE-442)", () => {
  let stub: ReturnType<typeof env.WORKSPACE_DURABLE_OBJECT.get>;
  let organizationId: string;

  beforeAll(async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: actor.id,
        name: "Lane Key",
        email: `${actor.id}@example.com`,
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, actor.id);
    const workspace = await createWorkspace(db, env, headers, {
      name: "Lane keys",
      slug: `lane-keys-${crypto.randomUUID()}`,
      key: `LK${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      ownerId: actor.id,
    });
    organizationId = workspace!.id;
    actor.organizationId = organizationId;
    stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
  });

  it(
    "mints a key scoped to the agent type's role and reaps it at terminal",
    { timeout: 60000 },
    async () => {
      await stub.upsertAgentType({
        slug: "scout",
        name: "Scout",
        providerAgentId: "mock-scout",
        permissionsTier: "research",
        toolScope: "read:web,write:pile-customers",
      });
      const issue = await stub.createIssue({
        title: "scout sub-step",
        ownerAgent: "scout",
      });

      let capturedKey: string | undefined;
      const provider = new MockAgentProvider("mock-scout", {
        dispatch: (_org, _issue, _model, ctx) => {
          capturedKey = ctx?.pileApi?.key;
          return { id: "scout-run", agentId: "mock-scout", status: "created" };
        },
      });
      registerAgentProvider("mock-scout", () => provider);

      const prevUrl = env.PUBLIC_API_URL;
      (env as { PUBLIC_API_URL?: string }).PUBLIC_API_URL = "https://pile.test";
      try {
        const session = await dispatchAgent(
          env,
          "mock-scout",
          organizationId,
          issue,
          { ...actor, type: "agent", id: "pipeline-runtime" },
          undefined,
          undefined,
          {
            agentProfile: { slug: "scout", name: "Scout" },
          }
        );

        expect(capturedKey).toBeDefined();
        const key = capturedKey!;

        // /me/permissions reflects the role's grants.
        const me = await req(
          `/workspaces/${organizationId}/me/permissions`,
          {},
          key
        );
        expect(me.status).toBe(200);
        const { permissions } = z
          .object({ permissions: z.array(z.string()) })
          .parse(await me.json());
        expect(permissions).toContain("customer:create");
        expect(permissions).toContain("document:create");
        expect(permissions).toContain("issue:create");

        // In-scope writes succeed: a customer record and a comment on the
        // lane's issue.
        const customer = await req(
          `/workspaces/${organizationId}/customers`,
          {
            method: "POST",
            body: JSON.stringify({ name: "Lane's Merchant" }),
          },
          key
        );
        expect(customer.status).toBe(201);
        const comment = await req(
          `/workspaces/${organizationId}/issues/${issue.id}/comments`,
          { method: "POST", body: JSON.stringify({ body: "scout note" }) },
          key
        );
        expect(comment.status).toBe(201);

        // Out-of-scope writes stay denied — token admin is a "write" grant.
        const denied = await req(
          `/workspaces/${organizationId}/tokens`,
          {
            method: "POST",
            body: JSON.stringify({ name: "escalation" }),
          },
          key
        );
        expect(denied.status).toBe(403);

        // Mint + revoke audit under the agent's identity.
        const audit = await stub.listAuditLog({ entityType: "token" });
        const minted = audit.find((e) => e.action === "token.created");
        expect(minted?.actorId).toBe("scout");
        expect(minted?.actorType).toBe("agent");

        // Key survives while the lane runs; terminal session revokes it.
        expect(await stub.listLaneApiKeySessions()).toContain(session.id);
        await stub.applyAgentSessionResult(session.id, {
          status: "completed",
          result: "done",
        });
        expect(await reapLaneApiKeys(env, stub)).toBe(1);
        expect(await stub.listLaneApiKeySessions()).not.toContain(session.id);

        const dead = await req(
          `/workspaces/${organizationId}/me/permissions`,
          {},
          key
        );
        expect(dead.status).toBe(401);
        const rows = await createD1(env.D1)
          .select({ id: apikey.id })
          .from(apikey)
          .where(eq(apikey.metadata, `%${session.id}%`))
          .all();
        expect(rows).toHaveLength(0);
      } finally {
        (env as { PUBLIC_API_URL?: string }).PUBLIC_API_URL = prevUrl;
      }
    }
  );

  it(
    "reaper leaves a live session's key alone",
    { timeout: 60000 },
    async () => {
      const issue = await stub.createIssue({ title: "live lane" });
      const provider = new MockAgentProvider("mock-live");
      registerAgentProvider("mock-live", () => provider);
      const prevUrl = env.PUBLIC_API_URL;
      (env as { PUBLIC_API_URL?: string }).PUBLIC_API_URL = "https://pile.test";
      try {
        const session = await dispatchAgent(
          env,
          "mock-live",
          organizationId,
          issue,
          actor
        );
        // No agent type / ownerAgent — the key is still read-only.
        expect(await stub.listLaneApiKeySessions()).toContain(session.id);
        expect(await reapLaneApiKeys(env, stub)).toBe(0);
        expect(await stub.listLaneApiKeySessions()).toContain(session.id);
      } finally {
        (env as { PUBLIC_API_URL?: string }).PUBLIC_API_URL = prevUrl;
      }
    }
  );
});
