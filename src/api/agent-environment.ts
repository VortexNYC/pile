import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const AGENT_ENV_PATH =
  /^(AGENTS\.md|skills\/[A-Za-z0-9._-]+\.md|rules\/[A-Za-z0-9._-]+\.md)$/;

function assertAgentEnvironmentPath(path: string): void {
  if (AGENT_ENV_PATH.test(path)) return;
  throw new VortexError({
    code: "BAD_REQUEST",
    status: 400,
    message: "Path must be AGENTS.md, skills/<name>.md, or rules/<name>.md",
  });
}

const fileSchema = z.object({
  path: z.string(),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const pathQuery = z.object({ path: z.string().min(1) });

const listRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/environment",
  tags: ["agent-environment"],
  middleware: [rls("read", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Workspace agent environment files",
      content: {
        "application/json": {
          schema: z.object({ files: z.array(fileSchema) }),
        },
      },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/environment/file",
  tags: ["agent-environment"],
  middleware: [rls("read", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: pathQuery,
  },
  responses: {
    200: {
      description: "One environment file",
      content: { "application/json": { schema: fileSchema } },
    },
    404: { description: "File not found" },
  },
});

const putRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/agent/environment",
  tags: ["agent-environment"],
  middleware: [rls("admin", "admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            path: z.string().min(1),
            content: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "File saved",
      content: { "application/json": { schema: fileSchema } },
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/agent/environment/file",
  tags: ["agent-environment"],
  middleware: [rls("admin", "admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: pathQuery,
  },
  responses: {
    204: { description: "File deleted" },
    404: { description: "File not found" },
  },
});

function toFile(row: {
  path: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    path: row.path,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function registerAgentEnvironmentRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const rows = await stub.listAgentEnvironmentFiles();
    return c.json({ files: rows.map(toFile) });
  });

  app.openapi(getRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { path } = c.req.valid("query");
    assertAgentEnvironmentPath(path);
    const stub = getWorkspaceStub(c.env, organizationId);
    const row = await stub.getAgentEnvironmentFile(path);
    if (!row) {
      return c.json({ message: "File not found" }, 404);
    }
    return c.json(toFile(row));
  });

  app.openapi(putRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    assertAgentEnvironmentPath(body.path);
    const stub = getWorkspaceStub(c.env, organizationId);
    const row = await stub.upsertAgentEnvironmentFile(body.path, body.content);
    if (!row) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "Failed to save environment file",
      });
    }
    return c.json(toFile(row));
  });

  app.openapi(deleteRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { path } = c.req.valid("query");
    assertAgentEnvironmentPath(path);
    const stub = getWorkspaceStub(c.env, organizationId);
    const deleted = await stub.deleteAgentEnvironmentFile(path);
    if (!deleted) {
      return c.json({ message: "File not found" }, 404);
    }
    return c.body(null, 204);
  });
}
