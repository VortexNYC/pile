import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { createD1 } from "../global/db.js";
import { listTemplates } from "../global/templates.js";
import { rls } from "../platform/rls.js";
import type { AppContext } from "./middleware.js";

const templateSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  linearId: z.string(),
  name: z.string(),
  templateData: z.string().nullable(),
  createdAt: z.string(),
});

const listTemplatesRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/templates",
  tags: ["templates"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string() }),
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

export function registerTemplateRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listTemplatesRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listTemplates(db, workspaceId);
    return c.json({ templates: items });
  });
}
