import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { emailInboxes } from "../global/schema.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const now = () => new Date().toISOString();

const emailInboxSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  address: z.string(),
  teamId: z.string().nullable(),
  projectId: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const emailInboxBodySchema = z.object({
  address: z.string().email(),
  teamId: z.string().optional(),
  projectId: z.string().optional(),
  enabled: z.boolean().default(true),
});

const listEmailInboxesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/email-inboxes",
  tags: ["email-inboxes"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Email inboxes list",
      content: {
        "application/json": {
          schema: z.object({ inboxes: z.array(emailInboxSchema) }),
        },
      },
    },
  },
});

const createEmailInboxRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/email-inboxes",
  tags: ["email-inboxes"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: emailInboxBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Email inbox created",
      content: { "application/json": { schema: emailInboxSchema } },
    },
  },
});

const deleteEmailInboxRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/email-inboxes/{id}",
  tags: ["email-inboxes"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: { 204: { description: "Email inbox deleted" } },
});

function toInboxResponse(row: typeof emailInboxes.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    address: row.address,
    teamId: row.teamId,
    projectId: row.projectId,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function registerEmailInboxRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listEmailInboxesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const rows = await db
      .select()
      .from(emailInboxes)
      .where(eq(emailInboxes.organizationId, organizationId))
      .all();
    return c.json({ inboxes: rows.map(toInboxResponse) });
  });

  app.openapi(createEmailInboxRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const id = crypto.randomUUID();
    const ts = now();
    await db.insert(emailInboxes).values({
      id,
      organizationId,
      address: input.address,
      teamId: input.teamId ?? null,
      projectId: input.projectId ?? null,
      enabled: input.enabled,
      createdAt: ts,
      updatedAt: ts,
    });
    const row = await db
      .select()
      .from(emailInboxes)
      .where(eq(emailInboxes.id, id))
      .get();
    return c.json(toInboxResponse(row!), 201);
  });

  app.openapi(deleteEmailInboxRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const row = await db
      .select()
      .from(emailInboxes)
      .where(
        and(
          eq(emailInboxes.id, id),
          eq(emailInboxes.organizationId, organizationId)
        )
      )
      .get();
    if (!row) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Email inbox not found",
      });
    }
    await db
      .delete(emailInboxes)
      .where(
        and(
          eq(emailInboxes.id, id),
          eq(emailInboxes.organizationId, organizationId)
        )
      );
    return c.body(null, 204);
  });
}
