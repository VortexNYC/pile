import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { agentLogToken } from "../agents/credentials.js";
import { createD1 } from "../global/db.js";
import { organization, user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createAdminHeaders } from "../platform/test-auth.js";

const ORIGIN = "https://your-domain.com";

const rpcResponse = z.object({
  result: z
    .object({
      tools: z.array(z.object({ name: z.string() })).optional(),
      content: z
        .array(z.object({ type: z.string(), text: z.string() }))
        .optional(),
      isError: z.boolean().optional(),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

function mcp(path: string, laneToken: string | null, body: unknown) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Origin: ORIGIN,
  });
  if (laneToken) headers.set("Authorization", `Bearer ${laneToken}`);
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    env
  );
}

describe("lane MCP endpoint", () => {
  let organizationId: string;
  let apiToken: string;

  beforeAll(async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: "user-lane-mcp",
        name: "Lane MCP",
        email: "lane-mcp@example.com",
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, "user-lane-mcp");
    const workspace = await createWorkspace(db, env, headers, {
      name: "Lane MCP tests",
      slug: `lane-mcp-${crypto.randomUUID()}`,
      ownerId: "user-lane-mcp",
    });
    organizationId = workspace!.id;
    await db
      .update(organization)
      .set({
        metadata: JSON.stringify({
          key: workspace?.key ?? null,
          laneTools: { "VortexNYC/readonly": "readonly" },
        }),
      })
      .where(eq(organization.id, organizationId));
    const auth = await createAuth(env);
    const result = await auth.api.createApiKey({
      body: {
        userId: "user-lane-mcp",
        name: "lane-mcp-admin",
        metadata: { organizationId, permissions: "admin" },
        permissions: { workspace: ["admin"] },
      },
    });
    apiToken = z.object({ key: z.string() }).parse(result).key;
  });

  async function registerLane(repo: string) {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({ title: "Lane MCP", repo });
    const res = await app.fetch(
      new Request(
        `http://localhost/workspaces/${organizationId}/agent/sessions/register`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
            Origin: ORIGIN,
          },
          body: JSON.stringify({
            issueId: issue.id,
            provider: "custom-bot",
            status: "running",
            branch: "lane/branch",
          }),
        }
      ),
      env
    );
    expect(res.status).toBe(201);
    const body = await res.json<{
      session: { id: string };
      laneToken: string;
      mcpUrl: string | null;
    }>();
    return { ...body, stub };
  }

  it("rejects requests without a valid lane token for the session", async () => {
    const { session } = await registerLane("VortexNYC/pile");
    const path = `/workspaces/${organizationId}/agent/sessions/${session.id}/mcp`;
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };

    expect([401, 403]).toContain((await mcp(path, null, list)).status);
    expect((await mcp(path, "wrong", list)).status).toBe(401);
    const otherSession = await agentLogToken(
      env as unknown as WorkerEnv,
      organizationId,
      crypto.randomUUID()
    );
    expect((await mcp(path, otherSession, list)).status).toBe(401);
  });

  it("returns 404 for an unknown session", async () => {
    const sessionId = crypto.randomUUID();
    const laneToken = await agentLogToken(
      env as unknown as WorkerEnv,
      organizationId,
      sessionId
    );
    const res = await mcp(
      `/workspaces/${organizationId}/agent/sessions/${sessionId}/mcp`,
      laneToken,
      { jsonrpc: "2.0", id: 1, method: "tools/list" }
    );
    expect(res.status).toBe(404);
  });

  it("lists only the tools the repo's tier permits", async () => {
    const contribute = await registerLane("VortexNYC/pile");
    expect(contribute.mcpUrl).toContain(
      `/agent/sessions/${contribute.session.id}/mcp`
    );
    const res = await mcp(
      `/workspaces/${organizationId}/agent/sessions/${contribute.session.id}/mcp`,
      contribute.laneToken,
      { jsonrpc: "2.0", id: 1, method: "tools/list" }
    );
    expect(res.status).toBe(200);
    const names = (rpcResponse.parse(await res.json()).result?.tools ?? []).map(
      (t) => t.name
    );
    expect(names).toContain("create_pull_request");
    expect(names).toContain("report_progress");
    expect(names).not.toContain("rerun_failed_jobs");

    const readonly = await registerLane("VortexNYC/readonly");
    const roRes = await mcp(
      `/workspaces/${organizationId}/agent/sessions/${readonly.session.id}/mcp`,
      readonly.laneToken,
      { jsonrpc: "2.0", id: 1, method: "tools/list" }
    );
    const roNames = (
      rpcResponse.parse(await roRes.json()).result?.tools ?? []
    ).map((t) => t.name);
    expect(roNames).toContain("get_pull_request");
    expect(roNames).not.toContain("create_pull_request");

    const call = await mcp(
      `/workspaces/${organizationId}/agent/sessions/${readonly.session.id}/mcp`,
      readonly.laneToken,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "create_pull_request", arguments: { title: "x" } },
      }
    );
    const parsed = rpcResponse.parse(await call.json());
    expect(parsed.error !== undefined || parsed.result?.isError === true).toBe(
      true
    );
  });

  it("lists workspace tools on repo-scoped lanes and report_usage lands on the receipt (PILE-450)", async () => {
    const { session, laneToken, stub } = await registerLane("VortexNYC/pile");
    const path = `/workspaces/${organizationId}/agent/sessions/${session.id}/mcp`;

    const list = await mcp(path, laneToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const names = (
      rpcResponse.parse(await list.json()).result?.tools ?? []
    ).map((t) => t.name);
    expect(names).toContain("create_pull_request");
    expect(names).toContain("memory_remember");
    expect(names).toContain("memory_recall");
    expect(names).toContain("report_usage");

    const call = await mcp(path, laneToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "report_usage",
        arguments: {
          model: "claude-sonnet-4-5",
          inputTokens: 50_000,
          outputTokens: 5_000,
          costMicros: 165_000,
        },
      },
    });
    expect(rpcResponse.parse(await call.json()).result?.isError).toBe(false);
    const receipt = await stub.getRunReceipt(session.id);
    expect(receipt?.totalTokens).toBe(55_000);
    expect(receipt?.costMicros).toBe(165_000);
    expect(receipt?.costSource).toBe("reported");
  });

  it("reports progress through the session and records a lane.tool event", async () => {
    const { session, laneToken, stub } = await registerLane("VortexNYC/pile");
    const res = await mcp(
      `/workspaces/${organizationId}/agent/sessions/${session.id}/mcp`,
      laneToken,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_lane_context",
          arguments: {},
        },
      }
    );
    const ctx = rpcResponse.parse(await res.json());
    expect(ctx.result?.isError).toBe(false);
    const text = ctx.result?.content?.[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({
      repository: "VortexNYC/pile",
      branch: "lane/branch",
      tier: "contribute",
    });
    expect(text).not.toMatch(/ghs_|token/i);

    await mcp(
      `/workspaces/${organizationId}/agent/sessions/${session.id}/mcp`,
      laneToken,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "set_output",
          arguments: { result: "lane done" },
        },
      }
    );
    const updated = await stub.getAgentSession(session.id);
    expect(updated?.result).toBe("lane done");
    const events = await stub.listAgentSessionEvents(session.id);
    expect(
      events.filter((e) => e.type === "lane.tool").map((e) => e.message)
    ).toEqual(expect.arrayContaining(["get_lane_context", "set_output"]));
  });

  it("serves workspace tools on a repo-less lane and honors the profile allowlist", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    // repo-less issue — a pipeline lane, not a code lane
    const issue = await stub.createIssue({ title: "Prospect merchant" });
    // the lane's agent type carries a tools allowlist
    await stub.upsertAgentType({
      slug: "scout",
      name: "Scout",
      providerAgentId: "flue",
      kind: "agent",
      tools: JSON.stringify(["issue_get", "issue_comment"]),
    });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "scout",
      provider: "flue",
      actorId: "test",
      actorType: "agent",
      status: "running",
      conversationKey: `${issue.id}-scout`,
    });
    const laneToken = await agentLogToken(
      env as unknown as WorkerEnv,
      organizationId,
      session.id
    );
    const path = `/workspaces/${organizationId}/agent/sessions/${session.id}/mcp`;

    // tools/list — only the allowlisted workspace tools; no repo tools
    const list = await mcp(path, laneToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(list.status).toBe(200);
    const names = (
      rpcResponse.parse(await list.json()).result?.tools ?? []
    ).map((t) => t.name);
    expect(names).toContain("issue_get");
    expect(names).toContain("issue_comment");
    expect(names).not.toContain("create_pull_request");
    expect(names).not.toContain("web_fetch"); // not in the profile allowlist

    // tools/call — an allowlisted tool runs
    const call = await mcp(path, laneToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "issue_get", arguments: {} },
    });
    const parsed = rpcResponse.parse(await call.json());
    expect(parsed.error).toBeUndefined();
    const issueOut = JSON.parse(parsed.result?.content?.[0]?.text ?? "{}") as {
      id: string;
      title?: string;
    };
    expect(issueOut.id).toBe(issue.id);

    // a denied tool refuses at call time too
    const denied = await mcp(path, laneToken, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "web_fetch", arguments: { url: "https://x.com" } },
    });
    const deniedParsed = rpcResponse.parse(await denied.json());
    expect(
      deniedParsed.error !== undefined || deniedParsed.result?.isError === true
    ).toBe(true);
  });

  it("publishes the session plan via the set_plan tool (PILE-426)", async () => {
    const { session, laneToken, stub } = await registerLane("VortexNYC/pile");
    const plan = [
      { content: "Read the issue", status: "completed" },
      { content: "Write the fix", status: "inProgress" },
    ];
    const res = await mcp(
      `/workspaces/${organizationId}/agent/sessions/${session.id}/mcp`,
      laneToken,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "set_plan", arguments: { plan } },
      }
    );
    const parsed = rpcResponse.parse(await res.json());
    expect(parsed.result?.isError).toBe(false);

    const updated = await stub.getAgentSession(session.id);
    expect(JSON.parse(updated?.plan ?? "null")).toEqual(plan);
    const events = await stub.listAgentSessionEvents(session.id);
    expect(events.some((e) => e.type === "session.plan")).toBe(true);

    // Invalid plans are rejected inside the tool before any write.
    const bad = await mcp(
      `/workspaces/${organizationId}/agent/sessions/${session.id}/mcp`,
      laneToken,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "set_plan",
          arguments: { plan: [{ content: "x", status: "in_progress" }] },
        },
      }
    );
    const badParsed = rpcResponse.parse(await bad.json());
    expect(
      badParsed.error !== undefined || badParsed.result?.isError === true
    ).toBe(true);
    expect(
      JSON.parse((await stub.getAgentSession(session.id))?.plan ?? "null")
    ).toEqual(plan);
  });

  it("wires env into tool ctx — env-gated tools fail cleanly, not crash", async () => {
    const lane = await registerLane("VortexNYC/pile");
    const res = await mcp(
      `/workspaces/${organizationId}/agent/sessions/${lane.session.id}/mcp`,
      lane.laneToken,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "deepseek_search", arguments: { query: "x" } },
      }
    );
    // The wsCtx (env included) builds per call — a clean JSON-RPC response
    // proves the context constructed, whatever the tool's own outcome.
    expect(res.status).toBe(200);
    const parsed = rpcResponse.parse(await res.json());
    expect(parsed.result !== undefined || parsed.error !== undefined).toBe(
      true
    );
    expect(JSON.stringify(parsed)).not.toContain("TypeError");
  });

});
