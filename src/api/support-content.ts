import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createSupportAutoresponder,
  createSupportSnippet,
  listSupportAutoresponders,
  listSupportSnippets,
  type SupportAutoresponder,
  type SupportSnippet,
} from "../global/support-content.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const orgParam = z.object({ organizationId: z.string() });

const supportSnippetSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  textContent: z.string(),
  markdownContent: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const createSnippetBodySchema = z.object({
  name: z.string(),
  textContent: z.string(),
  markdownContent: z.string().optional(),
});

const supportAutoresponderSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  trigger: z.enum(["ticket_created", "customer_replied", "out_of_hours"]),
  order: z.number().int(),
  snippetId: z.string().nullable(),
  conditions: z.record(z.string(), z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const createAutoresponderBodySchema = z.object({
  name: z.string(),
  enabled: z.boolean().optional(),
  trigger: z.enum(["ticket_created", "customer_replied", "out_of_hours"]),
  order: z.number().int(),
  snippetId: z.string().optional(),
  conditions: z.record(z.string(), z.string()).optional(),
});

const createSnippetRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/snippets",
  tags: ["support-content"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: {
        "application/json": { schema: createSnippetBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Snippet created",
      content: {
        "application/json": {
          schema: z.object({ snippet: supportSnippetSchema }),
        },
      },
    },
  },
});

const listSnippetsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/snippets",
  tags: ["support-content"],
  middleware: [rls("read")],
  request: {
    params: orgParam,
  },
  responses: {
    200: {
      description: "Snippets list",
      content: {
        "application/json": {
          schema: z.object({ snippets: z.array(supportSnippetSchema) }),
        },
      },
    },
  },
});

const createAutoresponderRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/autoresponders",
  tags: ["support-content"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: {
        "application/json": { schema: createAutoresponderBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Autoresponder created",
      content: {
        "application/json": {
          schema: z.object({ autoresponder: supportAutoresponderSchema }),
        },
      },
    },
  },
});

const listAutorespondersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/autoresponders",
  tags: ["support-content"],
  middleware: [rls("read")],
  request: {
    params: orgParam,
  },
  responses: {
    200: {
      description: "Autoresponders list",
      content: {
        "application/json": {
          schema: z.object({
            autoresponders: z.array(supportAutoresponderSchema),
          }),
        },
      },
    },
  },
});

export function registerSupportContentRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(createSnippetRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);

    const snippet = await createSupportSnippet(db, {
      organizationId,
      name: body.name,
      textContent: body.textContent,
      markdownContent: body.markdownContent,
    });

    return c.json({ snippet } as { snippet: SupportSnippet }, 201);
  });

  app.openapi(listSnippetsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const snippets = await listSupportSnippets(db, organizationId);
    return c.json({ snippets } as { snippets: SupportSnippet[] });
  });

  app.openapi(createAutoresponderRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);

    const autoresponder = await createSupportAutoresponder(db, {
      organizationId,
      name: body.name,
      enabled: body.enabled,
      trigger: body.trigger,
      order: body.order,
      snippetId: body.snippetId,
      conditions: body.conditions,
    });

    return c.json(
      { autoresponder } as { autoresponder: SupportAutoresponder },
      201
    );
  });

  app.openapi(listAutorespondersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const autoresponders = await listSupportAutoresponders(db, organizationId);
    return c.json({ autoresponders } as {
      autoresponders: SupportAutoresponder[];
    });
  });
}
