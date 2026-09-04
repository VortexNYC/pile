import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createTemplate,
  getTemplate,
  listTemplates,
} from "../global/templates.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const templateSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  linearId: z.string(),
  name: z.string(),
  templateData: z.string().nullable(),
  createdAt: z.string(),
});

const templateBodySchema = z.object({
  linearId: z.string().min(1),
  name: z.string().min(1),
  templateData: z.string().optional(),
});

const listTemplatesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/templates",
  tags: ["templates"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Templates list",
      content: {
        "application/json": {
          schema: z.object({ templates: z.array(templateSchema) }),
        },
      },
    },
  },
});

const createTemplateRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/templates",
  tags: ["templates"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: templateBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Template created",
      content: {
        "application/json": { schema: templateSchema },
      },
    },
  },
});

const getTemplateRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/templates/{id}",
  tags: ["templates"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Template",
      content: {
        "application/json": { schema: templateSchema },
      },
    },
  },
});

export function registerTemplateRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listTemplatesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listTemplates(db, organizationId);
    return c.json({ templates: items });
  });

  app.openapi(createTemplateRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createTemplate(db, organizationId, input);
    return c.json(item, 201);
  });

  app.openapi(getTemplateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getTemplate(db, organizationId, id);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Template not found",
      });
    }
    return c.json(item);
  });
}
