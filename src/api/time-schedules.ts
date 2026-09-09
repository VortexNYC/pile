import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const timeScheduleSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  timeData: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const bodySchema = z.object({
  name: z.string().min(1),
  timeData: z.string().optional(),
});

const orgIdParam = z.object({ organizationId: z.string() });

const listRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/time-schedules",
  tags: ["time-schedules"],
  middleware: [rls("read")],
  request: { params: orgIdParam },
  responses: {
    200: {
      description: "Time schedules",
      content: {
        "application/json": {
          schema: z.object({ timeSchedules: z.array(timeScheduleSchema) }),
        },
      },
    },
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/time-schedules",
  tags: ["time-schedules"],
  middleware: [rls("write")],
  request: {
    params: orgIdParam,
    body: { content: { "application/json": { schema: bodySchema } } },
  },
  responses: {
    201: {
      description: "Time schedule created",
      content: { "application/json": { schema: timeScheduleSchema } },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/time-schedules/{id}",
  tags: ["time-schedules"],
  middleware: [rls("read")],
  request: { params: orgIdParam.merge(z.object({ id: z.string() })) },
  responses: {
    200: {
      description: "Time schedule",
      content: { "application/json": { schema: timeScheduleSchema } },
    },
    404: { description: "Time schedule not found" },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/time-schedules/{id}",
  tags: ["time-schedules"],
  middleware: [rls("write")],
  request: {
    params: orgIdParam.merge(z.object({ id: z.string() })),
    body: { content: { "application/json": { schema: bodySchema.partial() } } },
  },
  responses: {
    200: {
      description: "Time schedule updated",
      content: { "application/json": { schema: timeScheduleSchema } },
    },
    404: { description: "Time schedule not found" },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/time-schedules/{id}",
  tags: ["time-schedules"],
  middleware: [rls("write")],
  request: { params: orgIdParam.merge(z.object({ id: z.string() })) },
  responses: {
    204: { description: "Time schedule deleted" },
    404: { description: "Time schedule not found" },
  },
});

export function registerTimeScheduleRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ timeSchedules: await stub.listTimeSchedules() });
  });

  app.openapi(createRouteDef, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const ts = await stub.createTimeSchedule(input, identity.id);
    return c.json(ts!, 201);
  });

  app.openapi(getRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const ts = await stub.getTimeSchedule(id);
    if (!ts) throw new VortexError({ code: "NOT_FOUND", status: 404, message: "Time schedule not found" });
    return c.json(ts);
  });

  app.openapi(updateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const ts = await stub.updateTimeSchedule(id, input, identity.id);
    if (!ts) throw new VortexError({ code: "NOT_FOUND", status: 404, message: "Time schedule not found" });
    return c.json(ts);
  });

  app.openapi(deleteRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const ok = await stub.deleteTimeSchedule(id, identity.id);
    if (!ok) throw new VortexError({ code: "NOT_FOUND", status: 404, message: "Time schedule not found" });
    return c.body(null, 204);
  });
}
