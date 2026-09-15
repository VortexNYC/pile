import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const mcpServerScopeSchema = z.enum(["workspace", "repo", "issue"]);

const mcpServerSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  url: z.string(),
  scope: mcpServerScopeSchema,
  repo: z.string().nullable(),
  issueId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const listMcpServersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/mcp/servers",
  tags: ["mcp-servers"],
  middleware: [rls("read", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      scope: mcpServerScopeSchema.optional(),
    }),
  },
  responses: {
    200: {
      description: "MCP servers list",
      content: {
        "application/json": {
          schema: z.object({ servers: z.array(mcpServerSchema) }),
        },
      },
    },
  },
});

const createMcpServerRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/mcp/servers",
  tags: ["mcp-servers"],
  middleware: [rls("write", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            url: z.string().url(),
            scope: mcpServerScopeSchema,
            repo: z.string().optional(),
            issueId: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "MCP server created",
      content: {
        "application/json": { schema: mcpServerSchema },
      },
    },
    400: { description: "Bad request" },
  },
});

const getMcpServerRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/mcp/servers/{id}",
  tags: ["mcp-servers"],
  middleware: [rls("read", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "MCP server",
      content: {
        "application/json": { schema: mcpServerSchema },
      },
    },
    404: { description: "MCP server not found" },
  },
});

const deleteMcpServerRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/mcp/servers/{id}",
  tags: ["mcp-servers"],
  middleware: [rls("write", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "MCP server deleted" },
    404: { description: "MCP server not found" },
  },
});

export function registerMcpServerRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listMcpServersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { scope } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const rows = await stub.listMcpServers(scope);
    return c.json({ servers: rows });
  });

  app.openapi(createMcpServerRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const row = await stub.createMcpServer(body);
    return c.json(row, 201);
  });

  app.openapi(getMcpServerRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const row = await stub.getMcpServer(id);
    if (!row) {
      return c.json({ message: "MCP server not found" }, 404);
    }
    return c.json(row);
  });

  app.openapi(deleteMcpServerRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const row = await stub.deleteMcpServer(id);
    if (!row) {
      return c.json({ message: "MCP server not found" }, 404);
    }
    return c.body(null, 204);
  });
}
