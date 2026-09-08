import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { getVisibleTeamIds } from "../global/teams.js";
import {
  createCycle,
  createInitiative,
  createLabel,
  createMembership,
  createProject,
  createRoadmap,
  deleteCycle,
  deleteInitiative,
  deleteLabel,
  deleteProject,
  deleteRoadmap,
  getCycle,
  getInitiative,
  getLabel,
  getProject,
  getRoadmap,
  listCycles,
  listInitiatives,
  listLabels,
  listMemberships,
  listProjects,
  listRoadmaps,
  updateCycle,
  updateInitiative,
  updateLabel,
  updateProject,
  updateRoadmap,
} from "../global/workspace-entities.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const projectSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
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
  organizationId: z.string(),
  projectId: z.string().nullable(),
  name: z.string(),
  number: z.number().nullable(),
  status: z.enum(["upcoming", "active", "completed"]),
  autoRollover: z.boolean(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const cycleBodySchema = z.object({
  projectId: z.string().optional(),
  name: z.string().min(1),
  number: z.number().int().optional(),
  status: z.enum(["upcoming", "active", "completed"]).optional(),
  autoRollover: z.boolean().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

const labelSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
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
  organizationId: z.string(),
  userId: z.string(),
  role: z.enum(["owner", "admin", "member"]),
  createdAt: z.string(),
});

const membershipBodySchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["owner", "admin", "member"]).optional(),
});

const roadmapSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const roadmapBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const initiativeSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  roadmapId: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  startDate: z.string().nullable(),
  targetDate: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const initiativeBodySchema = z.object({
  roadmapId: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.string().optional(),
  startDate: z.string().optional(),
  targetDate: z.string().optional(),
});

const listProjectsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/projects",
  tags: ["projects"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
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
  path: "/workspaces/{organizationId}/projects",
  tags: ["projects"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
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
  path: "/workspaces/{organizationId}/projects/{id}",
  tags: ["projects"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
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
  path: "/workspaces/{organizationId}/projects/{id}",
  tags: ["projects"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
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
  path: "/workspaces/{organizationId}/projects/{id}",
  tags: ["projects"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Project deleted" },
  },
});

const listCyclesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/cycles",
  tags: ["cycles"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
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
  path: "/workspaces/{organizationId}/cycles",
  tags: ["cycles"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
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
  path: "/workspaces/{organizationId}/cycles/{id}",
  tags: ["cycles"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
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
  path: "/workspaces/{organizationId}/cycles/{id}",
  tags: ["cycles"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
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

const cycleCapacityRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/cycles/{id}/capacity",
  tags: ["cycles"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Cycle capacity: issue counts and estimate totals by status",
      content: {
        "application/json": {
          schema: z.object({
            issueCount: z.number(),
            estimateTotal: z.number(),
            byStatus: z.record(
              z.string(),
              z.object({ count: z.number(), estimateTotal: z.number() })
            ),
          }),
        },
      },
    },
    404: { description: "Cycle not found" },
  },
});

const rolloverCyclesRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/cycles/rollover",
  tags: ["cycles"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description:
        "Close ended cycles and roll unfinished issues into the next cycle",
      content: {
        "application/json": {
          schema: z.object({
            completedCycles: z.array(z.string()),
            activatedCycles: z.array(z.string()),
            rolledOver: z.number(),
          }),
        },
      },
    },
  },
});

const deleteCycleRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/cycles/{id}",
  tags: ["cycles"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Cycle deleted" },
  },
});

const listLabelsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/labels",
  tags: ["labels"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
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
  path: "/workspaces/{organizationId}/labels",
  tags: ["labels"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
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
  path: "/workspaces/{organizationId}/labels/{id}",
  tags: ["labels"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
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
  path: "/workspaces/{organizationId}/labels/{id}",
  tags: ["labels"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
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
  path: "/workspaces/{organizationId}/labels/{id}",
  tags: ["labels"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Label deleted" },
  },
});

const listMembershipsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/memberships",
  tags: ["memberships"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
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
  path: "/workspaces/{organizationId}/memberships",
  tags: ["memberships"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
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

const listRoadmapsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/roadmaps",
  tags: ["roadmaps"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Roadmaps list",
      content: {
        "application/json": {
          schema: z.object({ roadmaps: z.array(roadmapSchema) }),
        },
      },
    },
  },
});

const createRoadmapRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/roadmaps",
  tags: ["roadmaps"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: roadmapBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Roadmap created",
      content: {
        "application/json": { schema: roadmapSchema },
      },
    },
  },
});

const getRoadmapRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/roadmaps/{id}",
  tags: ["roadmaps"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Roadmap",
      content: {
        "application/json": { schema: roadmapSchema },
      },
    },
  },
});

const updateRoadmapRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/roadmaps/{id}",
  tags: ["roadmaps"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": { schema: roadmapBodySchema.partial() },
      },
    },
  },
  responses: {
    200: {
      description: "Roadmap updated",
      content: {
        "application/json": { schema: roadmapSchema },
      },
    },
  },
});

const deleteRoadmapRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/roadmaps/{id}",
  tags: ["roadmaps"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Roadmap deleted" },
  },
});

const listInitiativesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/initiatives",
  tags: ["initiatives"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      roadmapId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Initiatives list",
      content: {
        "application/json": {
          schema: z.object({ initiatives: z.array(initiativeSchema) }),
        },
      },
    },
  },
});

const listRoadmapInitiativesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/roadmaps/{id}/initiatives",
  tags: ["roadmaps"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Initiatives in roadmap",
      content: {
        "application/json": {
          schema: z.object({ initiatives: z.array(initiativeSchema) }),
        },
      },
    },
  },
});

const createInitiativeRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/initiatives",
  tags: ["initiatives"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: initiativeBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Initiative created",
      content: {
        "application/json": { schema: initiativeSchema },
      },
    },
  },
});

const getInitiativeRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/initiatives/{id}",
  tags: ["initiatives"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Initiative",
      content: {
        "application/json": { schema: initiativeSchema },
      },
    },
  },
});

const updateInitiativeRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/initiatives/{id}",
  tags: ["initiatives"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": { schema: initiativeBodySchema.partial() },
      },
    },
  },
  responses: {
    200: {
      description: "Initiative updated",
      content: {
        "application/json": { schema: initiativeSchema },
      },
    },
  },
});

const deleteInitiativeRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/initiatives/{id}",
  tags: ["initiatives"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Initiative deleted" },
  },
});

export function registerWorkspaceEntityRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listProjectsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listProjects(db, organizationId);
    return c.json({ projects: items });
  });

  app.openapi(createProjectRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createProject(db, organizationId, input);
    return c.json(item, 201);
  });

  app.openapi(getProjectRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getProject(db, organizationId, id);
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
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await updateProject(db, organizationId, id, input);
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
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await deleteProject(db, organizationId, id);
    return c.body(null, 204);
  });

  app.openapi(listCyclesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listCycles(db, organizationId);
    return c.json({ cycles: items });
  });

  app.openapi(createCycleRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createCycle(db, organizationId, input);
    return c.json(item, 201);
  });

  app.openapi(getCycleRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getCycle(db, organizationId, id);
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
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await updateCycle(db, organizationId, id, input);
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
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await deleteCycle(db, organizationId, id);
    return c.body(null, 204);
  });

  app.openapi(cycleCapacityRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const cycle = await getCycle(db, organizationId, id);
    if (!cycle) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Cycle not found",
      });
    }
    const identity = c.var.workspaceIdentity;
    const teamIds = await getVisibleTeamIds(db, organizationId, identity);
    const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(
      c.env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const capacity = await stub.cycleCapacity(id, teamIds);
    return c.json(capacity);
  });

  app.openapi(rolloverCyclesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(
      c.env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const result = await stub.rolloverCycles();
    return c.json(result);
  });

  app.openapi(listLabelsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listLabels(db, organizationId);
    return c.json({ labels: items });
  });

  app.openapi(createLabelRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createLabel(db, organizationId, input);
    return c.json(item, 201);
  });

  app.openapi(getLabelRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getLabel(db, organizationId, id);
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
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await updateLabel(db, organizationId, id, input);
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
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await deleteLabel(db, organizationId, id);
    return c.body(null, 204);
  });

  app.openapi(listMembershipsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listMemberships(db, organizationId);
    return c.json({ memberships: items });
  });

  app.openapi(createMembershipRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createMembership(
      db,
      organizationId,
      input.userId,
      input.role
    );
    return c.json(item, 201);
  });

  app.openapi(listRoadmapsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listRoadmaps(db, organizationId);
    return c.json({ roadmaps: items });
  });

  app.openapi(createRoadmapRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createRoadmap(db, organizationId, input);
    return c.json(item, 201);
  });

  app.openapi(getRoadmapRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getRoadmap(db, organizationId, id);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Roadmap not found",
      });
    }
    return c.json(item);
  });

  app.openapi(updateRoadmapRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await updateRoadmap(db, organizationId, id, input);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Roadmap not found",
      });
    }
    return c.json(item);
  });

  app.openapi(deleteRoadmapRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await deleteRoadmap(db, organizationId, id);
    return c.body(null, 204);
  });

  app.openapi(listInitiativesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { roadmapId } = c.req.valid("query");
    const db = createD1(c.env.D1);
    const items = await listInitiatives(db, organizationId, roadmapId);
    return c.json({ initiatives: items });
  });

  app.openapi(listRoadmapInitiativesRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listInitiatives(db, organizationId, id);
    return c.json({ initiatives: items });
  });

  app.openapi(createInitiativeRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createInitiative(db, organizationId, input);
    return c.json(item, 201);
  });

  app.openapi(getInitiativeRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getInitiative(db, organizationId, id);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Initiative not found",
      });
    }
    return c.json(item);
  });

  app.openapi(updateInitiativeRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await updateInitiative(db, organizationId, id, input);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Initiative not found",
      });
    }
    return c.json(item);
  });

  app.openapi(deleteInitiativeRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await deleteInitiative(db, organizationId, id);
    return c.body(null, 204);
  });
}
