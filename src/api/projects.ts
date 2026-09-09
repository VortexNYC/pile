import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createProjectMilestone,
  createProjectUpdate,
  deleteProjectMilestone,
  deleteProjectUpdate,
  deleteProjectUpdateReminder,
  fireDueProjectUpdateReminders,
  getProject,
  getProjectMilestone,
  getProjectUpdate,
  getProjectUpdateReminder,
  listProjectMilestones,
  listProjectUpdates,
  updateProjectMilestone,
  updateProjectUpdate,
  upsertProjectUpdateReminder,
} from "../global/workspace-entities.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const projectUpdateSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  content: z.string(),
  contentFormat: z.enum(["text", "markdown", "blocks"]),
  health: z.enum(["on_track", "at_risk", "off_track", "paused"]),
  createdById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const projectUpdateBodySchema = z.object({
  content: z.string().min(1),
  contentFormat: z.enum(["text", "markdown", "blocks"]).optional().default("text"),
  health: z.enum(["on_track", "at_risk", "off_track", "paused"]).optional().default("on_track"),
});

const projectMilestoneSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  targetDate: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const projectMilestoneBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  targetDate: z.string().optional(),
  completedAt: z.string().optional(),
});

const projectUpdateReminderSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  cadence: z.enum(["daily", "weekly", "biweekly", "monthly"]),
  nextDueAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const projectUpdateReminderBodySchema = z.object({
  cadence: z.enum(["daily", "weekly", "biweekly", "monthly"]).optional(),
  nextDueAt: z.string().optional(),
});

function assertProjectExists(item: { id: string } | undefined) {
  if (!item) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Project not found",
    });
  }
}

export function registerProjectDetailRoutes(app: OpenAPIHono<AppContext>) {
  const listProjectUpdatesRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/projects/{projectId}/updates",
    tags: ["projects"],
    middleware: [rls("read")],
    request: {
      params: z.object({ organizationId: z.string(), projectId: z.string() }),
    },
    responses: {
      200: {
        description: "Project updates",
        content: {
          "application/json": { schema: z.object({ updates: z.array(projectUpdateSchema) }) },
        },
      },
    },
  });

  const createProjectUpdateRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/projects/{projectId}/updates",
    tags: ["projects"],
    middleware: [rls("write")],
    request: {
      params: z.object({ organizationId: z.string(), projectId: z.string() }),
      body: { content: { "application/json": { schema: projectUpdateBodySchema } } },
    },
    responses: {
      201: {
        description: "Project update created",
        content: { "application/json": { schema: projectUpdateSchema } },
      },
    },
  });

  const getProjectUpdateRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/projects/{projectId}/updates/{id}",
    tags: ["projects"],
    middleware: [rls("read")],
    request: {
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        id: z.string(),
      }),
    },
    responses: {
      200: {
        description: "Project update",
        content: { "application/json": { schema: projectUpdateSchema } },
      },
    },
  });

  const updateProjectUpdateRoute = createRoute({
    method: "patch",
    path: "/workspaces/{organizationId}/projects/{projectId}/updates/{id}",
    tags: ["projects"],
    middleware: [rls("write")],
    request: {
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        id: z.string(),
      }),
      body: { content: { "application/json": { schema: projectUpdateBodySchema.partial() } } },
    },
    responses: {
      200: {
        description: "Project update updated",
        content: { "application/json": { schema: projectUpdateSchema } },
      },
    },
  });

  const deleteProjectUpdateRoute = createRoute({
    method: "delete",
    path: "/workspaces/{organizationId}/projects/{projectId}/updates/{id}",
    tags: ["projects"],
    middleware: [rls("write")],
    request: {
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        id: z.string(),
      }),
    },
    responses: { 204: { description: "Project update deleted" } },
  });

  const listProjectMilestonesRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/projects/{projectId}/milestones",
    tags: ["projects"],
    middleware: [rls("read")],
    request: {
      params: z.object({ organizationId: z.string(), projectId: z.string() }),
    },
    responses: {
      200: {
        description: "Project milestones",
        content: {
          "application/json": { schema: z.object({ milestones: z.array(projectMilestoneSchema) }) },
        },
      },
    },
  });

  const createProjectMilestoneRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/projects/{projectId}/milestones",
    tags: ["projects"],
    middleware: [rls("write")],
    request: {
      params: z.object({ organizationId: z.string(), projectId: z.string() }),
      body: { content: { "application/json": { schema: projectMilestoneBodySchema } } },
    },
    responses: {
      201: {
        description: "Project milestone created",
        content: { "application/json": { schema: projectMilestoneSchema } },
      },
    },
  });

  const getProjectMilestoneRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/projects/{projectId}/milestones/{id}",
    tags: ["projects"],
    middleware: [rls("read")],
    request: {
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        id: z.string(),
      }),
    },
    responses: {
      200: {
        description: "Project milestone",
        content: { "application/json": { schema: projectMilestoneSchema } },
      },
    },
  });

  const updateProjectMilestoneRoute = createRoute({
    method: "patch",
    path: "/workspaces/{organizationId}/projects/{projectId}/milestones/{id}",
    tags: ["projects"],
    middleware: [rls("write")],
    request: {
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        id: z.string(),
      }),
      body: { content: { "application/json": { schema: projectMilestoneBodySchema.partial() } } },
    },
    responses: {
      200: {
        description: "Project milestone updated",
        content: { "application/json": { schema: projectMilestoneSchema } },
      },
    },
  });

  const deleteProjectMilestoneRoute = createRoute({
    method: "delete",
    path: "/workspaces/{organizationId}/projects/{projectId}/milestones/{id}",
    tags: ["projects"],
    middleware: [rls("write")],
    request: {
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        id: z.string(),
      }),
    },
    responses: { 204: { description: "Project milestone deleted" } },
  });

  const getProjectUpdateReminderRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/projects/{projectId}/reminder",
    tags: ["projects"],
    middleware: [rls("read")],
    request: {
      params: z.object({ organizationId: z.string(), projectId: z.string() }),
    },
    responses: {
      200: {
        description: "Project update reminder",
        content: { "application/json": { schema: projectUpdateReminderSchema } },
      },
    },
  });

  const upsertProjectUpdateReminderRoute = createRoute({
    method: "put",
    path: "/workspaces/{organizationId}/projects/{projectId}/reminder",
    tags: ["projects"],
    middleware: [rls("write")],
    request: {
      params: z.object({ organizationId: z.string(), projectId: z.string() }),
      body: { content: { "application/json": { schema: projectUpdateReminderBodySchema } } },
    },
    responses: {
      200: {
        description: "Project update reminder set",
        content: { "application/json": { schema: projectUpdateReminderSchema } },
      },
    },
  });

  const deleteProjectUpdateReminderRoute = createRoute({
    method: "delete",
    path: "/workspaces/{organizationId}/projects/{projectId}/reminder",
    tags: ["projects"],
    middleware: [rls("write")],
    request: {
      params: z.object({ organizationId: z.string(), projectId: z.string() }),
    },
    responses: { 204: { description: "Project update reminder deleted" } },
  });

  const fireDueProjectUpdateRemindersRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/project-update-reminders/fire-due",
    tags: ["projects"],
    middleware: [rls("write")],
    request: {
      params: z.object({ organizationId: z.string() }),
    },
    responses: {
      200: {
        description: "Due reminders fired",
        content: {
          "application/json": {
            schema: z.object({ fired: z.number().int() }),
          },
        },
      },
    },
  });

  app.openapi(listProjectUpdatesRoute, async (c) => {
    const { organizationId, projectId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    assertProjectExists(await getProject(db, organizationId, projectId));
    const items = await listProjectUpdates(db, organizationId, projectId);
    return c.json({ updates: items });
  });

  app.openapi(createProjectUpdateRoute, async (c) => {
    const { organizationId, projectId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    assertProjectExists(await getProject(db, organizationId, projectId));
    const identity = c.var.workspaceIdentity;
    const item = await createProjectUpdate(db, organizationId, {
      ...input,
      projectId,
      createdById: identity.id,
    });
    return c.json(item, 201);
  });

  app.openapi(getProjectUpdateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getProjectUpdate(db, organizationId, id);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Project update not found",
      });
    }
    return c.json(item);
  });

  app.openapi(updateProjectUpdateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await updateProjectUpdate(db, organizationId, id, input);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Project update not found",
      });
    }
    return c.json(item);
  });

  app.openapi(deleteProjectUpdateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await deleteProjectUpdate(db, organizationId, id);
    return c.body(null, 204);
  });

  app.openapi(listProjectMilestonesRoute, async (c) => {
    const { organizationId, projectId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    assertProjectExists(await getProject(db, organizationId, projectId));
    const items = await listProjectMilestones(db, organizationId, projectId);
    return c.json({ milestones: items });
  });

  app.openapi(createProjectMilestoneRoute, async (c) => {
    const { organizationId, projectId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    assertProjectExists(await getProject(db, organizationId, projectId));
    const item = await createProjectMilestone(db, organizationId, { ...input, projectId });
    return c.json(item, 201);
  });

  app.openapi(getProjectMilestoneRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getProjectMilestone(db, organizationId, id);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Project milestone not found",
      });
    }
    return c.json(item);
  });

  app.openapi(updateProjectMilestoneRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await updateProjectMilestone(db, organizationId, id, input);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Project milestone not found",
      });
    }
    return c.json(item);
  });

  app.openapi(deleteProjectMilestoneRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await deleteProjectMilestone(db, organizationId, id);
    return c.body(null, 204);
  });

  app.openapi(getProjectUpdateReminderRoute, async (c) => {
    const { organizationId, projectId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getProjectUpdateReminder(db, organizationId, projectId);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Project update reminder not found",
      });
    }
    return c.json(item);
  });

  app.openapi(upsertProjectUpdateReminderRoute, async (c) => {
    const { organizationId, projectId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    assertProjectExists(await getProject(db, organizationId, projectId));
    const item = await upsertProjectUpdateReminder(db, organizationId, { ...input, projectId });
    return c.json(item);
  });

  app.openapi(deleteProjectUpdateReminderRoute, async (c) => {
    const { organizationId, projectId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await deleteProjectUpdateReminder(db, organizationId, projectId);
    return c.body(null, 204);
  });

  app.openapi(fireDueProjectUpdateRemindersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const identity = c.var.workspaceIdentity;
    const fired = await fireDueProjectUpdateReminders(db, organizationId, identity.id);
    return c.json({ fired });
  });
}
