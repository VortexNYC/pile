import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const skillScopeSchema = z.enum(["workspace", "repo", "issue"]);

const skillSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  content: z.string(),
  scope: skillScopeSchema,
  repo: z.string().nullable(),
  issueId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const listSkillsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/skills",
  tags: ["skills"],
  middleware: [rls("read", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      scope: skillScopeSchema.optional(),
    }),
  },
  responses: {
    200: {
      description: "Skills list",
      content: {
        "application/json": {
          schema: z.object({ skills: z.array(skillSchema) }),
        },
      },
    },
  },
});

const createSkillRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/skills",
  tags: ["skills"],
  middleware: [rls("write", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            content: z.string().min(1),
            scope: skillScopeSchema,
            repo: z.string().optional(),
            issueId: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Skill created",
      content: {
        "application/json": { schema: skillSchema },
      },
    },
    400: { description: "Bad request" },
  },
});

const getSkillRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/skills/{id}",
  tags: ["skills"],
  middleware: [rls("read", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Skill",
      content: {
        "application/json": { schema: skillSchema },
      },
    },
    404: { description: "Skill not found" },
  },
});

const deleteSkillRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/skills/{id}",
  tags: ["skills"],
  middleware: [rls("write", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Skill deleted" },
    404: { description: "Skill not found" },
  },
});

export function registerSkillRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listSkillsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { scope } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const rows = await stub.listSkills(scope);
    return c.json({ skills: rows });
  });

  app.openapi(createSkillRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const row = await stub.createSkill(body);
    return c.json(row, 201);
  });

  app.openapi(getSkillRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const row = await stub.getSkill(id);
    if (!row) {
      return c.json({ message: "Skill not found" }, 404);
    }
    return c.json(row);
  });

  app.openapi(deleteSkillRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const row = await stub.deleteSkill(id);
    if (!row) {
      return c.json({ message: "Skill not found" }, 404);
    }
    return c.body(null, 204);
  });
}
