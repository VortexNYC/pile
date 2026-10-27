import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { MCP_TOOL_ALIASES } from "./mcp-aliases.js";
import { MCP_TOOLS } from "./mcp-tools.js";

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
  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId,
      name: "test-workspace-admin",
      rateLimitEnabled: false,
      metadata: { organizationId, permissions: "admin" },
      permissions: { workspace: ["admin"] },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return new Headers({ Authorization: `Bearer ${parsed.key}` });
}

async function workspaceScopedHeaders(
  organizationId: string,
  userId: string,
  permissions: string[]
): Promise<Headers> {
  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId,
      name: `test-workspace-${permissions.join("-")}`,
      rateLimitEnabled: false,
      metadata: {
        organizationId,
        permissions: permissions.join(","),
      },
      permissions: { workspace: permissions },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return new Headers({ Authorization: `Bearer ${parsed.key}` });
}

let filterWorkspace: { organizationId: string; userId: string } | null = null;

async function seedFilterWorkspace() {
  if (filterWorkspace) return filterWorkspace;
  const db = createD1(env.D1);
  const now = new Date();
  const userId = `mcp-filter-${crypto.randomUUID()}`;
  await db
    .insert(userTable)
    .values({
      id: userId,
      name: "MCP Filter User",
      email: `${userId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const workspace = await createWorkspace(
    db,
    env,
    await createAdminHeaders(env, userId),
    {
      name: "MCP filter workspace",
      slug: `mcp-filter-${crypto.randomUUID()}`,
      ownerId: userId,
    }
  );
  filterWorkspace = { organizationId: workspace.id, userId };
  return filterWorkspace;
}

async function listTools(
  authHeaders?: Headers
): Promise<{ name: string; description?: string }[]> {
  const res = await app.fetch(
    mcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      authHeaders
    ),
    env
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result?: { tools?: { name: string; description?: string }[] };
  };
  return body.result?.tools ?? [];
}

describe("MCP integration", () => {
  it("initializes, and lists no tools for anonymous callers (VTX-753)", async () => {
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

    // Anonymous callers can't invoke anything, so they see nothing.
    expect(await listTools()).toEqual([]);
  });

  it("lists the full generated surface for a workspace admin key", async () => {
    const { organizationId, userId } = await seedFilterWorkspace();
    const tools = await listTools(
      await workspaceAdminHeaders(organizationId, userId)
    );
    expect(tools.length).toBe(
      MCP_TOOLS.length + Object.keys(MCP_TOOL_ALIASES).length
    );
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);

    const createIssue = tools.find((tool) => tool.name === "create_issue");
    expect(createIssue?.description).toContain(
      "Same as postWorkspacesOrganizationIdIssues"
    );
    expect(createIssue?.description).toContain('"body" object');
    expect(createIssue?.description).toContain("title*");
    expect(createIssue?.description).toContain("possibleDuplicates");
    expect(createIssue?.description).toContain("dedupe");
    const generated = tools.find(
      (tool) => tool.name === "postWorkspacesOrganizationIdIssues"
    );
    expect(generated?.description).toContain("Alias: create_issue");
    expect(tools.some((tool) => tool.name === "memory_recall")).toBe(true);
    expect(tools.some((tool) => tool.name === "memory_remember")).toBe(true);
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
    // A bearer key: /get-session still resolves it to the owner, and
    // bearer credentials skip the CSRF origin gate on mutating routes.
    const setupAuth = await createAuth(env);
    const setupKey = await setupAuth.api.createApiKey({
      body: { userId, name: "setup", rateLimitEnabled: false },
    });
    const setupHeaders = new Headers({
      Authorization: `Bearer ${z.object({ key: z.string() }).parse(setupKey).key}`,
    });

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
        body: { key: "ISS", name: "Pile" },
      },
      adminHeaders
    );
    const team = JSON.parse(teamRes.content[0].text) as { id: string };
    expect(team.id).toBeDefined();

    const issueRes = await callTool(
      "create_issue",
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
      "list_issues",
      { organizationId: workspace.id },
      adminHeaders
    );
    const list = JSON.parse(listRes.content[0].text) as {
      issues: { identifier: string }[];
    };
    expect(list.issues.some((i) => i.identifier === issue.identifier)).toBe(
      true
    );

    const generatedListRes = await callTool(
      "getWorkspacesOrganizationIdIssues",
      { organizationId: workspace.id },
      adminHeaders
    );
    expect(generatedListRes.content[0].text).toBe(listRes.content[0].text);
  });

  it("propagates auth failures back to the caller", async () => {
    // Anonymous callers see no tools, so the call itself fails as an
    // unregistered tool rather than reaching the API.
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
      error?: { code?: number; message?: string };
    };
    expect(body.result?.isError === true || body.error !== undefined).toBe(
      true
    );
  });
});

describe("tools/list permission filtering (VTX-753)", () => {
  it("hides write and admin tools from a read-only workspace key", async () => {
    const { organizationId, userId } = await seedFilterWorkspace();
    const tools = await listTools(
      await workspaceScopedHeaders(organizationId, userId, ["read"])
    );
    const names = new Set(tools.map((tool) => tool.name));

    // Read-permitted tools stay visible.
    for (const name of [
      "list_issues",
      "get_issue",
      "search",
      "list_documents",
      "list_workspaces",
      "memory_recall",
    ]) {
      expect(names.has(name), `expected ${name} to be listed`).toBe(true);
    }

    // Write/admin tools the key can never invoke are hidden.
    for (const name of [
      "create_issue",
      "update_issue",
      "delete_issue",
      "update_issues_batch",
      "create_issues_batch",
      "getWorkspacesOrganizationIdReadiness",
      "getWorkspacesOrganizationIdExport",
    ]) {
      expect(names.has(name), `expected ${name} to be hidden`).toBe(false);
    }
  });

  it("never lists auth, webhook, or ingest tools for any caller", async () => {
    const { organizationId, userId } = await seedFilterWorkspace();
    const tools = await listTools(
      await workspaceAdminHeaders(organizationId, userId)
    );
    const names = new Set(tools.map((tool) => tool.name));
    for (const name of [
      "adminUpdateUser",
      "impersonateUser",
      "setUserPassword",
      "deleteUser",
      "banUser",
      "setRole",
      "revokeUserSessions",
      "signInEmail",
      "signUpEmail",
      "resetPassword",
      "postBillingWebhook",
      "postGitlab",
      "postIntercomOrganizationId",
    ]) {
      expect(names.has(name), `expected ${name} to be off-surface`).toBe(false);
    }

    // An unregistered tool is also uncallable — tools/call fails.
    const res = await app.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "adminUpdateUser", arguments: { body: {} } },
        },
        await workspaceAdminHeaders(organizationId, userId)
      ),
      env
    );
    const body = (await res.json()) as {
      result?: { isError?: boolean };
      error?: { message?: string };
    };
    expect(body.result?.isError === true || body.error !== undefined).toBe(
      true
    );
  });
});

describe("tool naming (VTX-772)", () => {
  it("exposes update_issues_batch and marks create_issues_batch deprecated", async () => {
    const { organizationId, userId } = await seedFilterWorkspace();
    const tools = await listTools(
      await workspaceAdminHeaders(organizationId, userId)
    );
    const renamed = tools.find((tool) => tool.name === "update_issues_batch");
    expect(renamed).toBeDefined();
    const legacy = tools.find((tool) => tool.name === "create_issues_batch");
    expect(legacy).toBeDefined();
    expect(legacy?.description).toContain("Deprecated");
    expect(legacy?.description).toContain("update_issues_batch");
  });
});

describe("generated schema validity (VTX-749)", () => {
  it("emits no boolean exclusiveMinimum/exclusiveMaximum (JSON Schema 2020-12)", () => {
    const violations: string[] = [];
    const walk = (node: unknown, toolName: string): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item, toolName);
        return;
      }
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (
          (key === "exclusiveMinimum" || key === "exclusiveMaximum") &&
          typeof value !== "number"
        ) {
          violations.push(`${toolName}: ${key}=${String(value)}`);
        }
        walk(value, toolName);
      }
    };
    for (const tool of MCP_TOOLS) walk(tool.inputSchema, tool.name);
    expect(violations).toEqual([]);
  });
});

describe("MCP resources and prompts (PILE-630)", () => {
  it("lists resource templates and prompts, and reads entity resources", async () => {
    const db = createD1(env.D1);
    const now = new Date();
    const userId = `mcp-res-${crypto.randomUUID()}`;
    await db
      .insert(userTable)
      .values({
        id: userId,
        name: "MCP Resource User",
        email: `${userId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const setupAuth = await createAuth(env);
    const setupKey = await setupAuth.api.createApiKey({
      body: { userId, name: "setup", rateLimitEnabled: false },
    });
    const setupHeaders = new Headers({
      Authorization: `Bearer ${z.object({ key: z.string() }).parse(setupKey).key}`,
    });
    const slug = `mcp-res-${crypto.randomUUID()}`;
    const workspaceRes = await callTool(
      "postWorkspaces",
      { body: { name: "MCP resource workspace", slug } },
      setupHeaders
    );
    const workspace = JSON.parse(workspaceRes.content[0].text) as {
      id: string;
    };
    const adminHeaders = await workspaceAdminHeaders(workspace.id, userId);

    const teamRes = await callTool(
      "postWorkspacesOrganizationIdTeams",
      { organizationId: workspace.id, body: { key: "RES", name: "Res" } },
      adminHeaders
    );
    const team = JSON.parse(teamRes.content[0].text) as { id: string };
    const issueRes = await callTool(
      "postWorkspacesOrganizationIdIssues",
      {
        organizationId: workspace.id,
        body: { title: "Resource test issue", teamId: team.id },
      },
      adminHeaders
    );
    const issue = JSON.parse(issueRes.content[0].text) as { id: string };

    // resources/templates/list
    const tplRes = await app.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 10,
          method: "resources/templates/list",
          params: {},
        },
        adminHeaders
      ),
      env
    );
    expect(tplRes.status).toBe(200);
    const tplBody = (await tplRes.json()) as {
      result?: { resourceTemplates?: { uriTemplate: string; name: string }[] };
    };
    const templates = tplBody.result?.resourceTemplates ?? [];
    const uris = templates.map((t) => t.uriTemplate);
    expect(uris).toContain("pile://workspaces/{organizationId}/issues/{id}");
    expect(uris).toContain("pile://workspaces/{organizationId}/documents/{id}");
    expect(uris).toContain("pile://workspaces/{organizationId}/customers/{id}");
    expect(uris).toContain(
      "pile://workspaces/{organizationId}/memory/profile/{entityType}/{entityId}"
    );

    // resources/read — issue
    const readRes = await app.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 11,
          method: "resources/read",
          params: {
            uri: `pile://workspaces/${workspace.id}/issues/${issue.id}`,
          },
        },
        adminHeaders
      ),
      env
    );
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as {
      result?: { contents?: { uri: string; text?: string }[] };
    };
    const contents = readBody.result?.contents ?? [];
    expect(contents[0]?.text).toContain(issue.id);

    // resources/read — memory profile
    const memRes = await app.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 12,
          method: "resources/read",
          params: {
            uri: `pile://workspaces/${workspace.id}/memory/profile/issue/${issue.id}`,
          },
        },
        adminHeaders
      ),
      env
    );
    expect(memRes.status).toBe(200);
    const memBody = (await memRes.json()) as {
      result?: { contents?: { text?: string }[] };
      error?: { message: string };
    };
    expect(memBody.error).toBeUndefined();

    // prompts/list
    const promptList = await app.fetch(
      mcpRequest(
        { jsonrpc: "2.0", id: 13, method: "prompts/list", params: {} },
        adminHeaders
      ),
      env
    );
    expect(promptList.status).toBe(200);
    const promptListBody = (await promptList.json()) as {
      result?: { prompts?: { name: string }[] };
    };
    const names = (promptListBody.result?.prompts ?? []).map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "triage-issue",
        "morning-brief",
        "session-handoff",
        "memory-distill",
      ])
    );

    // prompts/get — all four
    for (const [name, args] of [
      ["triage-issue", { organizationId: workspace.id, issueId: issue.id }],
      ["morning-brief", { organizationId: workspace.id }],
      [
        "session-handoff",
        { organizationId: workspace.id, issueId: issue.id, topic: "handoff" },
      ],
      [
        "memory-distill",
        {
          organizationId: workspace.id,
          entityType: "issue",
          entityId: issue.id,
        },
      ],
    ] as const) {
      const get = await app.fetch(
        mcpRequest(
          {
            jsonrpc: "2.0",
            id: 14,
            method: "prompts/get",
            params: { name, arguments: args },
          },
          adminHeaders
        ),
        env
      );
      expect(get.status).toBe(200);
      const getBody = (await get.json()) as {
        result?: { messages?: { role: string; content: { text: string } }[] };
        error?: { message: string };
      };
      expect(getBody.error).toBeUndefined();
      expect(getBody.result?.messages?.length).toBeGreaterThan(0);
    }
  });
});

describe("list_documents summary default (VTX-750)", () => {
  it("returns summaries by default and full content only on summary=0", async () => {
    const db = createD1(env.D1);
    const now = new Date();
    const userId = `mcp-docs-${crypto.randomUUID()}`;
    await db
      .insert(userTable)
      .values({
        id: userId,
        name: "MCP Docs User",
        email: `${userId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const setupAuth = await createAuth(env);
    const setupKey = await setupAuth.api.createApiKey({
      body: { userId, name: "setup", rateLimitEnabled: false },
    });
    const setupHeaders = new Headers({
      Authorization: `Bearer ${z.object({ key: z.string() }).parse(setupKey).key}`,
    });
    const workspaceRes = await callTool(
      "postWorkspaces",
      {
        body: { name: "MCP docs ws", slug: `mcp-docs-${crypto.randomUUID()}` },
      },
      setupHeaders
    );
    const workspace = JSON.parse(workspaceRes.content[0].text) as {
      id: string;
    };
    const adminHeaders = await workspaceAdminHeaders(workspace.id, userId);

    await callTool(
      "create_document",
      {
        organizationId: workspace.id,
        body: {
          title: "big body doc",
          contentFormat: "markdown",
          content: "FULL_BODY_MARKER_VTX750",
        },
      },
      adminHeaders
    );

    // Default: summary — content stripped.
    const listRes = await callTool(
      "list_documents",
      { organizationId: workspace.id },
      adminHeaders
    );
    const listed = JSON.parse(listRes.content[0].text) as {
      documents: { id: string; content: unknown }[];
    };
    const doc = listed.documents.find((d) => d.id);
    expect(doc).toBeDefined();
    expect(listed.documents.every((d) => d.content === "")).toBe(true);

    // Explicit summary=0 restores full content.
    const fullRes = await callTool(
      "list_documents",
      { organizationId: workspace.id, summary: "0" },
      adminHeaders
    );
    const full = JSON.parse(fullRes.content[0].text) as {
      documents: { content: unknown }[];
    };
    expect(full.documents[0]?.content).toBe("FULL_BODY_MARKER_VTX750");
  });
});
