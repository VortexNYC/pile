import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const preferencesSchema = z.object({
  organizationId: z.string(),
  userId: z.string(),
  defaultViewId: z.string().nullable(),
  updatedAt: z.string(),
});

const updateBodySchema = z.object({
  defaultViewId: z.string().nullable().optional(),
});

const getRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/view-preferences",
  tags: ["view-preferences"],
  middleware: [rls("read")],
  request: { params: z.object({ organizationId: z.string() }) },
  responses: {
    200: {
      description: "View preferences",
      content: { "application/json": { schema: preferencesSchema } },
    },
  },
});

const updateRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/view-preferences",
  tags: ["view-preferences"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: updateBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Preferences updated",
      content: { "application/json": { schema: preferencesSchema } },
    },
  },
});

export function registerViewPreferenceRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(getRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const row = await stub.getUserViewPreferences(identity.id);
    if (!row) {
      return c.json({
        organizationId,
        userId: identity.id,
        defaultViewId: null,
        updatedAt: new Date().toISOString(),
      });
    }
    return c.json(row);
  });

  app.openapi(updateRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const row = await stub.setDefaultView(
      identity.id,
      input.defaultViewId ?? null
    );
    return c.json(row!);
  });
}
