import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { emojis } from "../global/schema.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const emojiSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  shortcut: z.string(),
  url: z.string(),
  createdAt: z.string(),
});

const bodySchema = z.object({
  name: z.string().min(1),
  shortcut: z.string().min(1),
  url: z.string().url(),
});

const listRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/emojis",
  tags: ["emojis"],
  middleware: [rls("read")],
  request: { params: z.object({ organizationId: z.string() }) },
  responses: {
    200: {
      description: "Emojis",
      content: {
        "application/json": {
          schema: z.object({ emojis: z.array(emojiSchema) }),
        },
      },
    },
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/emojis",
  tags: ["emojis"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: { content: { "application/json": { schema: bodySchema } } },
  },
  responses: {
    201: {
      description: "Emoji created",
      content: { "application/json": { schema: emojiSchema } },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/emojis/{id}",
  tags: ["emojis"],
  middleware: [rls("read")],
  request: { params: z.object({ organizationId: z.string(), id: z.string() }) },
  responses: {
    200: {
      description: "Emoji",
      content: { "application/json": { schema: emojiSchema } },
    },
    404: { description: "Emoji not found" },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/emojis/{id}",
  tags: ["emojis"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: { content: { "application/json": { schema: bodySchema.partial() } } },
  },
  responses: {
    200: {
      description: "Emoji updated",
      content: { "application/json": { schema: emojiSchema } },
    },
    404: { description: "Emoji not found" },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/emojis/{id}",
  tags: ["emojis"],
  middleware: [rls("write")],
  request: { params: z.object({ organizationId: z.string(), id: z.string() }) },
  responses: {
    204: { description: "Emoji deleted" },
    404: { description: "Emoji not found" },
  },
});

export function registerEmojiRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const rows = await db
      .select()
      .from(emojis)
      .where(eq(emojis.organizationId, organizationId))
      .all();
    return c.json({ emojis: rows });
  });

  app.openapi(createRouteDef, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const id = crypto.randomUUID();
    await db.insert(emojis).values({
      id,
      organizationId,
      name: input.name,
      shortcut: input.shortcut,
      url: input.url,
      createdAt: new Date().toISOString(),
    });
    const row = await db
      .select()
      .from(emojis)
      .where(and(eq(emojis.id, id), eq(emojis.organizationId, organizationId)))
      .get();
    return c.json(row!, 201);
  });

  app.openapi(getRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const row = await db
      .select()
      .from(emojis)
      .where(and(eq(emojis.id, id), eq(emojis.organizationId, organizationId)))
      .get();
    if (!row) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Emoji not found",
      });
    }
    return c.json(row);
  });

  app.openapi(updateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const existing = await db
      .select()
      .from(emojis)
      .where(and(eq(emojis.id, id), eq(emojis.organizationId, organizationId)))
      .get();
    if (!existing) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Emoji not found",
      });
    }
    await db
      .update(emojis)
      .set({
        name: input.name ?? existing.name,
        shortcut: input.shortcut ?? existing.shortcut,
        url: input.url ?? existing.url,
      })
      .where(and(eq(emojis.id, id), eq(emojis.organizationId, organizationId)));
    const row = await db
      .select()
      .from(emojis)
      .where(and(eq(emojis.id, id), eq(emojis.organizationId, organizationId)))
      .get();
    return c.json(row!);
  });

  app.openapi(deleteRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const existing = await db
      .select()
      .from(emojis)
      .where(and(eq(emojis.id, id), eq(emojis.organizationId, organizationId)))
      .get();
    if (!existing) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Emoji not found",
      });
    }
    await db
      .delete(emojis)
      .where(and(eq(emojis.id, id), eq(emojis.organizationId, organizationId)));
    return c.body(null, 204);
  });
}
