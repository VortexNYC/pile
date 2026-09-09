import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  addProjectMember,
  listProjectMembers,
  removeProjectMember,
  updateProjectMemberRole,
} from "../global/project-members.js";
import { getProject } from "../global/workspace-entities.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const projectMemberSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  userId: z.string(),
  role: z.enum(["lead", "member"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const projectMemberBodySchema = z.object({
  userId: z.string(),
  role: z.enum(["lead", "member"]).default("member"),
});

const projectMemberUpdateSchema = z.object({
  role: z.enum(["lead", "member"]),
});

const listProjectMembersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/projects/{projectId}/members",
  tags: ["project-members"],
  middleware: [rls("project:member")],
  request: {
    params: z.object({ organizationId: z.string(), projectId: z.string() }),
  },
  responses: {
    200: {
      description: "Project members list",
      content: {
        "application/json": {
          schema: z.object({ members: z.array(projectMemberSchema) }),
        },
      },
    },
    404: { description: "Project not found" },
  },
});

const createProjectMemberRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/projects/{projectId}/members",
  tags: ["project-members"],
  middleware: [rls("project:lead")],
  request: {
    params: z.object({ organizationId: z.string(), projectId: z.string() }),
    body: {
      content: {
        "application/json": { schema: projectMemberBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Project member added",
      content: { "application/json": { schema: projectMemberSchema } },
    },
    404: { description: "Project not found" },
  },
});

const updateProjectMemberRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/projects/{projectId}/members/{id}",
  tags: ["project-members"],
  middleware: [rls("project:lead")],
  request: {
    params: z.object({
      organizationId: z.string(),
      projectId: z.string(),
      id: z.string(),
    }),
    body: {
      content: { "application/json": { schema: projectMemberUpdateSchema } },
    },
  },
  responses: {
    200: {
      description: "Project member updated",
      content: { "application/json": { schema: projectMemberSchema } },
    },
    404: { description: "Project member not found" },
  },
});

const deleteProjectMemberRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/projects/{projectId}/members/{id}",
  tags: ["project-members"],
  middleware: [rls("project:lead")],
  request: {
    params: z.object({
      organizationId: z.string(),
      projectId: z.string(),
      id: z.string(),
    }),
  },
  responses: { 204: { description: "Project member removed" } },
});

function toMemberResponse(row: z.infer<typeof projectMemberSchema>) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    userId: row.userId,
    role: row.role,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function registerProjectMemberRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listProjectMembersRoute, async (c) => {
    const { organizationId, projectId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    if (!(await getProject(db, organizationId, projectId))) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Project not found",
      });
    }
    const rows = await listProjectMembers(db, organizationId, projectId);
    return c.json({ members: rows.map(toMemberResponse) });
  });

  app.openapi(createProjectMemberRoute, async (c) => {
    const { organizationId, projectId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    if (!(await getProject(db, organizationId, projectId))) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Project not found",
      });
    }
    const row = await addProjectMember(
      db,
      organizationId,
      projectId,
      input.userId,
      input.role
    );
    return c.json(toMemberResponse(row!), 201);
  });

  app.openapi(updateProjectMemberRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const row = await updateProjectMemberRole(
      db,
      organizationId,
      id,
      input.role
    );
    if (!row) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Project member not found",
      });
    }
    return c.json(toMemberResponse(row));
  });

  app.openapi(deleteProjectMemberRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await removeProjectMember(db, organizationId, id);
    return c.body(null, 204);
  });
}
