import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createSupportLabel,
  listSupportLabels,
  type SupportLabel,
} from "../global/labels.js";
import {
  createSupportAutoresponder,
  createSupportSnippet,
  getSupportSnippet,
  listSupportAutoresponders,
  listSupportSnippets,
  patchSupportAutoresponder,
  patchSupportSnippet,
  type SupportAutoresponder,
  type SupportSnippet,
} from "../global/support-content.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const orgParam = z.object({ organizationId: z.string() });

const snippetParams = z.object({
  organizationId: z.string(),
  snippetId: z.string(),
});

const autoresponderParams = z.object({
  organizationId: z.string(),
  autoresponderId: z.string(),
});

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

const patchSnippetBodySchema = z.object({
  name: z.string().optional(),
  textContent: z.string().optional(),
  markdownContent: z.string().nullish(),
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

const patchAutoresponderBodySchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  trigger: z
    .enum(["ticket_created", "customer_replied", "out_of_hours"])
    .optional(),
  order: z.number().int().optional(),
  snippetId: z.string().nullish(),
  conditions: z.record(z.string(), z.string()).optional(),
});

const supportLabelSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  kind: z.enum(["issue", "support"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const createLabelBodySchema = z.object({
  name: z.string(),
  color: z.string().optional(),
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

const getSnippetRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/snippets/{snippetId}",
  tags: ["support-content"],
  middleware: [rls("read")],
  request: {
    params: snippetParams,
  },
  responses: {
    200: {
      description: "Snippet details",
      content: {
        "application/json": {
          schema: z.object({ snippet: supportSnippetSchema }),
        },
      },
    },
  },
});

const patchSnippetRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/support/snippets/{snippetId}",
  tags: ["support-content"],
  middleware: [rls("write")],
  request: {
    params: snippetParams,
    body: {
      content: {
        "application/json": { schema: patchSnippetBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Snippet updated",
      content: {
        "application/json": {
          schema: z.object({ snippet: supportSnippetSchema }),
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

const patchAutoresponderRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/support/autoresponders/{autoresponderId}",
  tags: ["support-content"],
  middleware: [rls("write")],
  request: {
    params: autoresponderParams,
    body: {
      content: {
        "application/json": { schema: patchAutoresponderBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Autoresponder updated",
      content: {
        "application/json": {
          schema: z.object({ autoresponder: supportAutoresponderSchema }),
        },
      },
    },
  },
});

const createLabelRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/labels",
  tags: ["support-content"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: {
        "application/json": { schema: createLabelBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Support label created",
      content: {
        "application/json": {
          schema: z.object({ label: supportLabelSchema }),
        },
      },
    },
  },
});

const listLabelsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/labels",
  tags: ["support-content"],
  middleware: [rls("read")],
  request: {
    params: orgParam,
  },
  responses: {
    200: {
      description: "Support labels list",
      content: {
        "application/json": {
          schema: z.object({ labels: z.array(supportLabelSchema) }),
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

  app.openapi(getSnippetRoute, async (c) => {
    const { organizationId, snippetId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const snippet = await getSupportSnippet(db, organizationId, snippetId);
    return c.json({ snippet } as { snippet: SupportSnippet });
  });

  app.openapi(patchSnippetRoute, async (c) => {
    const { organizationId, snippetId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);

    const snippet = await patchSupportSnippet(db, organizationId, snippetId, {
      name: body.name,
      textContent: body.textContent,
      markdownContent: body.markdownContent,
    });

    return c.json({ snippet } as { snippet: SupportSnippet });
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

  app.openapi(patchAutoresponderRoute, async (c) => {
    const { organizationId, autoresponderId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);

    const autoresponder = await patchSupportAutoresponder(
      db,
      organizationId,
      autoresponderId,
      {
        name: body.name,
        enabled: body.enabled,
        trigger: body.trigger,
        order: body.order,
        snippetId: body.snippetId,
        conditions: body.conditions,
      }
    );

    return c.json({ autoresponder } as { autoresponder: SupportAutoresponder });
  });

  app.openapi(createLabelRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);

    const label = await createSupportLabel(db, {
      organizationId,
      name: body.name,
      color: body.color,
    });

    return c.json({ label } as { label: SupportLabel }, 201);
  });

  app.openapi(listLabelsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const labels = await listSupportLabels(db, organizationId);
    return c.json({ labels } as { labels: SupportLabel[] });
  });
}
