import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createCycle,
  createLabel,
  createMembership,
  createProject,
  deleteCycle,
  deleteLabel,
  deleteProject,
  getCycle,
  getLabel,
  getProject,
  listCycles,
  listLabels,
  listMemberships,
  listProjects,
  updateCycle,
  updateLabel,
  updateProject,
} from "../global/workspace-entities.js";
import { VortexError } from "../platform/errors.js";
import { rls } from "../platform/rls.js";
import type { AppContext } from "./middleware.js";

const projectSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const projectBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

const cycleSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string().nullable(),
  name: z.string(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const cycleBodySchema = z.object({
  projectId: z.string().optional(),
  name: z.string().min(1),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

const labelSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  createdAt: z.string(),
});

const labelBodySchema = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
});

const membershipSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  role: z.enum(["owner", "admin", "member"]),
  createdAt: z.string(),
});

const membershipBodySchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["owner", "admin", "member"]).optional(),
});

const listProjectsRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/projects",
  tags: ["projects"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string() }),
  },
  responses: {
    200: {
      description: "Projects list",
      content: {
        "application/json": {
          schema: z.object({ projects: z.array(projectSchema) }),
        },
      },
    },
  },
});

const createProjectRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/projects",
  tags: ["projects"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string() }),
    body: {
      content: {
        "application/json": { schema: projectBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Project created",
      content: {
        "application/json": { schema: projectSchema },
      },
    },
  },
});

const getProjectRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/projects/{id}",
  tags: ["projects"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Project",
      content: {
        "application/json": { schema: projectSchema },
      },
    },
  },
});

const updateProjectRoute = createRoute({
  method: "patch",
  path: "/workspaces/{workspaceId}/projects/{id}",
  tags: ["projects"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": { schema: projectBodySchema.partial() },
      },
    },
  },
  responses: {
    200: {
      description: "Project updated",
      content: {
        "application/json": { schema: projectSchema },
      },
    },
  },
});

const deleteProjectRoute = createRoute({
  method: "delete",
  path: "/workspaces/{workspaceId}/projects/{id}",
  tags: ["projects"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Project deleted" },
  },
});

const listCyclesRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/cycles",
  tags: ["cycles"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string() }),
  },
  responses: {
    200: {
      description: "Cycles list",
      content: {
        "application/json": {
          schema: z.object({ cycles: z.array(cycleSchema) }),
        },
      },
    },
  },
});

const createCycleRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/cycles",
  tags: ["cycles"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string() }),
    body: {
      content: {
        "application/json": { schema: cycleBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Cycle created",
      content: {
        "application/json": { schema: cycleSchema },
      },
    },
  },
});

const getCycleRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/cycles/{id}",
  tags: ["cycles"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Cycle",
      content: {
        "application/json": { schema: cycleSchema },
      },
    },
  },
});

const updateCycleRoute = createRoute({
  method: "patch",
  path: "/workspaces/{workspaceId}/cycles/{id}",
  tags: ["cycles"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": { schema: cycleBodySchema.partial() },
      },
    },
  },
  responses: {
    200: {
      description: "Cycle updated",
      content: {
        "application/json": { schema: cycleSchema },
      },
    },
  },
});

const deleteCycleRoute = createRoute({
  method: "delete",
  path: "/workspaces/{workspaceId}/cycles/{id}",
  tags: ["cycles"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Cycle deleted" },
  },
});

const listLabelsRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/labels",
  tags: ["labels"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string() }),
  },
  responses: {
    200: {
      description: "Labels list",
      content: {
        "application/json": {
          schema: z.object({ labels: z.array(labelSchema) }),
        },
      },
    },
  },
});

const createLabelRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/labels",
  tags: ["labels"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string() }),
    body: {
      content: {
        "application/json": { schema: labelBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Label created",
      content: {
        "application/json": { schema: labelSchema },
      },
    },
  },
});

const getLabelRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/labels/{id}",
  tags: ["labels"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Label",
      content: {
        "application/json": { schema: labelSchema },
      },
    },
  },
});

const updateLabelRoute = createRoute({
  method: "patch",
  path: "/workspaces/{workspaceId}/labels/{id}",
  tags: ["labels"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": { schema: labelBodySchema.partial() },
      },
    },
  },
  responses: {
    200: {
      description: "Label updated",
      content: {
        "application/json": { schema: labelSchema },
      },
    },
  },
});

const deleteLabelRoute = createRoute({
  method: "delete",
  path: "/workspaces/{workspaceId}/labels/{id}",
  tags: ["labels"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Label deleted" },
  },
});

const listMembershipsRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/memberships",
  tags: ["memberships"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string() }),
  },
  responses: {
    200: {
      description: "Memberships list",
      content: {
        "application/json": {
          schema: z.object({ memberships: z.array(membershipSchema) }),
        },
      },
    },
  },
});

const createMembershipRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/memberships",
  tags: ["memberships"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ workspaceId: z.string() }),
    body: {
      content: {
        "application/json": { schema: membershipBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Membership created",
      content: {
        "application/json": { schema: membershipSchema },
      },
    },
  },
});

export function registerWorkspaceEntityRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listProjectsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listProjects(db, workspaceId);
    return c.json({ projects: items });
  });

  app.openapi(createProjectRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createProject(db, workspaceId, input);
    return c.json(item, 201);
  });

  app.openapi(getProjectRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getProject(db, id);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Project not found",
      });
    }
    return c.json(item);
  });

  app.openapi(updateProjectRoute, async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await updateProject(db, id, input);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Project not found",
      });
    }
    return c.json(item);
  });

  app.openapi(deleteProjectRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await deleteProject(db, id);
    return c.body(null, 204);
  });

  app.openapi(listCyclesRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listCycles(db, workspaceId);
    return c.json({ cycles: items });
  });

  app.openapi(createCycleRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createCycle(db, workspaceId, input);
    return c.json(item, 201);
  });

  app.openapi(getCycleRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getCycle(db, id);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Cycle not found",
      });
    }
    return c.json(item);
  });

  app.openapi(updateCycleRoute, async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await updateCycle(db, id, input);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Cycle not found",
      });
    }
    return c.json(item);
  });

  app.openapi(deleteCycleRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await deleteCycle(db, id);
    return c.body(null, 204);
  });

  app.openapi(listLabelsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listLabels(db, workspaceId);
    return c.json({ labels: items });
  });

  app.openapi(createLabelRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createLabel(db, workspaceId, input);
    return c.json(item, 201);
  });

  app.openapi(getLabelRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getLabel(db, id);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Label not found",
      });
    }
    return c.json(item);
  });

  app.openapi(updateLabelRoute, async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await updateLabel(db, id, input);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Label not found",
      });
    }
    return c.json(item);
  });

  app.openapi(deleteLabelRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await deleteLabel(db, id);
    return c.body(null, 204);
  });

  app.openapi(listMembershipsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listMemberships(db, workspaceId);
    return c.json({ memberships: items });
  });

  app.openapi(createMembershipRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createMembership(
      db,
      workspaceId,
      input.userId,
      input.role
    );
    return c.json(item, 201);
  });
}
