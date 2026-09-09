import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, inArray } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { pushDeliveries, pushTokens } from "../global/schema.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
const now = () => new Date().toISOString();

const pushProviderSchema = z.enum(["fcm", "apns", "expo"]);

const pushTokenSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  name: z.string().nullable(),
  provider: pushProviderSchema,
  token: z.string(),
  createdAt: z.string(),
});

const pushTokenBodySchema = z.object({
  name: z.string().optional(),
  provider: pushProviderSchema.default("fcm"),
  token: z.string().min(1),
});

const pushDeliverySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  tokenId: z.string(),
  userId: z.string(),
  payload: z.string(),
  status: z.string(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const sendPushBodySchema = z.object({
  tokenId: z.string().optional(),
  userId: z.string().optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
});

const listPushTokensRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/push-tokens",
  tags: ["push"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Push tokens list",
      content: {
        "application/json": {
          schema: z.object({ tokens: z.array(pushTokenSchema) }),
        },
      },
    },
  },
});

const createPushTokenRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/push-tokens",
  tags: ["push"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: pushTokenBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Push token created",
      content: {
        "application/json": { schema: pushTokenSchema },
      },
    },
  },
});

const deletePushTokenRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/push-tokens/{id}",
  tags: ["push"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Push token deleted" },
  },
});

const sendPushRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/push/send",
  tags: ["push"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: sendPushBodySchema } },
    },
  },
  responses: {
    202: {
      description: "Push delivery accepted",
      content: {
        "application/json": {
          schema: z.object({ deliveries: z.array(pushDeliverySchema) }),
        },
      },
    },
  },
});

function toTokenResponse(row: typeof pushTokens.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    name: row.name,
    provider: row.provider,
    token: row.token,
    createdAt: row.createdAt,
  };
}

function toDeliveryResponse(row: typeof pushDeliveries.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    tokenId: row.tokenId,
    userId: row.userId,
    payload: row.payload,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function registerPushRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listPushTokensRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const rows = await db
      .select()
      .from(pushTokens)
      .where(
        and(
          eq(pushTokens.organizationId, organizationId),
          eq(pushTokens.userId, identity.id)
        )
      )
      .all();
    return c.json({ tokens: rows.map(toTokenResponse) });
  });

  app.openapi(createPushTokenRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const id = crypto.randomUUID();
    const ts = now();
    await db.insert(pushTokens).values({
      id,
      organizationId,
      userId: identity.id,
      name: input.name ?? null,
      provider: input.provider,
      token: input.token,
      createdAt: ts,
    });
    const row = await db
      .select()
      .from(pushTokens)
      .where(eq(pushTokens.id, id))
      .get();
    return c.json(toTokenResponse(row!), 201);
  });

  app.openapi(deletePushTokenRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    await db
      .delete(pushTokens)
      .where(
        and(
          eq(pushTokens.id, id),
          eq(pushTokens.organizationId, organizationId),
          eq(pushTokens.userId, identity.id)
        )
      );
    return c.body(null, 204);
  });

  app.openapi(sendPushRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);

    if (!input.tokenId && !input.userId) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Provide tokenId or userId",
      });
    }

    const targets = input.tokenId
      ? await db
          .select()
          .from(pushTokens)
          .where(
            and(
              eq(pushTokens.id, input.tokenId),
              eq(pushTokens.organizationId, organizationId)
            )
          )
          .all()
      : await db
          .select()
          .from(pushTokens)
          .where(
            and(
              eq(pushTokens.organizationId, organizationId),
              eq(pushTokens.userId, input.userId!)
            )
          )
          .all();

    if (targets.length === 0) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "No push tokens found",
      });
    }

    const payload = JSON.stringify({
      title: input.title,
      body: input.body,
      data: input.data,
    });
    const ts = now();
    const deliveryIds: string[] = [];
    await Promise.all(
      targets.map(async (token) => {
        const id = crypto.randomUUID();
        deliveryIds.push(id);
        await db.insert(pushDeliveries).values({
          id,
          organizationId,
          tokenId: token.id,
          userId: token.userId,
          payload,
          status: "pending",
          createdAt: ts,
          updatedAt: ts,
        });
      })
    );
    const deliveries =
      deliveryIds.length > 0
        ? await db
            .select()
            .from(pushDeliveries)
            .where(inArray(pushDeliveries.id, deliveryIds))
            .all()
        : [];

    return c.json({ deliveries: deliveries.map(toDeliveryResponse) }, 202);
  });
}
