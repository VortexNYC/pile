import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

function mcpRequest(body: unknown, authHeaders?: Headers) {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  });
  if (authHeaders !== undefined) {
    for (const [key, value] of authHeaders.entries()) {
      headers.set(key, value);
    }
  }
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  authHeaders?: Headers
): Promise<{ isError: boolean; content: { type: string; text: string }[] }> {
  const res = await app.fetch(
    mcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
      authHeaders
    ),
    env
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    result?: { content: { type: string; text: string }[]; isError: boolean };
    error?: { message: string };
  };
  if (json.error !== undefined) {
    throw new Error(json.error.message);
  }
  if (json.result === undefined) {
    throw new Error("Missing result");
  }
  return json.result;
}

async function workspaceAdminHeaders(
  organizationId: string,
  userId: string
): Promise<Headers> {
  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId,
      name: "test-workspace-admin",
      rateLimitEnabled: false,
      metadata: { organizationId, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return new Headers({ Authorization: `Bearer ${parsed.key}` });
}

describe("MCP integration", () => {
  it("initializes and lists tools", async () => {
    const initRes = await app.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      }),
      env
    );

    expect(initRes.status).toBe(200);
    const initBody = (await initRes.json()) as {
      result?: { protocolVersion?: string };
    };
    expect(initBody.result?.protocolVersion).toBe("2024-11-05");

    const listRes = await app.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
      env
    );

    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      result?: { tools?: unknown[] };
    };
    expect(listBody.result?.tools?.length).toBe(380);
  });

  it("creates and manages an issue through MCP", async () => {
    const db = createD1(env.D1);
    const now = new Date();
    const userId = `mcp-user-${crypto.randomUUID()}`;
    await db
      .insert(userTable)
      .values({
        id: userId,
        name: "MCP Test User",
        email: `${userId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const setupHeaders = await createAdminHeaders(env, userId);

    const slug = `mcp-e2e-${crypto.randomUUID()}`;
    const workspaceRes = await callTool(
      "postWorkspaces",
      { body: { name: "MCP end-to-end workspace", slug } },
      setupHeaders
    );
    const workspace = JSON.parse(workspaceRes.content[0].text) as {
      id: string;
      slug: string;
    };
    expect(workspace.id).toBeDefined();
    expect(workspace.slug).toBe(slug);

    const adminHeaders = await workspaceAdminHeaders(workspace.id, userId);

    const teamRes = await callTool(
      "postWorkspacesOrganizationIdTeams",
      {
        organizationId: workspace.id,
        body: { key: "ISS", name: "Issue Tracker" },
      },
      adminHeaders
    );
    const team = JSON.parse(teamRes.content[0].text) as { id: string };
    expect(team.id).toBeDefined();

    const issueRes = await callTool(
      "postWorkspacesOrganizationIdIssues",
      {
        organizationId: workspace.id,
        body: {
          title: "Issue created by an MCP tool call",
          teamId: team.id,
          priority: "medium",
        },
      },
      adminHeaders
    );
    const issue = JSON.parse(issueRes.content[0].text) as {
      id: string;
      identifier: string;
      number: number;
    };
    expect(issue.identifier).toBeDefined();
    expect(issue.number).toBeGreaterThan(0);

    const listRes = await callTool(
      "getWorkspacesOrganizationIdIssues",
      { organizationId: workspace.id },
      adminHeaders
    );
    const list = JSON.parse(listRes.content[0].text) as {
      issues: { identifier: string }[];
    };
    expect(list.issues.some((i) => i.identifier === issue.identifier)).toBe(
      true
    );
  });

  it("propagates auth failures back to the caller", async () => {
    const res = await app.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "postWorkspaces",
          arguments: {
            body: { name: "Unauthorized workspace", slug: "unauth" },
          },
        },
      }),
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { isError: boolean; content: { text: string }[] };
    };
    expect(body.result?.isError).toBe(true);
  });
});
